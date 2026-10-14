import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';

const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@ontofelia/core', async (orig) => ({
  ...(await orig<typeof import('@ontofelia/core')>()),
  createLogger: () => logger,
}));

import { setupTelegramChannel, telegramOwnerWarning } from '../telegram.js';

async function start(ownerId?: string) {
  const config = getDefaultConfig();
  config.channels.telegram = { enabled: true, allowedChats: [], ...(ownerId ? { ownerId } : {}) };
  const adapter = { getBot: () => undefined, onMessage: () => {}, onCallbackQuery: () => {} };
  await setupTelegramChannel(
    config,
    adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
    { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
    new Map([[PRIMARY_AGENT_ID, {}]]) as unknown as Parameters<typeof setupTelegramChannel>[3],
  );
}

describe('startup warning for legacy owner mode', () => {
  beforeEach(() => { logger.warn.mockClear(); });

  it('is logged once when channels.telegram.ownerId is unset', async () => {
    await start();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/ownerId is not set.*owner/s);
  });

  it('is not logged when ownerId is set', async () => {
    await start('1000001');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('the helper agrees', () => {
    const c = getDefaultConfig();
    c.channels.telegram = { enabled: true, allowedChats: [] };
    expect(telegramOwnerWarning(c)).toContain('channels.telegram.ownerId');
    c.channels.telegram = { enabled: true, allowedChats: [], ownerId: '5' };
    expect(telegramOwnerWarning(c)).toBeUndefined();
  });
});
