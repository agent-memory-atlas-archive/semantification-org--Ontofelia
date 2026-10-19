/**
 * PreferenceConsolidation — a choice a user repeated over the same alternatives
 * becomes a `core:preference` fact in that user's own graph
 * (docs/cognitive-architecture/05 §6.1 item 3, pattern 3; see §6.5).
 *
 * Source: `choice-offered` / `choice-made` episodes only (see {@link ChoiceCapture}):
 * an agent response with inline buttons and the same user's press of one of
 * them. Nothing is inferred from free text, and Guardian approval buttons are
 * never part of it.
 *
 * Privacy rule (binding, as for pattern 1): a preference is written ONLY into
 * the graph `urn:<agent>:user:<key>` of the user whose choices it rests on,
 * namely the graph recorded on the choice (`factGraph`); a choice without one
 * is skipped. It never goes to the worldview and never to another user's graph;
 * there is no parameter or code path that selects a different target. Choices
 * are read per user, and a choice counts only when the offer it answers went to
 * that same user: user A's choices count only towards promotions into A's graph.
 *
 * What counts, deterministically and without any model call:
 *  - a `choice-made` episode of the user that names its chosen value and links
 *    an existing `choice-offered` episode of the SAME user that listed the value
 *    among at least two alternatives;
 *  - neither the choice nor the offer is secret-classed or flagged
 *    `cogt:sessionUntrusted`, and neither session is flagged.
 * The offer signature is the sorted set of its alternatives' values. A
 * (user, signature, chosen value) is promoted when it has at least K distinct
 * offers ({@link EpisodicConsolidationSettings.minEpisodes}) in at least Q
 * distinct evidence groups ({@link EpisodicConsolidationSettings.minGroups}),
 * a group being one session on one UTC day exactly as in pattern 1 (the K and Q
 * are the same setup keys). Each offer counts once.
 *
 * Contradiction: when any of the newest K choices over the same signature
 * (of the same user and graph) chose another alternative, nothing is promoted
 * for that signature: the user's behaviour is not settled.
 *
 * Idempotence: the promotion is keyed by a hash over (user, signature, chosen
 * value); a `consolidation-promoted` episode carries it as the tag
 * `claim-hash:<sha256>` and is the ledger, shared with pattern 1 (the hashes
 * cannot collide, the kind is part of the hashed data). A hash found there is
 * never promoted again unless the system withdrew it (see Shift), so a
 * preference the user later retracted does not come back. A triple already in the user's graph is not duplicated.
 *
 * Shift: when (user, signature, v) is promoted, the preferences pattern 3
 * itself promoted earlier into the same user's graph for the same signature
 * and a different value w are withdrawn, so the graph never holds two
 * contradicting preferences for one offer signature. Pattern 3's own triples
 * are identified by their provenance, not by their text: an accepted claim with
 * `sourceKind "consolidation-preference"` and ingestion run
 * `consolidation:<hash>` for the hash of (user, signature, w), and only while
 * the ledger lists that hash as standing. A preference another source wrote
 * (also one with the very same text) is never touched. The withdrawal goes
 * through the engine's belief-revision path (`KnowledgeEngine.withdrawConsolidatedPreferences`):
 * the base triple leaves the user graph, the claim stays in the claims graph with
 * status "superseded" and a link to the new claim. A `consolidation-superseded`
 * episode of the same user records it (tags `old-value:`, `new-value:`,
 * `superseded-hash:`, `claim-hash:` of the new promotion) and counts as
 * `superseded` in the report. Withdrawal happens only on a promotion, never
 * from an `alreadyPromoted` or `alreadyPresent` candidate.
 *
 * A system withdrawal is NOT a user retraction. The `superseded-hash:` tag
 * releases the withdrawn value's ledger entry (a later `consolidation-promoted`
 * of the same hash puts it back), so if the user later settles on w again
 * (newest K choices all w, K offers in Q groups) w is promoted again and the
 * value in between is withdrawn in turn. A preference the user retracted by hand
 * leaves no such episode: its hash stays in the ledger and it does not come back.
 *
 * The fact: subject the user's canonical entity node, predicate `core:preference`
 * (`urn:shared:ontology#preference`), object a plain string that names the chosen
 * value and the alternatives it was chosen over.
 */

