/**
 * ChoiceCapture — the deterministic source of the preference consolidation
 * (docs/cognitive-architecture/05 §6.1 item 3, §6.5).
 *
 * Two episode kinds, and nothing else is read as a choice:
 *  - `choice-offered`: an agent response that carried inline buttons was sent.
 *    The alternatives are the buttons (callback data and label), the episode
 *    carries the user the response went to, the session, the channel and the
 *    channel's reference to the sent message (`offer-ref:<ref>`).
 *  - `choice-made`: that user pressed one of those buttons. The episode is
 *    linked to the offer (`cogt:precededBy`) and carries the pressed value
 *    (`chosen:<callbackData>`).
 *
 * Rules that cannot be switched off:
 *  - Guardian approval buttons (callback data `g:`) never become an alternative
 *    and a press of one is refused here: an approval is a security decision,
 *    not a preference.
 *  - A press counts only for the SAME user the offer went to (`forUser` of the
 *    offer equals the presser's key). A press by anyone else writes nothing.
 *  - Only a value that was one of the offer's alternatives counts, and an offer
 *    is answered once: a second press of the same offer writes nothing.
 *  - An offer needs at least two distinct alternatives (a single button offers
 *    no "X over Y") and at most {@link CHOICE_CAPTURE_LIMITS.maxAlternatives}.
 *  - No free text is read or stored as a choice; the stored values are the
 *    sender-independent callback data the agent itself put on the buttons.
 *
 * The caller decides WHETHER to capture (the episodic memory flag); this class
 * is the write path and has no flag of its own.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  CHOICE_ALT_TAG,
  CHOICE_CHOSEN_TAG,
  CHOICE_OFFER_REF_TAG,
  EpisodicMemory,
  type EpisodeId,
} from './EpisodicMemory.js';

/** Prefix of the Guardian approval buttons' callback data (`g:a:<token>`). */
export const GUARDIAN_CALLBACK_PREFIX = 'g:';

export const CHOICE_CAPTURE_LIMITS = {
  /** Alternatives of one offer; a larger offer is not recorded (never truncated). */
  maxAlternatives: 20,
  /** Longest callback data kept as a value. */
  maxValueLength: 128,
  /** Longest label kept. */
  maxLabelLength: 100,
  /** Longest channel reference. */
  maxRefLength: 200,
} as const;

export interface ChoiceButton {
  text: string;
  callbackData: string;
}

export interface OfferInput {
  /** Cognitive user key the response went to (`cogt:forUser`). */
  forUser: string;
  /** The graph the sender's own facts go to (`urn:<agent>:user:<id>`), as on inbound episodes. */
  factGraph?: string;
  sessionId?: string;
  channel?: string;
  /** The channel's reference to the sent message, e.g. `telegram:<chat>:<message>`. */
  offerRef: string;
  buttons: ChoiceButton[];
  /** A button value or label matches a credential shape: the episode is secret-classed. */
  secret?: boolean;
  sessionUntrusted?: boolean;
  now?: Date;
}

export interface ChoiceInput {
  /** Cognitive user key of the presser. */
  forUser: string;
  offerRef: string;
  callbackData: string;
  now?: Date;
}

export type OfferResult =
  | { recorded: true; uri: EpisodeId; alternatives: number }
  | { recorded: false; reason: 'no-user' | 'no-ref' | 'too-few-alternatives' | 'too-many-alternatives' | 'duplicate-offer' };

export type ChoiceResult =
  | { recorded: true; uri: EpisodeId; offer: EpisodeId }
  | {
      recorded: false;
      reason: 'no-user' | 'guardian-callback' | 'invalid-value' | 'no-ref' | 'no-offer' | 'other-user' | 'not-an-alternative' | 'already-chosen';
    };

/** Is this callback data a Guardian approval button's? */
export function isGuardianCallback(callbackData: string): boolean {
  return callbackData.startsWith(GUARDIAN_CALLBACK_PREFIX);
}

function usableValue(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && v.length <= CHOICE_CAPTURE_LIMITS.maxValueLength && !isGuardianCallback(v);
}

function usableUser(u: unknown): u is string {
  return typeof u === 'string' && u !== '' && u !== 'all';
}

