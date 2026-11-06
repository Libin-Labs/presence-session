import {
  createPresence,
  createPublisher,
  type PresenceMessage,
  type PresenceGroup,
} from '@lp-labs/presence-session';
const publisher = createPublisher({ userId: 'u', sessionId: 's' });
publisher.update({ cursorX: 1, online: true });
const message: PresenceMessage | undefined = publisher.next();
const registry = createPresence();
if (message) {
  const result = registry.receive(message);
  if (!result.accepted) {
    const reason: 'expired' | 'stale' = result.reason;
    void reason;
  }
}
const users: PresenceGroup[] = registry.users();
// @ts-expect-error payloads intentionally have no nested values.
publisher.update({ nested: { x: 1 } });
void users;
