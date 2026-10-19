import type {
  DeviceEndorse, DeviceKeyRegister, DeviceKeyRegistered, MailboxPeek, MailboxResponse, MessageContacts, MessageIdentity, MessageKeysResponse, MessageResponse,
  MessageSend, MessageSendV2, MessageSent, MessageStateChange,
} from '@distill/shared';
import { request, type ApiOptions } from './api.ts';

/** The agent-message routes (arch v3.0 24.11; first cut T0, 24.15). */

export const messageIdentityApi = (o: ApiOptions): Promise<MessageIdentity> =>
  request(o, '/api/v1/messages/identity', { method: 'GET' });

export const registerDeviceApi = (o: ApiOptions, body: DeviceKeyRegister): Promise<DeviceKeyRegistered> =>
  request(o, '/api/v1/devices/keys', { method: 'POST', body: JSON.stringify(body), attempts: 1 });

export const endorseDeviceApi = (o: ApiOptions, deviceId: string, body: DeviceEndorse): Promise<{ device_id: string; approved: boolean; changed: boolean }> =>
  request(o, `/api/v1/devices/keys/${encodeURIComponent(deviceId)}/endorse`, { method: 'POST', body: JSON.stringify(body), attempts: 1 });

export const messageKeysApi = (o: ApiOptions, handle: string): Promise<MessageKeysResponse> =>
  request(o, `/api/v1/keys/${encodeURIComponent(handle)}`, { method: 'GET' });

/** Not retried by request(): a send is idempotent by client_msg_id, so the caller retries knowingly. */
export const sendMessageApi = (o: ApiOptions, body: MessageSend | MessageSendV2): Promise<MessageSent> =>
  request(o, '/api/v1/messages', { method: 'POST', body: JSON.stringify(body) });

export function mailboxApi(o: ApiOptions, q: { box: 'in' | 'out'; agent?: string; states?: string[]; before?: string; limit?: number; thread?: string }): Promise<MailboxResponse> {
  const p = new URLSearchParams({ box: q.box });
  if (q.agent) p.set('agent', q.agent);
  if (q.states?.length) p.set('state', q.states.join(','));
  if (q.before) p.set('before', q.before);
  if (q.limit) p.set('limit', String(q.limit));
  if (q.thread) p.set('thread', q.thread);
  return request(o, `/api/v1/messages?${p}`, { method: 'GET' });
}

export const getMessageApi = (o: ApiOptions, id: string): Promise<MessageResponse> =>
  request(o, `/api/v1/messages/${encodeURIComponent(id)}`, { method: 'GET' });

export const setMessageStateApi = (o: ApiOptions, id: string, body: MessageStateChange): Promise<{ message_id: string; state: string; changed: boolean }> =>
  request(o, `/api/v1/messages/${encodeURIComponent(id)}/state`, { method: 'POST', body: JSON.stringify(body), attempts: 1 });

export const peekApi = (o: ApiOptions, signal?: AbortSignal): Promise<MailboxPeek> =>
  request(o, '/api/v1/messages/peek', { method: 'GET', attempts: 1, ...(signal ? { signal } : {}) });

/** Contacts and organisation members (migration 20261031001000): read only -- adding someone is the web's (24.3 rule 1). */
export const contactsApi = (o: ApiOptions): Promise<MessageContacts> =>
  request(o, '/api/v1/messages/contacts', { method: 'GET' });