export class ChoiceCapture {
  private readonly episodic: EpisodicMemory;
  /** One press at a time per offer, so a double tap cannot answer an offer twice. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    triplestore: TriplestoreAdapter,
    agentId: string,
  ) {
    this.episodic = new EpisodicMemory(triplestore, agentId);
  }

  /** Record that `buttons` were offered. Guardian buttons are dropped, not recorded. */
  async recordOffer(p: OfferInput): Promise<OfferResult> {
    if (!usableUser(p.forUser)) return { recorded: false, reason: 'no-user' };
    if (typeof p.offerRef !== 'string' || p.offerRef === '' || p.offerRef.length > CHOICE_CAPTURE_LIMITS.maxRefLength) {
      return { recorded: false, reason: 'no-ref' };
    }
    const seen = new Map<string, string>();
    for (const b of p.buttons ?? []) {
      if (!usableValue(b?.callbackData) || seen.has(b.callbackData)) continue;
      const label = typeof b.text === 'string' ? b.text.slice(0, CHOICE_CAPTURE_LIMITS.maxLabelLength) : b.callbackData;
      seen.set(b.callbackData, label);
    }
    if (seen.size < 2) return { recorded: false, reason: 'too-few-alternatives' };
    if (seen.size > CHOICE_CAPTURE_LIMITS.maxAlternatives) return { recorded: false, reason: 'too-many-alternatives' };

    return this.serialised(`ref:${p.offerRef}`, async () => {
      const existing = await this.episodic.findChoiceOfferByRef(p.offerRef);
      if (existing && existing.forUser === p.forUser) return { recorded: false, reason: 'duplicate-offer' } as const;
      const uri = await this.episodic.append({
        episodeType: 'choice-offered',
        ...(p.now ? { occurredAt: p.now } : {}),
        forUser: p.forUser,
        ...(p.factGraph ? { factGraph: p.factGraph } : {}),
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.channel ? { channel: p.channel } : {}),
        ...(p.secret === true ? { privacyClass: 'secret' as const } : {}),
        ...(p.sessionUntrusted === true ? { sessionUntrusted: true } : {}),
        tags: [
          `${CHOICE_OFFER_REF_TAG}${p.offerRef}`,
          ...[...seen.entries()].map(([value, label]) => `${CHOICE_ALT_TAG}${JSON.stringify([value, label])}`),
        ],
      });
      return { recorded: true, uri, alternatives: seen.size } as const;
    });
  }

  /**
   * Record that `callbackData` of the offer `offerRef` was pressed by `forUser`.
   * Writes nothing unless the offer exists, went to this very user, listed the
   * value, and was not answered yet.
   */
  async recordChoice(p: ChoiceInput): Promise<ChoiceResult> {
    if (!usableUser(p.forUser)) return { recorded: false, reason: 'no-user' };
    if (typeof p.callbackData === 'string' && isGuardianCallback(p.callbackData)) {
      return { recorded: false, reason: 'guardian-callback' };
    }
    if (!usableValue(p.callbackData)) return { recorded: false, reason: 'invalid-value' };
    if (typeof p.offerRef !== 'string' || p.offerRef === '') return { recorded: false, reason: 'no-ref' };

    return this.serialised(`ref:${p.offerRef}`, async () => {
      const offer = await this.episodic.findChoiceOfferByRef(p.offerRef);
      if (!offer) return { recorded: false, reason: 'no-offer' } as const;
      // The same user only: the key the offer went to must equal the presser's.
      if (offer.forUser === undefined || offer.forUser !== p.forUser) return { recorded: false, reason: 'other-user' } as const;
      if (!offer.alternatives.some((a) => a.value === p.callbackData)) {
        return { recorded: false, reason: 'not-an-alternative' } as const;
      }
      if (await this.episodic.hasChoiceMadeFor(offer.uri)) return { recorded: false, reason: 'already-chosen' } as const;
      const uri = await this.episodic.append({
        episodeType: 'choice-made',
        ...(p.now ? { occurredAt: p.now } : {}),
        forUser: offer.forUser,
        // The graph and session of the offer: a choice stays with the user it answers.
        ...(offer.factGraph ? { factGraph: offer.factGraph } : {}),
        ...(offer.sessionId ? { sessionId: offer.sessionId } : {}),
        ...(offer.channel ? { channel: offer.channel } : {}),
        ...(offer.secret ? { privacyClass: 'secret' as const } : {}),
        ...(offer.untrusted ? { sessionUntrusted: true } : {}),
        precededBy: offer.uri,
        tags: [`${CHOICE_CHOSEN_TAG}${p.callbackData}`],
      });
      return { recorded: true, uri, offer: offer.uri } as const;
    });
  }

  private async serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next);
    try {
      return await next;
    } finally {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }
}