import { createHash } from 'node:crypto';
import { compareIso, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { userEntityUri, type KnowledgeEngine } from '../KnowledgeEngine.js';
import {
  DEFAULT_EPISODIC_CONSOLIDATION_SETTINGS,
  EPISODIC_CONSOLIDATION_LIMITS,
  evidenceGroupOf,
  isUsableUserKey,
  type EpisodicConsolidationSettings,
} from './EpisodicConsolidation.js';
import {
  CLAIM_HASH_TAG, NEW_VALUE_TAG, OLD_VALUE_TAG, SUPERSEDED_HASH_TAG, EpisodicMemory, type ChoiceMadeRecord, type ChoiceOfferRecord,
} from './EpisodicMemory.js';

/** The predicate of a promoted preference: `core:preference`. */
export const CORE_PREFERENCE_PREDICATE = 'urn:shared:ontology#preference';

/** The `sourceKind` of a claim minted by this consolidation. */
export const PREFERENCE_SOURCE_KIND = 'consolidation-preference';

/** Tag of the `consolidation-promoted` episode of a preference promotion. */
export const PREFERENCE_PROMOTION_TAG = 'consolidation-preference';

/** Hard bounds of one run; reads and writes never exceed them (the same numbers as pattern 1). */
export const PREFERENCE_CONSOLIDATION_LIMITS = {
  maxUsers: EPISODIC_CONSOLIDATION_LIMITS.maxUsers,
  /** Newest `choice-made` episodes read per user. */
  maxChoicesPerUser: EPISODIC_CONSOLIDATION_LIMITS.maxEpisodesPerUser,
  maxPromotionsPerUser: EPISODIC_CONSOLIDATION_LIMITS.maxPromotionsPerUser,
  maxPromotionsPerRun: EPISODIC_CONSOLIDATION_LIMITS.maxPromotionsPerRun,
} as const;

export interface PreferenceConsolidationReport {
  now: string;
  users: number;
  choicesScanned: number;
  /** Distinct (user, signature, chosen value) seen in countable choices. */
  groupsSeen: number;
  /** Candidates that reached K and Q. */
  qualified: number;
  promoted: number;
  /** Earlier preferences of pattern 3 withdrawn because a different value was promoted for the same signature. */
  superseded: number;
  /** Qualified but the ledger already lists the hash. */
  alreadyPromoted: number;
  /** Qualified but the user graph already holds the triple or an accepted claim. */
  alreadyPresent: number;
  /** Qualified but another alternative was chosen in the newest K choices. */
  contradicted: number;
  /** Qualified but cut by a per-run bound, or refused by the knowledge engine. */
  deferred: number;
  excluded: {
    untrustedEpisodes: number;
    secretEpisodes: number;
    /** No usable `choice-offered` of the same user behind the choice, or a value it did not list. */
    unlinkedChoices: number;
    noFactGraphEpisodes: number;
  };
}

function emptyReport(now: Date): PreferenceConsolidationReport {
  return {
    now: now.toISOString(),
    users: 0,
    choicesScanned: 0,
    groupsSeen: 0,
    qualified: 0,
    promoted: 0,
    superseded: 0,
    alreadyPromoted: 0,
    alreadyPresent: 0,
    contradicted: 0,
    deferred: 0,
    excluded: { untrustedEpisodes: 0, secretEpisodes: 0, unlinkedChoices: 0, noFactGraphEpisodes: 0 },
  };
}

/** The offer signature: a hash over the sorted, distinct alternative values. */
export function choiceSignature(values: string[]): string {
  const sorted = [...new Set(values)].sort();
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Deterministic hash of one preference promotion; the user is part of it, so users never share one. */
export function preferenceClaimHash(userKey: string, signature: string, chosen: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['preference', userKey, signature, chosen]))
    .digest('hex');
}

/** The fact's object: the chosen value and the alternatives it was chosen over, as one plain string. */
export function preferenceObject(chosen: string, alternatives: string[]): string {
  const others = [...new Set(alternatives)].filter((a) => a !== chosen).sort();
  return `chose ${JSON.stringify(chosen)} over ${others.map((a) => JSON.stringify(a)).join(', ')}`;
}

/** A usable choice: the choice, the offer it answers and its place in the signature grouping. */
interface UsableChoice {
  choice: ChoiceMadeRecord & { chosen: string };
  offer: ChoiceOfferRecord;
  signature: string;
  values: string[];
}

export class PreferenceConsolidation {
  private readonly episodic: EpisodicMemory;

  constructor(
    triplestore: TriplestoreAdapter,
    private readonly agentId: string,
    private readonly engine: KnowledgeEngine,
  ) {
    this.episodic = new EpisodicMemory(triplestore, agentId);
  }

