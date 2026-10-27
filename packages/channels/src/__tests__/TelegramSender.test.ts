import { describe, it, expect } from 'vitest';
import { resolveTelegramSender, normalizeTelegramOwnerId } from '../telegram/TelegramSender.js';

describe('resolveTelegramSender', () => {
  it('the configured owner keeps the owner identity', () => {
    expect(resolveTelegramSender('111', 'alice', '111')).toEqual({
      id: 'owner', channelPrefix: 'telegram', displayName: 'alice', isOwner: true,
    });
  });

  it('accepts a numeric sender id and a numeric owner id', () => {
    expect(resolveTelegramSender(111, 'alice', 111)?.isOwner).toBe(true);
    expect(resolveTelegramSender('111', 'alice', 111)?.isOwner).toBe(true);
  });

  it('another approved user gets its own identity without owner rights', () => {
    expect(resolveTelegramSender('222', 'bob', '111')).toEqual({
      id: 'telegram:222', channelPrefix: 'telegram', displayName: 'bob', isOwner: false,
    });
  });

  it('legacy mode (no owner id): everybody is the owner, as before', () => {
    expect(resolveTelegramSender('222', 'bob')).toEqual({
      id: 'owner', channelPrefix: 'telegram', displayName: 'bob', isOwner: true,
    });
  });

  it('refuses a sender id that is not plain digits', () => {
    for (const bad of ['', 'abc', '12 3', '1;2', "1'>", '-5', '1.5', '../x', '12\n3']) {
      expect(resolveTelegramSender(bad, 'x', '111')).toBeNull();
      expect(resolveTelegramSender(bad, 'x')).toBeNull();
    }
  });

  it('a malformed owner id never makes anybody the owner by accident', () => {
    expect(normalizeTelegramOwnerId('abc')).toBeUndefined();
    expect(normalizeTelegramOwnerId(undefined)).toBeUndefined();
    expect(normalizeTelegramOwnerId(' 42 ')).toBe('42');
  });
});
