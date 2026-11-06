import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPresence, createPublisher } from '../dist/esm/index.js';

const message = (sequence = 0, issuedAt = 0, sessionId = 's1', userId = 'u1', data = {}) => ({
  userId,
  sessionId,
  sequence,
  issuedAt,
  data,
});
test('sessions expire at the exact boundary using explicit clock samples', () => {
  let time = 0;
  const presence = createPresence({ clock: () => time, ttlMs: 100 });
  assert.deepEqual(presence.receive(message()), { accepted: true });
  time = 99;
  assert.equal(presence.snapshot().length, 1);
  time = 100;
  assert.deepEqual(presence.expire(), ['s1']);
  assert.deepEqual(presence.snapshot(), []);
});
test('heartbeats extend lifetime while duplicate and reordered messages are explicit no-ops', () => {
  let time = 0;
  const presence = createPresence({ clock: () => time, ttlMs: 100 });
  presence.receive(message(0, 0));
  time = 50;
  presence.receive(message(2, 50));
  assert.deepEqual(presence.receive(message(1, 40)), { accepted: false, reason: 'stale' });
  assert.deepEqual(presence.receive(message(2, 50)), { accepted: false, reason: 'stale' });
  assert.deepEqual(presence.receive(message(3, 49)), { accepted: false, reason: 'stale' });
  time = 100;
  assert.equal(presence.snapshot().length, 1);
  time = 150;
  assert.equal(presence.snapshot().length, 0);
});
test('expired transmissions cannot revive sessions and future clock skew is bounded', () => {
  const presence = createPresence({ clock: () => 100, ttlMs: 20, futureToleranceMs: 5 });
  assert.deepEqual(presence.receive(message(0, 80)), { accepted: false, reason: 'expired' });
  assert.throws(() => presence.receive(message(0, 106)), /future/);
  presence.receive(message(0, 105));
  assert.equal(presence.snapshot()[0].expiresAt, 120);
});
test('users aggregate multiple sessions and snapshots are deterministic and independent', () => {
  const presence = createPresence({ clock: () => 0 });
  const data = { x: 1 };
  presence.receive(message(0, 0, 'b', 'user', data));
  presence.receive(message(0, 0, 'a', 'user'));
  presence.receive(message(0, 0, 'c', 'another'));
  data.x = 999;
  const snapshot = presence.snapshot();
  assert.deepEqual(
    snapshot.map((row) => row.sessionId),
    ['a', 'b', 'c'],
  );
  assert.equal(snapshot[1].data.x, 1);
  snapshot[1].data.x = 99;
  assert.equal(presence.snapshot()[1].data.x, 1);
  assert.deepEqual(
    presence.users().map((row) => [row.userId, row.sessions.length]),
    [
      ['another', 1],
      ['user', 2],
    ],
  );
});
test('session ownership cannot change while active; reconnect identities use new sessions', () => {
  const presence = createPresence({ clock: () => 0 });
  presence.receive(message());
  assert.throws(() => presence.receive(message(1, 0, 's1', 'other')), /ownership/);
  presence.receive(message(0, 0, 's2', 'u1'));
  assert.equal(presence.users()[0].sessions.length, 2);
  assert.equal(presence.remove('s1'), true);
  assert.equal(presence.remove('s1'), false);
});
test('capacity errors do not evict live sessions and expired entries free capacity', () => {
  let time = 0;
  const presence = createPresence({ clock: () => time, maxSessions: 1, ttlMs: 10 });
  presence.receive(message());
  assert.throws(() => presence.receive(message(0, 0, 's2')), /maxSessions/);
  assert.equal(presence.snapshot()[0].sessionId, 's1');
  time = 10;
  presence.receive(message(0, 10, 's2'));
  assert.equal(presence.snapshot()[0].sessionId, 's2');
});
test('backward clocks do not reverse expiry time', () => {
  let time = 100;
  const presence = createPresence({ clock: () => time, ttlMs: 10 });
  presence.receive(message(0, 100));
  time = 50;
  assert.equal(presence.snapshot().length, 1);
  time = 110;
  assert.equal(presence.snapshot().length, 0);
});
test('publisher emits immediately, coalesces updates and heartbeats unchanged data', () => {
  let time = 0;
  const publisher = createPublisher({
    userId: 'u',
    sessionId: 's',
    clock: () => time,
    intervalMs: 10,
    heartbeatMs: 50,
  });
  assert.equal(publisher.next().sequence, 0);
  publisher.update({ x: 1 });
  publisher.update({ x: 2 });
  time = 9;
  assert.equal(publisher.next(), undefined);
  time = 10;
  const change = publisher.next();
  assert.equal(change.sequence, 1);
  assert.equal(change.data.x, 2);
  time = 59;
  assert.equal(publisher.next(), undefined);
  time = 60;
  assert.equal(publisher.next().sequence, 2);
});
test('publisher equality ignores key order and input/output mutations', () => {
  let time = 0;
  const publisher = createPublisher({ userId: 'u', sessionId: 's', clock: () => time });
  const data = { b: 2, a: 1 };
  publisher.update(data);
  const first = publisher.next();
  data.a = 99;
  first.data.a = 88;
  publisher.update({ a: 1, b: 2 });
  time = 100;
  assert.equal(publisher.next(), undefined);
  time = 10000;
  assert.equal(publisher.next().data.a, 1);
});
test('prototype-like field names remain ordinary data and invalid payloads invoke no getters', () => {
  const presence = createPresence({ clock: () => 0 });
  presence.receive(message(0, 0, 's1', 'u1', JSON.parse('{"__proto__":"ok"}')));
  assert.equal(presence.snapshot()[0].data.__proto__, 'ok');
  let accessed = false;
  const data = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      accessed = true;
      return 1;
    },
  });
  assert.throws(() => presence.receive(message(1, 0, 's1', 'u1', data)), /data properties/);
  assert.equal(accessed, false);
});
test('malformed messages, payload limits and invalid clocks fail explicitly', () => {
  const presence = createPresence({ clock: () => 0 });
  for (const invalid of [
    message(-1),
    message(1.5),
    message(0, NaN),
    message(0, 0, ''),
    message(0, 0, 's', 'u', { value: undefined }),
    message(0, 0, 's', 'u', { value: Infinity }),
    message(0, 0, 's', 'u', { value: [] }),
    message(0, 0, 's', 'u', { value: 'x'.repeat(1025) }),
  ]) {
    assert.throws(() => presence.receive(invalid));
  }
  assert.equal(presence.snapshot().length, 0);
  assert.throws(() => createPresence({ ttlMs: 0 }), RangeError);
  assert.throws(() => createPresence({ clock: () => NaN }).snapshot(), /finite/);
  assert.throws(
    () => createPublisher({ userId: 'u', sessionId: 's', intervalMs: 10, heartbeatMs: 9 }),
    RangeError,
  );
});
test('publisher messages interoperate with registry over repeated heartbeat cycles', () => {
  let time = 0;
  const publisher = createPublisher({
    userId: 'u',
    sessionId: 's',
    clock: () => time,
    intervalMs: 0,
    heartbeatMs: 5,
  });
  const presence = createPresence({ clock: () => time, ttlMs: 10 });
  for (time = 0; time <= 100; time += 5) {
    const packet = publisher.next();
    assert.deepEqual(presence.receive(packet), { accepted: true });
    assert.equal(presence.snapshot().length, 1);
  }
  time = 110;
  assert.equal(presence.snapshot().length, 0);
});
test('CommonJS creates sessions without starting timers or requiring browser APIs', () => {
  const require = createRequire(import.meta.url);
  const api = require('../dist/cjs/index.js');
  const presence = api.createPresence({ clock: () => 0 });
  presence.receive(message());
  assert.equal(presence.snapshot()[0].userId, 'u1');
});