  async run(
    settings: EpisodicConsolidationSettings = DEFAULT_EPISODIC_CONSOLIDATION_SETTINGS,
    now: Date = new Date(),
  ): Promise<PreferenceConsolidationReport> {
    const report = emptyReport(now);
    const k = Math.max(1, Math.trunc(settings.minEpisodes));
    const q = Math.max(1, Math.trunc(settings.minGroups));
    const users = await this.episodic.usersWithChoiceEpisodes(PREFERENCE_CONSOLIDATION_LIMITS.maxUsers);
    let budget = PREFERENCE_CONSOLIDATION_LIMITS.maxPromotionsPerRun;

    for (const userKey of users) {
      if (!isUsableUserKey(this.agentId, userKey)) continue;
      report.users++;
      const perUser = await this.runUser(
        userKey, k, q, Math.min(budget, PREFERENCE_CONSOLIDATION_LIMITS.maxPromotionsPerUser), now, report,
      );
      budget -= perUser;
      if (budget <= 0) break;
    }
    return report;
  }

  private async runUser(
    userKey: string,
    k: number,
    q: number,
    promotionBudget: number,
    now: Date,
    report: PreferenceConsolidationReport,
  ): Promise<number> {
    const { choices, untrustedSessions } = await this.episodic.choiceMadeEpisodes(
      userKey,
      PREFERENCE_CONSOLIDATION_LIMITS.maxChoicesPerUser,
    );
    report.choicesScanned += choices.length;

    const offers = await this.episodic.choiceOffers(
      choices.flatMap((c) => (c.offer !== undefined ? [c.offer] : [])),
    );

    const prefix = `urn:${this.agentId}:user:`;
    // One choice per offer: the earliest answers it, a later one is a repeat press.
    const byOffer = new Map<string, UsableChoice>();
    const ordered = [...choices].sort((a, b) => compareIso(a.occurredAt, b.occurredAt) || (a.uri < b.uri ? -1 : 1));
    for (const c of ordered) {
      if (c.secret) {
        report.excluded.secretEpisodes++;
        continue;
      }
      if (c.untrusted || (c.sessionId !== undefined && untrustedSessions.has(c.sessionId))) {
        report.excluded.untrustedEpisodes++;
        continue;
      }
      const offer = c.offer !== undefined ? offers.get(c.offer) : undefined;
      // The offer must exist, have gone to THIS user, and have listed the value.
      if (
        offer === undefined ||
        c.chosen === undefined ||
        offer.forUser !== userKey ||
        offer.alternatives.length < 2 ||
        !offer.alternatives.some((a) => a.value === c.chosen)
      ) {
        report.excluded.unlinkedChoices++;
        continue;
      }
      if (offer.secret) {
        report.excluded.secretEpisodes++;
        continue;
      }
      if (offer.untrusted || (offer.sessionId !== undefined && untrustedSessions.has(offer.sessionId))) {
        report.excluded.untrustedEpisodes++;
        continue;
      }
      // Promote only into the graph recorded on the choice, and only one of this
      // agent's user graphs; a choice without one is not guessed about.
      const g = c.factGraph;
      const key = g !== undefined && g.startsWith(prefix) ? g.slice(prefix.length) : '';
      if (g === undefined || !isUsableUserKey(this.agentId, key) || GraphUriResolver.getUserGraph(this.agentId, key) !== g) {
        report.excluded.noFactGraphEpisodes++;
        continue;
      }
      if (byOffer.has(offer.uri)) continue;
      const values = offer.alternatives.map((a) => a.value);
      byOffer.set(offer.uri, {
        choice: c as ChoiceMadeRecord & { chosen: string },
        offer,
        signature: choiceSignature(values),
        values,
      });
    }

    const byGraph = new Map<string, UsableChoice[]>();
    for (const u of byOffer.values()) {
      const g = u.choice.factGraph as string;
      if (!byGraph.has(g)) byGraph.set(g, []);
      byGraph.get(g)!.push(u);
    }
    let written = 0;
    for (const [graph, list] of [...byGraph.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      written += await this.runGraph(userKey, graph, graph.slice(prefix.length), list, k, q, promotionBudget - written, now, report);
    }
    return written;
  }

  /** One fact graph of one user: count, qualify and promote into exactly that graph. */
  private async runGraph(
    userKey: string,
    graph: string,
    graphKey: string,
    usable: UsableChoice[],
    k: number,
    q: number,
    promotionBudget: number,
    now: Date,
    report: PreferenceConsolidationReport,
  ): Promise<number> {
    // signature -> chosen value -> choices
    const bySignature = new Map<string, Map<string, UsableChoice[]>>();
    for (const u of usable) {
      let m = bySignature.get(u.signature);
      if (!m) bySignature.set(u.signature, (m = new Map()));
      const list = m.get(u.choice.chosen) ?? [];
      list.push(u);
      m.set(u.choice.chosen, list);
    }

    interface Candidate { signature: string; chosen: string; choices: UsableChoice[]; values: string[]; hash: string }
    const qualified: Candidate[] = [];
    const hashKey = graph === GraphUriResolver.getUserGraph(this.agentId, userKey) ? userKey : graph;
    for (const [signature, byChosen] of bySignature) {
      report.groupsSeen += byChosen.size;
      // The newest K choices over this signature, whatever they chose.
      const newest = [...byChosen.values()]
        .flat()
        .sort((a, b) => compareIso(b.choice.occurredAt, a.choice.occurredAt) || (a.choice.uri < b.choice.uri ? -1 : 1))
        .slice(0, k);
      for (const [chosen, choices] of byChosen) {
        const groups = new Set(choices.map((u) => evidenceGroupOf(u.choice)));
        if (choices.length < k || groups.size < q) continue;
        report.qualified++;
        if (newest.some((u) => u.choice.chosen !== chosen)) {
          report.contradicted++;
          continue;
        }
        qualified.push({
          signature,
          chosen,
          choices,
          values: choices[0].values,
          hash: preferenceClaimHash(hashKey, signature, chosen),
        });
      }
    }
    if (qualified.length === 0) return 0;

    // Strongest support first, then the most recent choice, then the hash: a
    // fixed order, independent of the store's row order.
    const latest = (c: Candidate) =>
      c.choices.map((u) => u.choice.occurredAt).sort(compareIso).pop() as string;
    qualified.sort(
      (a, b) =>
        b.choices.length - a.choices.length ||
        compareIso(latest(b), latest(a)) ||
        (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
    );

    const ledger = await this.episodic.activePromotedHashes(userKey);
    const subject = userEntityUri(graphKey);
    let written = 0;
    for (const c of qualified) {
      if (ledger.has(c.hash)) {
        report.alreadyPromoted++;
        continue;
      }
      if (written >= promotionBudget) {
        report.deferred++;
        continue;
      }
      const sources = [...new Set(c.choices.flatMap((u) => [u.choice.uri, u.offer.uri]))].sort();
      const res = await this.engine.promoteToUserGraph({
        agentId: this.agentId,
        userKey: graphKey,
        subjectUri: subject,
        predicateUri: CORE_PREFERENCE_PREDICATE,
        object: { kind: 'literal', value: preferenceObject(c.chosen, c.values) },
        sourceEpisodes: sources,
        supportClaims: [],
        claimHash: c.hash,
        sourceKind: PREFERENCE_SOURCE_KIND,
        sourceSpan: `Consolidated from ${c.choices.length} choices over the same ${c.values.length} alternatives.`,
      });
      if (res.outcome === 'already-present') {
        report.alreadyPresent++;
        continue;
      }
      if (res.outcome !== 'promoted') {
        // already-known / conflict cannot arise for a preference; counted, never written.
        report.deferred++;
        continue;
      }
      await this.episodic.append({
        episodeType: 'consolidation-promoted',
        occurredAt: now,
        forUser: userKey,
        factGraph: graph,
        about: [subject],
        hasClaim: res.claimUri ? [res.claimUri] : [],
        tags: ['consolidation', PREFERENCE_PROMOTION_TAG, `${CLAIM_HASH_TAG}${c.hash}`],
        salience: 0.3,
      });
      ledger.add(c.hash);
      written++;
      report.promoted++;

      // The shift: earlier preferences of pattern 3 over the same signature with
      // another value are withdrawn (provenance and ledger decide what is ours).
      const rivals = c.values
        .filter((w) => w !== c.chosen)
        .map((w) => ({ w, hash: preferenceClaimHash(hashKey, c.signature, w) }))
        .filter((r) => ledger.has(r.hash));
      if (rivals.length > 0 && res.claimUri) {
        const withdrawn = await this.engine.withdrawConsolidatedPreferences({
          agentId: this.agentId,
          userKey: graphKey,
          subjectUri: subject,
          predicateUri: CORE_PREFERENCE_PREDICATE,
          claimHashes: rivals.map((r) => r.hash),
          supersedingClaimUri: res.claimUri,
        });
        for (const gone of withdrawn) {
          const old = rivals.find((r) => r.hash === gone.claimHash) as { w: string; hash: string };
          await this.episodic.append({
            episodeType: 'consolidation-superseded',
            occurredAt: now,
            forUser: userKey,
            factGraph: graph,
            about: [subject],
            tags: [
              'consolidation', PREFERENCE_PROMOTION_TAG,
              `${SUPERSEDED_HASH_TAG}${old.hash}`, `${CLAIM_HASH_TAG}${c.hash}`,
              `${OLD_VALUE_TAG}${old.w}`, `${NEW_VALUE_TAG}${c.chosen}`,
            ],
            salience: 0.3,
          });
          ledger.delete(old.hash);
          report.superseded++;
        }
      }
    }
    return written;
  }
}
