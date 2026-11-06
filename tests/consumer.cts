import { createPublisher, createPresence, type PresenceEntry } from '@lp-labs/presence-session';
const registry = createPresence();
const message = createPublisher({ userId: 'u', sessionId: 's' }).next();
if (message) registry.receive(message);
const sessions: PresenceEntry[] = registry.snapshot();
void sessions;
