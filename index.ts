import 'dotenv/config';
import { Elysia, t } from 'elysia';

const isDev = process.env.NODE_ENV === 'development';
const endpointSuffix = isDev ? '-training' : '';
const GROWPATH_TELEPHONY_URL = `https://nguyen${endpointSuffix}.growpath.com/api/v2/telephony_events`;

let telephonyEventIds = {} as any;

const app = new Elysia();

app.post(
	'/webhook',
	async ({ body, headers, set }) => {
		try {
			const message = `v0:${headers['x-zm-request-timestamp']}:${JSON.stringify(body)}`;
			const hasher = new Bun.CryptoHasher('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN);
			const hashForVerify = hasher.update(message).digest('hex');
			const signature = `v0=${hashForVerify}`;

			if (headers['x-zm-signature'] === signature) {
				const payload = body.payload as any;

				if (body.event === 'endpoint.url_validation') {
					const hasher = new Bun.CryptoHasher('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN);
					const hashForValidate = hasher.update(payload?.plainToken).digest('hex');

					set.status = 200;
					return {
						plainToken: payload?.plainToken,
						encryptedToken: hashForValidate
					};
				}

				// phone.callee_answered​
				// phone.caller_connected​

				if (body.event === 'phone.callee_answered') {
					const response = await sendRequest(GROWPATH_TELEPHONY_URL, 'POST', {
						telephony_event: {
							from_number: payload?.object?.caller?.phone_number,
							to_number: payload?.object?.callee?.phone_number,
							start_time: payload?.object?.answer_start_time,
							ongoing: true,
							status: 'VendorStart'
							// "involvee_id": 854301,
							// staff_id: 975,
							// recording_url: 'url_TEST',
							// matter_type: 'Testing'
						}
					});

					const callId = payload?.object?.call_id;
					// telephonyEventIds[callId] =
				} else if (['phone.caller_ended', 'phone.callee_ended'].includes(body.event)) {
					const callId = payload?.object?.call_id;
					const eventId = telephonyEventIds[callId];

					if (eventId) {
						await sendRequest(`${GROWPATH_TELEPHONY_URL}/${eventId}`, 'PUT', {
							telephony_event: {
								end_time: payload?.object?.call_end_time,
								ongoing: false,
								status: 'VendorFinish'
							}
						});
					}
				} else if (body.event === 'phone.recording_completed') {
					const callId = payload?.object?.call_id;
					const eventId = telephonyEventIds[callId];

					if (eventId) {
						delete telephonyEventIds[callId];

						await sendRequest(`${GROWPATH_TELEPHONY_URL}/${eventId}`, 'PUT', {
							telephony_event: {
								recording_url: payload?.object?.recordings?.[0]?.download_url
							}
						});
					}
				}
			}
		} catch (error) {
			console.error(error);
		}
	},
	{
		body: t.Object({
			event: t.String(),
			payload: t.Object({}, { additionalProperties: true })
		})
	}
);

async function sendRequest(url: string, method: 'POST' | 'PUT', body: Record<string, any>) {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.GROWPATH_AUTH_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	const data = await response.json();
	return data;
}
