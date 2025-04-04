import 'dotenv/config';
import { Elysia, redirect, t } from 'elysia';

const isDev = process.env.NODE_ENV === 'development';
const endpointSuffix = isDev ? '-training' : '';
const GROWPATH_BASE_URL = `https://nguyen${endpointSuffix}.growpath.com/api/v2`;
const SELF_BASE_URL = 'https://growpath-zoom-webhook.hqnlawfirm.com';

const GROWPATH = {
	PHONE_LOGS: `${GROWPATH_BASE_URL}/phone_logs`,
	TELEPHONY: `${GROWPATH_BASE_URL}/telephony_events`,
	PHONES: `${GROWPATH_BASE_URL}/phones`,
	MATTERS: `${GROWPATH_BASE_URL}/matters`,
	MATTER_TYPES: `${GROWPATH_BASE_URL}/matter_types`,
	USER_PROFILES: `${GROWPATH_BASE_URL}/user_profiles`,
	PERSON_ENTITIES: `${GROWPATH_BASE_URL}/entities/person`
};

const EVENT = {
	URL_VALIDATION: 'endpoint.url_validation',
	CALL_RINGING: 'phone.caller_ringing', // when the caller hears the ringback tone
	CALL_ANSWERED: 'phone.callee_answered', // when the call is answered
	CALL_ENDED: ['phone.caller_ended', 'phone.callee_ended'], // call is ended by the caller or callee
	CALL_MISSED: 'phone.callee_missed', // call is missed
	CALL_REJECTED: 'phone.callee_rejected', // call is rejected by the callee
	RECORDING_READY: 'phone.recording_completed', // when the call recording becomes available for download
	SMS_SENT: 'phone.sms_sent',
	SMS_RECEIVED: 'phone.sms_received'
};

let cache = {} as any;
let loggedMessages = {};

const app = new Elysia();

