# @lp-labs/presence-session

Deterministic, process-local presence tracking with expiring sessions, heartbeat ordering, multiple sessions per user and coalesced publisher messages.

- Zero runtime or peer dependencies; framework-independent.
- ESM, CommonJS and TypeScript declarations.
- Injected clocks, bounded session/payload sizes and independent snapshots.
- No timers, sockets, global listeners, storage or browser globals at import.

## Installation

```sh
npm install @lp-labs/presence-session
```

Requires Node.js 18+ or a modern browser with an ESM-aware bundler.

## Quickstart

```js
import { createPresence, createPublisher } from '@lp-labs/presence-session';

let time = 0;
const presence = createPresence({ clock: () => time, ttlMs: 100 });
const publisher = createPublisher({
  userId: 'ada',
  sessionId: 'connection-1',
  clock: () => time,
  intervalMs: 10,
  heartbeatMs: 30,
});
publisher.update({ page: 'canvas', x: 25, y: 40 });
const packet = publisher.next();
if (packet) presence.receive(packet);
console.log(presence.users()[0].sessions[0].data.x); // 25
time = 100;
console.log(presence.expire()); // ['connection-1']
```

CommonJS: `const { createPresence } = require('@lp-labs/presence-session')`.

## Trust and clock contract

This package is a presence **state machine**, not a collaboration server or authentication protocol. Messages are not signed, authenticated or persisted. Session ownership checks only compare active in-memory entries; they cannot establish identity.

Bind authenticated transport identity to `userId` and authorize `sessionId` before receiving packets. Use unguessable/new session identities for distinct connections and reconnect generations. Never let a browser choose another user's authenticated identity merely by sending these fields.

`issuedAt` and the registry clock must share a meaningful millisecond clock basis. A trusted server can stamp authenticated incoming heartbeat times and fan them out, or applications can use a documented clock synchronization/skew policy. Do not assume unrelated device clocks agree. Delayed packets older than TTL are rejected; excessive future skew throws.

Expired/removed sessions do not retain tombstones or old sequence numbers. Reusing the same session ID with a fresh timestamp can restart ordering. This package alone does not provide durable replay prevention, distributed ownership, reconnect authentication or consensus.

## API

Runtime exports: `createPresence`, `createPublisher`.

Type exports: `PresenceValue`, `PresenceData`, `PresenceMessage`, `PresenceEntry`, `PresenceOptions`, `ReceiveResult`, `PresenceGroup`, `PresenceRegistry`, `PublisherOptions`, `PresencePublisher`.

### Message and payload

```ts
interface PresenceMessage {
  userId: string;
  sessionId: string;
  sequence: number;
  issuedAt: number;
  data: Readonly<Record<string, string | number | boolean | null>>;
}
```

- User/session IDs are nonempty strings of at most 128 UTF-16 units.
- Sequence is a non-negative safe integer; it must strictly increase within an active session.
- Timestamp is finite milliseconds. Presence data is a plain flat object, at most 32 fields.
- Keys are at most 128 UTF-16 units; string values at most 1024 units; numeric values must be finite.
- Nested objects/arrays, undefined, functions, symbols, getters and nonenumerable fields are rejected.
- Metadata is copied. Prototype-like names are ordinary own data fields. Input getters for data properties are rejected without invocation; hostile proxies/message-envelope getters are not a supported isolation boundary.

Use flat `{ x, y, page, color, status }` data rather than broadcasting document content or private profile data. Payload quotas count fields/units, not transport bytes.

### createPresence(options?)

| Option | Default | Meaning |
|---|---|---|
| `ttlMs` | `30000` | Positive safe integer session lifetime. |
| `maxSessions` | `1000` | Positive safe integer active-entry capacity. |
| `futureToleranceMs` | `1000` | Allowed future timestamp skew, non-negative safe integer. |
| `clock` | `Date.now` | Function returning finite milliseconds. Backward samples are clamped. |

Methods:

