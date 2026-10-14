import { describe, it, expect } from 'vitest';
import type { MessageEnvelope } from '@ontofelia/core';
import { TelegramAdapter } from '../telegram/TelegramAdapter.js';
import type { PairingStore } from '../pairing/PairingStore.js';
import type { AllowlistStore } from '../pairing/AllowlistStore.js';

// Drives the adapter's real inbound handler (no bot, no network).

const OWNER = '1000001';
const FRIEND = '2000002';

async function makeAdapter(config: Record<string, unknown>, allowed: string[]) {
  const pairing = { createRequest: async () => ({ code: 'X' }) } as unknown as PairingStore;
  const allowlist = { isAllowed: async (_c: string, id: string) => allowed.includes(id) } as unknown as AllowlistStore;
  const adapter = new TelegramAdapter(pairing, allowlist);
  await adapter.initialize(config as never);
  const seen: MessageEnvelope[] = [];
  adapter.onMessage(async (e) => { seen.push(e); });
  return { adapter, seen };
}

const dm = (fromId: number, text = 'hello') => ({
  message_id: 7, date: 1_700_000_000, text,
  chat: { id: fromId, type: 'private' },
  from: { id: fromId, first_name: 'Someone', username: `u${fromId}` },
}) as never;

describe('TelegramAdapter owner identity', () => {
  it('owner id set: the owner is "owner" with owner rights', async () => {
    const { adapter, seen } = await makeAdapter({ ownerId: OWNER }, [OWNER, FRIEND]);
    await adapter.handleMessage(dm(Number(OWNER)));
    expect(seen).toHaveLength(1);
    expect(seen[0].sender.id).toBe('owner');
    expect(seen[0].sender.isOwner).toBe(true);
  });

  it('owner id set: another approved user gets their own id and no owner rights', async () => {
    const { adapter, seen } = await makeAdapter({ ownerId: OWNER }, [OWNER, FRIEND]);
    await adapter.handleMessage(dm(Number(FRIEND)));
    expect(seen).toHaveLength(1);
    expect(seen[0].sender.id).toBe(`telegram:${FRIEND}`);
    expect(seen[0].sender.isOwner).toBe(false);
  });

  it('a numeric owner id from JSON5 works the same', async () => {
    const { adapter, seen } = await makeAdapter({ ownerId: Number(OWNER) }, [OWNER, FRIEND]);
    await adapter.handleMessage(dm(Number(OWNER)));
    await adapter.handleMessage(dm(Number(FRIEND)));
    expect(seen.map((e) => e.sender.isOwner)).toEqual([true, false]);
  });

  it('legacy mode (no owner id): everybody approved is the owner, as before', async () => {
    const { adapter, seen } = await makeAdapter({}, [FRIEND]);
    await adapter.handleMessage(dm(Number(FRIEND)));
    expect(seen[0].sender).toMatchObject({ id: 'owner', isOwner: true });
  });

  it('an unapproved sender never reaches the handler, owner id or not', async () => {
    const { adapter, seen } = await makeAdapter({ ownerId: OWNER }, [OWNER]);
    // The adapter answers an unapproved sender with a pairing hint; stub the bot.
    (adapter as unknown as { bot: unknown }).bot = { sendMessage: async () => ({ message_id: 1 }) };
    await adapter.handleMessage(dm(Number(FRIEND)));
    expect(seen).toHaveLength(0);
  });
});
