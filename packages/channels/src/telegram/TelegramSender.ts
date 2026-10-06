import type { MessageEnvelope } from '@ontofelia/core';

export type TelegramSender = MessageEnvelope['sender'];

const DIGITS = /^[0-9]+$/;

/**
 * Normalise a configured owner id (string or number) to a digit string, or
 * undefined when unset or malformed (malformed means legacy mode, not a guess).
 */
export function normalizeTelegramOwnerId(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && DIGITS.test(raw.trim())) return raw.trim();
  return undefined;
}

/**
 * Single place that decides who a Telegram sender is.
 *
 * - `ownerId` set and equal to `fromId`: the owner (identity `owner`, so the
 *   owner's existing sessions and private graph stay theirs).
 * - `ownerId` set and different: a non-owner with its own identity
 *   `telegram:<fromId>`. The runtime uses `sender.id` as the user id of the
 *   per-user graph and as the session peer, so this person gets a private
 *   store and no owner rights.
 * - `ownerId` unset: legacy mode, every sender is the owner.
 *
 * Returns null when `fromId` is not a plain digit string; the caller must drop
 * the message (the id ends up in graph URIs).
 */
export function resolveTelegramSender(
  fromId: string | number,
  displayName: string | undefined,
  ownerId?: string | number,
): TelegramSender | null {
  const from = typeof fromId === 'number' ? String(fromId) : fromId;
  if (!DIGITS.test(from)) return null;
  const owner = normalizeTelegramOwnerId(ownerId);
  if (owner === undefined || owner === from) {
    return { id: 'owner', channelPrefix: 'telegram', displayName, isOwner: true };
  }
  return { id: `telegram:${from}`, channelPrefix: 'telegram', displayName, isOwner: false };
}