| Method | Behavior |
|---|---|
| `receive(message)` | Validate/snapshot a message, expire old entries, then insert/update the session. |
| `snapshot()` | Expire entries and return fresh session snapshots sorted lexically by session ID. |
| `users()` | Expire entries and return `{ userId, sessions }[]`, sorted by user ID and then session ID. |
| `expire()` | Remove entries at/beyond expiry and return their session IDs in current insertion order. |
| `remove(sessionId)` | Explicitly remove one session; returns whether it existed. |

Accepted packets return `{ accepted: true }`. Expected stale/expired packets return `{ accepted: false, reason: 'stale' | 'expired' }`; these are explicit protocol outcomes, not swallowed operational errors.

Expiry is `min(issuedAt, currentTime) + ttlMs`. Allowed future skew therefore cannot extend TTL beyond a full lifetime from receipt. Expiry is inclusive (`currentTime >= expiresAt`). A packet already expired by its issue time is rejected, even if just received.

For active sessions, another `userId` throws `TypeError`. A sequence no greater than the stored one, or an issue timestamp earlier than the stored one, is stale and does not refresh expiry. Capacity overflow throws `RangeError` rather than evicting live users. Expired entries are pruned before checking capacity.

The registry stores one latest snapshot per session, not a history. One user may have several tabs/devices; closing one session should not remove all that user's sessions.

### createPublisher(options)

| Option | Default | Meaning |
|---|---|---|
| `userId`, `sessionId` | required | Stable identities for this connection generation. |
| `intervalMs` | `100` | Minimum time between publications, non-negative safe integer. |
| `heartbeatMs` | `10000` | Maximum unchanged-data publication interval, positive safe integer and at least `intervalMs`. |
| `clock` | `Date.now` | Finite millisecond clock with backward clamping. |

`update(data)` validates/copies the latest payload and coalesces pending changes; it does not send anything.

`next()` returns either a new `PresenceMessage` or `undefined` when publication is not due. The first call publishes immediately, even before an update (with empty data). Later calls publish changed data after the minimum interval or unchanged data at the heartbeat interval. Sequence starts at zero and increments only when a packet is returned; exhaustion throws so a new session can be created.

Payload equality uses sorted-key JSON encoding, ignoring field insertion order. This also treats numeric negative zero and zero as equal. Latest state wins: several updates between calls produce one packet. No queues, diffs or reliable-message retries are maintained.

`next()` marks the packet published when returned, **not when delivered**. Choose heartbeat below TTL, call `next` often enough and handle transport failures in your application. There are no acknowledgments, durability or delivery guarantees. `heartbeatMs` equal to TTL risks expiry from ordinary network delay; leave a margin.

## Integrating transport and UI

Keep scheduling and authorization outside the core:

1. Create a publisher per authenticated connection generation.
2. On cursor/selection/status changes, call `update`.
3. On your animation frame or bounded timer, call `next` and send returned packets.
4. Validate/authenticate at the server boundary, then call registry `receive`.
5. Render `snapshot`/`users` and run `expire` periodically if immediate UI removal is required.
6. Remove explicitly on a trusted disconnect notification; TTL remains the fallback for lost connections.

The package starts no timers. If you never call a registry method again, no observable expiry notification runs. There are no subscriptions or change events: compare snapshots or use your own application state/update loop.

Cancellation, transport bandwidth, backpressure and server fanout are your adapter's responsibilities. Coalescing reduces message rate but does not compress data or guarantee a particular byte budget.

## Errors and performance

Malformed payloads/identities/clock values throw `TypeError`; capacities, intervals, skew, expiry overflow and sequence exhaustion throw `RangeError`. Invalid messages do not overwrite existing session data. Expiry pruning may still occur during a receive attempt that later fails capacity/ownership checks.

Expiry pruning is O(active sessions) per registry read/receive; snapshots additionally sort O(N log N). This is intended for bounded room-local registries, not a global presence database with millions of sessions. Publisher state is O(payload size).

This independently authored initial release does not claim distributed convergence, delivery reliability or compatibility with another collaboration library.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