app.post(
	'/webhook',
	async ({ body, headers, set }) => {
		try {
			const message = `v0:${headers['x-zm-request-timestamp']}:${JSON.stringify(body)}`;
			const hashForVerify = sha256Hash(message);
			const signature = `v0=${hashForVerify}`;

			console.log('Event received:', body.event);

			if (headers['x-zm-signature'] !== signature) {
				set.status = 401;
				return 'Unauthorized!';
			}

			const payload = body.payload as any;
			set.status = 200;

			if (body.event === EVENT.URL_VALIDATION) {
				const hashForValidate = sha256Hash(payload?.plainToken);

				return {
					plainToken: payload?.plainToken,
					encryptedToken: hashForValidate
				};
			}

			if (body.event === EVENT.CALL_RINGING) {
				const from_number = payload?.object?.caller?.phone_number?.slice(-10);
				const to_number = payload?.object?.callee?.phone_number?.slice(-10);

				const { matter_id, involvee_id, paralegal } = await getMatterByPhone(to_number);
				const matter_type = await getMatterType(matter_id);
				// const staff_id = await getUserIdByName(paralegal);
				const staff_id = await Entities.findStaffIdByPhoneNumber(from_number);

				const response = await sendRequest(GROWPATH.TELEPHONY, 'POST', {
					telephony_event: {
						from_number,
						to_number,
						start_time: formatTimestamp(payload?.object?.ringing_start_time),
						ongoing: true,
						status: 'VendorStart',
						involvee_id,
						staff_id,
						matter_type
					}
				});

				const callId = payload?.object?.call_id;
				if (response?.id) addToCache(callId, { telephonyEventId: response.id });
			} else if (
				[...EVENT.CALL_ENDED, EVENT.CALL_MISSED, EVENT.CALL_REJECTED].includes(body.event)
			) {
				console.log('payload.object', payload?.object);
				const fromNumber = payload?.object?.caller?.phone_number?.slice(-10);
				const toNumber = payload?.object?.callee?.phone_number?.slice(-10);
				const answerStartTime = payload?.object?.answer_start_time;
				const callEndTime = payload?.object?.call_end_time;
				const duration = getCallDuration(answerStartTime, callEndTime);

				const { matter_id, involvee_id, paralegal } = await getMatterByPhone(toNumber);
				// const staff_id = await getUserIdByName(paralegal);
				const staff_id = await Entities.findStaffIdByPhoneNumber(fromNumber);

				const phoneLogResponse = await sendRequest(GROWPATH.PHONE_LOGS, 'POST', {
					telephony_records: {
						type: 'Call',
						raw_from_number: fromNumber,
						raw_to_number: toNumber,
						start_time: formatTimestamp(payload?.object?.ringing_start_time),
						end_time: formatTimestamp(callEndTime),
						duration,
						involvee_id,
						staff_id,
						matter_id
					}
				});

				const callId = payload?.object?.call_id;
				if (phoneLogResponse?.id) addToCache(callId, { phoneLogId: phoneLogResponse.id });

				const data = cache[callId];
				if (!data?.telephonyEventId) return;

				await sendRequest(`${GROWPATH.TELEPHONY}/${data.telephonyEventId}`, 'PUT', {
					telephony_event: {
						end_time: formatTimestamp(callEndTime),
						ongoing: false,
						status: 'VendorFinish'
					}
				});
			} else if (body.event === EVENT.RECORDING_READY) {
				const recording = payload?.object?.recordings?.[0];
				const { call_id, download_url, duration } = recording || {};
				const recording_url = getRecordingUrl(download_url);

				// const callId = recording?.call_id;
				// const recording_url = recording?.download_url;
				// const duration = recording?.duration;

				const { telephonyEventId, phoneLogId } = cache[call_id] || {};

				console.log('recording_url', recording_url, duration, JSON.stringify(cache[call_id]));

				if (telephonyEventId) {
					await sendRequest(`${GROWPATH.TELEPHONY}/${telephonyEventId}`, 'PUT', {
						telephony_event: {
							recording_url
						}
					});
				}

				if (phoneLogId) {
					await sendRequest(`${GROWPATH.PHONE_LOGS}/${phoneLogId}`, 'PUT', {
						telephony_records: {
							type: 'Call',
							recording_url,
							duration
						}
					});
				}

				if (call_id) delete cache[call_id];
			} else if ([EVENT.SMS_SENT, EVENT.SMS_RECEIVED].includes(body.event)) {
				const msgId = payload?.object?.message_id;

				const fromNumber = payload?.object?.sender?.phone_number?.slice(-10);
				const toNumber = payload?.object?.to_members?.[0]?.phone_number?.slice(-10);
				const message = payload?.object?.message;
				const createdAt = formatTimestamp(payload?.object?.date_time);
				const attachments = (payload?.object?.attachments || []).reduce(
					(acc: any, item: any) => {
						if (item?.download_url) acc[item.download_url] = item?.name;
						return acc;
					},
					{}
				);

				const { matter_id, involvee_id, paralegal } = await getMatterByPhone(toNumber);
				// const staff_id = await getUserIdByName(paralegal);
				const staff_id = await Entities.findStaffIdByPhoneNumber(fromNumber);

				await sendRequest(GROWPATH.PHONE_LOGS, 'POST', {
					telephony_records: {
						type: 'SMS',
						raw_from_number: fromNumber,
						raw_to_number: toNumber,
						text_message: message,
						involvee_id,
						staff_id,
						matter_id,
						created_at: createdAt,
						media_params: attachments
					}
				});
			}
		} catch (error) {
			console.log('Error:', error);
		}
	},
	{
		body: t.Object(
			{
				event: t.String(),
				payload: t.Object(
					{ plainToken: t.Optional(t.String()) },
					{ additionalProperties: true }
				)
			},
			{ additionalProperties: true }
		)
	}
)
	.get('/recording/:id', async ({ params, set }) => {
		try {
			const id = params.id;
			if (!id) {
				set.status = 400;
				return 'Bad request!';
			}

			const accessToken = await ZoomAccessToken.getAccessToken();
			const response = await fetch(`https://api.zoom.us/v2/phone/recording/download/${id}`, {
				method: 'GET',
				headers: { Authorization: `Bearer ${accessToken}` },
				redirect: 'manual'
			});

			const downloadUrl = response.headers.get('location');
			if (!downloadUrl) throw 'File not found';

			set.status = 302;
			set.headers['Location'] = downloadUrl;
		} catch (error) {
			set.status = 500;
			return error;
		}
	})
	.get('/ping', () => 'API is running')
	.listen(process.env.PORT || 3000);

console.log(`🦊 Server is running at ${app.server?.hostname}:${app.server?.port}`);

