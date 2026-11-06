export type PresenceValue = string | number | boolean | null;
export type PresenceData = Readonly<Record<string, PresenceValue>>;
export interface PresenceMessage {
  userId: string;
  sessionId: string;
  sequence: number;
  issuedAt: number;
  data: PresenceData;
}
export interface PresenceEntry extends PresenceMessage {
  expiresAt: number;
}
export interface PresenceOptions {
  ttlMs?: number;
  maxSessions?: number;
  futureToleranceMs?: number;
  clock?: () => number;
}
export type ReceiveResult = { accepted: true } | { accepted: false; reason: 'expired' | 'stale' };
export interface PresenceGroup {
  userId: string;
  sessions: PresenceEntry[];
}
export interface PresenceRegistry {
  receive(message: PresenceMessage): ReceiveResult;
  snapshot(): PresenceEntry[];
  users(): PresenceGroup[];
  expire(): string[];
  remove(sessionId: string): boolean;
}
export interface PublisherOptions {
  userId: string;
  sessionId: string;
  intervalMs?: number;
  heartbeatMs?: number;
  clock?: () => number;
}
export interface PresencePublisher {
  update(data: PresenceData): void;
  next(): PresenceMessage | undefined;
}
function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}.`);
  return value;
}
function identity(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    throw new TypeError('Identity must be a nonempty string up to 128 UTF-16 units.');
}
function clockFunction(clock: () => number): () => number {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  let previous = -Infinity;
  return () => {
    const now = clock();
    if (!Number.isFinite(now)) throw new TypeError('clock must return finite milliseconds.');
    previous = Math.max(previous, now);
    return previous;
  };
}
function dataSnapshot(data: PresenceData): PresenceData {
  if (
    data === null ||
    typeof data !== 'object' ||
    (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)
  )
    throw new TypeError('Presence data must be a plain flat object.');
  const keys = Reflect.ownKeys(data);
  if (keys.length > 32) throw new RangeError('Presence data exceeds 32 fields.');
  const entries: [string, PresenceValue][] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 128)
      throw new TypeError('Data keys must be strings up to 128 units.');
    const descriptor = Object.getOwnPropertyDescriptor(data, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw new TypeError('Data fields must be enumerable data properties.');
    const value: unknown = descriptor.value;
    if (typeof value === 'string') {
      if (value.length > 1024) throw new RangeError('Presence strings exceed 1024 UTF-16 units.');
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Presence numbers must be finite.');
    } else if (value !== null && typeof value !== 'boolean')
      throw new TypeError('Data values must be finite primitives.');
    entries.push([key, value]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze(Object.fromEntries(entries));
}
function messageSnapshot(message: PresenceMessage): PresenceMessage {
  identity(message.userId);
  identity(message.sessionId);
  integer(message.sequence, 'sequence');
  if (!Number.isFinite(message.issuedAt))
    throw new TypeError('issuedAt must be finite milliseconds.');
  return {
    userId: message.userId,
    sessionId: message.sessionId,
    sequence: message.sequence,
    issuedAt: message.issuedAt,
    data: dataSnapshot(message.data),
  };
}
function entrySnapshot(value: PresenceEntry): PresenceEntry {
  return { ...value, data: { ...value.data } };
}
export function createPresence(options: PresenceOptions = {}): PresenceRegistry {
  const ttl = integer(options.ttlMs ?? 30_000, 'ttlMs', 1);
  const maximum = integer(options.maxSessions ?? 1000, 'maxSessions', 1);
  const tolerance = integer(options.futureToleranceMs ?? 1000, 'futureToleranceMs');
  const now = clockFunction(options.clock ?? Date.now);
  const sessions = new Map<string, PresenceEntry>();
  const expireAt = (time: number) => {
    const removed: string[] = [];
    for (const [id, value] of sessions) {
      if (time >= value.expiresAt) {
        sessions.delete(id);
        removed.push(id);
      }
    }
    return removed;
  };
  const snapshotAt = (time: number) => {
    expireAt(time);
    return [...sessions.values()]
      .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))
      .map(entrySnapshot);
  };
  return {
    receive(input) {
      const message = messageSnapshot(input);
      const time = now();
      if (message.issuedAt - time > tolerance)
        throw new RangeError('Message is too far in the future.');
      const expiresAt = Math.min(message.issuedAt, time) + ttl;
      if (!Number.isFinite(expiresAt)) throw new RangeError('Presence expiry overflow.');
      expireAt(time);
      if (time >= expiresAt) return { accepted: false, reason: 'expired' };
      const existing = sessions.get(message.sessionId);
      if (existing) {
        if (existing.userId !== message.userId)
          throw new TypeError('Session ownership cannot change.');
        if (message.sequence <= existing.sequence || message.issuedAt < existing.issuedAt)
          return { accepted: false, reason: 'stale' };
      } else if (sessions.size === maximum) throw new RangeError('Presence exceeds maxSessions.');
      sessions.set(message.sessionId, { ...message, expiresAt });
      return { accepted: true };
    },
    snapshot() {
      return snapshotAt(now());
    },
    users() {
      const groups = new Map<string, PresenceEntry[]>();
      for (const session of snapshotAt(now())) {
        const group = groups.get(session.userId);
        if (group) group.push(session);
        else groups.set(session.userId, [session]);
      }
      return [...groups]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([userId, entries]) => ({ userId, sessions: entries }));
    },
    expire() {
      return expireAt(now());
    },
    remove(sessionId) {
      identity(sessionId);
      return sessions.delete(sessionId);
    },
  };
}
export function createPublisher(options: PublisherOptions): PresencePublisher {
  identity(options.userId);
  identity(options.sessionId);
  const userId = options.userId,
    sessionId = options.sessionId;
  const interval = integer(options.intervalMs ?? 100, 'intervalMs');
  const heartbeat = integer(options.heartbeatMs ?? 10_000, 'heartbeatMs', 1);
  if (heartbeat < interval) throw new RangeError('heartbeatMs must be >= intervalMs.');
  const now = clockFunction(options.clock ?? Date.now);
  let pending: PresenceData = Object.freeze({});
  let fingerprint = JSON.stringify(pending);
  let published = '';
  let sentAt = -Infinity;
  let sequence = 0;
  return {
    update(data) {
      const snapshot = dataSnapshot(data);
      const encoded = JSON.stringify(snapshot);
      pending = snapshot;
      fingerprint = encoded;
    },
    next() {
      const time = now();
      const elapsed = time - sentAt;
      if (elapsed < interval || (fingerprint === published && elapsed < heartbeat))
        return undefined;
      if (sequence === Number.MAX_SAFE_INTEGER)
        throw new RangeError('Sequence exhausted; create a new session.');
      sentAt = time;
      published = fingerprint;
      return { userId, sessionId, sequence: sequence++, issuedAt: time, data: { ...pending } };
    },
  };
}
