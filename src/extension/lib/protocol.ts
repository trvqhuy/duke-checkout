export type RequestType =
  | 'bootstrap.get' | 'settings.get' | 'settings.put'
  | 'profile.get' | 'profile.put' | 'profile.import' | 'cards.list'
  | 'card.session.put' | 'card.session.get' | 'card.session.clear'
  | 'inspect.start' | 'arm.start' | 'arm.clear' | 'arm.get'
  | 'run.start' | 'run.list' | 'run.cancel' | 'run.resolve';

export interface DukeRequest { id: string; type: RequestType; payload: unknown }
export interface DukeError { code: string; message: string; fields?: Record<string, string> }
export interface DukeResponse { id: string; ok: boolean; result?: unknown; error?: DukeError }
export type DukeEventType = 'run.update' | 'arm.update' | 'notice';
export interface DukeEvent { type: DukeEventType; payload: unknown }

const REQUEST_TYPES: RequestType[] = ['bootstrap.get', 'settings.get', 'settings.put', 'profile.get', 'profile.put', 'profile.import', 'cards.list', 'card.session.put', 'card.session.get', 'card.session.clear', 'inspect.start', 'arm.start', 'arm.clear', 'arm.get', 'run.start', 'run.list', 'run.cancel', 'run.resolve'];

export function encodeRequest(request: DukeRequest): unknown { return request; }
export function decodeRequest(value: unknown): DukeRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !REQUEST_TYPES.includes(v.type as RequestType)) return null;
  return { id: v.id, type: v.type as RequestType, payload: 'payload' in v ? v.payload : null };
}
export function encodeResponse(response: DukeResponse): unknown { return response; }
export function decodeResponse(value: unknown): DukeResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.ok !== 'boolean') return null;
  return v as unknown as DukeResponse;
}
export function isEvent(value: unknown): value is DukeEvent {
  return typeof value === 'object' && value !== null && ['run.update', 'arm.update', 'notice'].includes((value as DukeEvent).type);
}
