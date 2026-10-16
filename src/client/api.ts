import type { Bootstrap } from '../shared/types.ts';

let token = '';
export class RequestError extends Error {
  constructor(message: string, public code: string, public fields: Record<string, string> = {}) { super(message); }
}

export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { ...(method !== 'GET' ? { 'x-local-token': token } : {}), ...(value !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  } catch { throw new RequestError('The local server could not be reached. Keep npm run dev running and reload this page.', 'LOCAL_CONNECTION'); }
  let body;
  try { body = await response.json(); } catch { throw new RequestError('The local server returned an unreadable response. Reload this workspace.', 'LOCAL_RESPONSE'); }
  if (!response.ok) throw new RequestError(body.error?.message ?? 'This operation could not finish.', body.error?.code ?? 'REQUEST', body.error?.fields ?? {});
  return body as T;
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await api<Bootstrap>('/bootstrap');
  token = result.csrfToken;
  return result;
}