async function sendRequest(
	url: string,
	method: 'GET' | 'POST' | 'PUT',
	body?: Record<string, any>
) {
	const response = await fetch(encodeURI(url), {
		method,
		headers: {
			Authorization: `Bearer ${process.env.GROWPATH_AUTH_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: body && JSON.stringify(body)
	});

	const data = await response.json();
	console.log(method, url, body && JSON.stringify(body));
	console.log('Response', data);
	console.log('\n');
	return data;
}

async function getMatterByPhone(phoneNumber: string) {
	const mattersListUrl = `${GROWPATH.MATTERS}?filters={"claimant_phone":"${phoneNumber}"}`;
	const mattersResponse = await sendRequest(mattersListUrl, 'GET');

	const matter = (mattersResponse?.matters || []).sort(
		(a: any, b: any) => +new Date(b.updated_at) - +new Date(a.updated_at)
	)?.[0];

	console.log(
		'getMatterByPhone',
		JSON.stringify({
			matter_id: matter?.id,
			involvee_id: matter?.claimant_id,
			paralegal: matter?.paralegal
		})
	);
	return { matter_id: matter?.id, involvee_id: matter?.claimant_id, paralegal: matter?.paralegal };
}

async function getMatterType(matterId: number) {
	if (!matterId) return '';

	const matterGetUrl = `${GROWPATH.MATTERS}/${matterId}`;
	const matterResponse = await sendRequest(matterGetUrl, 'GET');
	const case_type_id = matterResponse?.matter?.case_type_id;

	if (!case_type_id) return '';
	const matterTypesListUrl = `${GROWPATH.MATTER_TYPES}?filters={"id":[${case_type_id}]}`;
	const matterTypesResponse = await sendRequest(matterTypesListUrl, 'GET');
	const matterType = (matterTypesResponse?.matter_types || []).find(
		(m: any) => m.id === case_type_id
	);

	return matterType?.name || '';
}

// async function getUserIdByName(name: string) {
// 	if (!name) return null;

// 	const userProfilesListUrl = `${GROWPATH.USER_PROFILES}?filters={"anything_like_with_person":"${name}"}`;
// 	const response = await sendRequest(userProfilesListUrl, 'GET');

// 	const user = (response?.user_profiles || []).find((u: any) => u.display_name === name);
// 	return user?.id || null;
// }

function addToCache(callId: string, value: Record<string, any>) {
	if (callId) {
		if (!cache[callId]) cache[callId] = {};
		cache[callId] = { ...cache[callId], ...value };
	}

	console.log('addToCache', callId, JSON.stringify(cache[callId]));
}

function getCallDuration(answerStartTime: string, callEndTime: string) {
	if (!answerStartTime) return 0;
	return Math.round((+new Date(callEndTime) - +new Date(answerStartTime)) / 1000);
}

function getRecordingUrl(url?: string) {
	if (!url) return '';
	const id = url.split('/').pop();
	return `${SELF_BASE_URL}/recording/${id}`;
}

function sha256Hash(message: string) {
	const hasher = new Bun.CryptoHasher('sha256', process.env.ZOOM_SECRET_TOKEN);
	return hasher.update(message).digest('hex');
}

function formatTimestamp(ts?: string) {
	if (!ts) return '';
	const date = new Date(ts);
	const pad = (n: number) => n.toString().padStart(2, '0');

	let hours = date.getHours();
	const ampm = hours >= 12 ? 'PM' : 'AM';
	hours = hours % 12 || 12;

	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(hours)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${ampm}`
	);
}

class ZoomAccessToken {
	static token = null;
	static expireTime = new Date();

	static async getAccessToken() {
		if (this.expireTime <= new Date()) {
			await this.refreshToken();
		}
		return this.token;
	}

	static async refreshToken() {
		const env = process.env;
		const tokenUrl = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${env.ZOOM_ACCOUNT_ID}`;
		const creds = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString(
			'base64'
		);

		const res = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${creds}`,
				'Content-Type': 'application/x-www-form-urlencoded'
			}
		});

		const data = await res.json();
		this.token = data.access_token;
		this.expireTime = new Date(Date.now() + 3500 * 1000);
	}
}

ZoomAccessToken.refreshToken().catch(console.log);

class Entities {
	static activeStaff = [];
	static activeStaffLastRefreshed = new Date();

	static async findStaffIdByPhoneNumber(phoneNum: string) {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		if (this.activeStaffLastRefreshed.getTime() <= fiveMinutesAgo) {
			await this.refreshActiveStaff();
		}

		const staff = this.activeStaff.find((s: any) => {
			const phone = (s?.phone_numbers_data || []).find((ph: any) => ph?.number === phoneNum);
			return !!phone;
		}) as any;

		return staff?.id;
	}

	static async refreshActiveStaff() {
		const response = await sendRequest(
			`${GROWPATH.PERSON_ENTITIES}//search?filters={"active_staff": true}&per_page=1000`,
			'GET'
		);

		if (response.people) {
			this.activeStaff = response.people;
			this.activeStaffLastRefreshed = new Date();
		}
	}
}

Entities.refreshActiveStaff().catch(console.log);
