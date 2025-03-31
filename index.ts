import 'dotenv/config';
import { Elysia, t } from 'elysia';

const ZOOM_WEBHOOK_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN as string;
const isDev = process.env.NODE_ENV === 'development';
const endpointSuffix = isDev ? '-training' : '';
const GROWPATH_BASE_URL = `https://nguyen${endpointSuffix}.growpath.com/api/v2`;

const GROWPATH = {
	PHONE_LOGS: `${GROWPATH_BASE_URL}/phone_logs`,
	TELEPHONY: `${GROWPATH_BASE_URL}/telephony_events`,
	PHONES: `${GROWPATH_BASE_URL}/phones`,
	MATTERS: `${GROWPATH_BASE_URL}/matters`,
	MATTER_TYPES: `${GROWPATH_BASE_URL}/matter_types`,
	USER_PROFILES: `${GROWPATH_BASE_URL}/user_profiles`
};

const EVENT = {
	URL_VALIDATION: 'endpoint.url_validation',
	CALL_RINGING: 'phone.caller_ringing', // when the caller hears the ringback tone
	CALL_ANSWERED: 'phone.callee_answered', // when the call is answered
	CALL_ENDED: ['phone.caller_ended', 'phone.callee_ended'], // call is ended by the caller or callee
	CALL_MISSED: 'phone.callee_missed', // call is missed
	CALL_REJECTED: 'phone.callee_rejected', // call is rejected by the callee
	RECORDING_READY: 'phone.recording_completed' // when the call recording becomes available for download
};

let cache = {} as any;

const app = new Elysia();

app.post(
	'/webhook',
	async ({ body, headers, set }) => {
		try {
			const message = `v0:${headers['x-zm-request-timestamp']}:${JSON.stringify(body)}`;
			const hasher = new Bun.CryptoHasher('sha256', ZOOM_WEBHOOK_SECRET_TOKEN);
			const hashForVerify = hasher.update(message).digest('hex');
			const signature = `v0=${hashForVerify}`;

			console.log('Event received:', body.event);

			if (headers['x-zm-signature'] !== signature) {
				set.status = 401;
				return 'Unauthorized!';
			}

			const payload = body.payload as any;
			set.status = 200;

			if (body.event === EVENT.URL_VALIDATION) {
				const hasher = new Bun.CryptoHasher('sha256', ZOOM_WEBHOOK_SECRET_TOKEN);
				const hashForValidate = hasher.update(payload?.plainToken).digest('hex');

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
				const staff_id = await getUserIdByName(paralegal);

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
				const staff_id = await getUserIdByName(paralegal);

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
				const callId = payload?.object?.call_id;
				const recording = payload?.object?.recordings?.[0];
				const recording_url = recording?.download_url;
				const duration = recording?.duration;

				const { telephonyEventId, phoneLogId } = cache[callId] || {};

				console.log('recording_url', recording_url, duration);

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
							recording_url,
							duration
						}
					});
				}

				if (callId) delete cache[callId];
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

async function getUserIdByName(name: string) {
	if (!name) return null;

	const userProfilesListUrl = `${GROWPATH.USER_PROFILES}?filters={"anything_like_with_person":"${name}"}`;
	const response = await sendRequest(userProfilesListUrl, 'GET');

	const user = (response?.user_profiles || []).find((u: any) => u.display_name === name);
	return user?.id || null;
}

function addToCache(callId: string, value: Record<string, any>) {
	if (callId) {
		if (!cache[callId]) cache[callId] = {};
		cache[callId] = { ...cache[callId], ...value };
	}

	console.log('addToCache', JSON.stringify(cache[callId]));
}

function getCallDuration(answerStartTime: string, callEndTime: string) {
	if (!answerStartTime) return 0;
	return Math.round((+new Date(callEndTime) - +new Date(answerStartTime)) / 1000);
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
