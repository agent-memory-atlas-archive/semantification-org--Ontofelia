import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine, userEntityUri } from '../KnowledgeEngine.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';
import { ChoiceCapture } from '../cognitive/ChoiceCapture.js';
import {
  PreferenceConsolidation,
  CORE_PREFERENCE_PREDICATE,
  choiceSignature,
  preferenceClaimHash,
  preferenceObject,
} from '../cognitive/PreferenceConsolidation.js';

// Preference consolidation (pattern 3): the same choice over the same
// alternatives, repeated across independent sessions or days, becomes a
// core:preference fact in THAT user's own graph and nowhere else. The capture
// side (a button offer and the same user's press) is exercised against a real
// in-process Oxigraph store as well.

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const COGT = 'urn:shared:ontology#cog/';
const WORLDVIEW = `urn:${AGENT}:worldview`;
const CLAIMS = `urn:${AGENT}:claims`;
const EPISODIC = `urn:${AGENT}:cog:episodic`;
const userGraph = (k: string) => `urn:${AGENT}:user:${k}`;
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const AB = ['/model a', '/model b'];

describe('preference consolidation', { timeout: 60_000 }, () => {
  let dir: string;
  let store: TriplestoreAdapter;
  let engine: KnowledgeEngine;
  let em: EpisodicMemory;
  let capture: ChoiceCapture;
  let job: PreferenceConsolidation;
  let n = 0;

  beforeEach(async () => {
    dir = `/tmp/pref-consol-test-${Math.random().toString(16).slice(2)}`;
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    engine = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    em = new EpisodicMemory(store, AGENT);
    capture = new ChoiceCapture(store, AGENT);
    job = new PreferenceConsolidation(store, AGENT, engine);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const buttons = (values: string[]) => values.map((v) => ({ text: v.toUpperCase(), callbackData: v }));

  /** An offer to `user` in `session` on day offset `day`; returns its message reference. */
  async function offer(user: string, session: string, day: number, values: string[] = AB, extra: Record<string, unknown> = {}) {
    const ref = `telegram:${user}:${++n}`;
    const r = await capture.recordOffer({
      forUser: user,
      factGraph: userGraph(user),
      sessionId: session,
      channel: 'telegram',
      offerRef: ref,
      buttons: buttons(values),
      now: new Date(T0 + day * DAY),
      ...extra,
    });
    expect(r.recorded).toBe(true);
    return ref;
  }

  /** An offer and the same user's press of `chosen`. */
  async function choose(user: string, session: string, day: number, chosen: string, values: string[] = AB, minutes = 1) {
    const ref = await offer(user, session, day, values);
    const r = await capture.recordChoice({
      forUser: user,
      offerRef: ref,
      callbackData: chosen,
      now: new Date(T0 + day * DAY + minutes * 60_000),
    });
    expect(r.recorded).toBe(true);
    return ref;
  }

  /** Three choices of `/model a` over a and b in two sessions on two days. */
  async function threeChoices(user: string, chosen = '/model a', values: string[] = AB) {
    await choose(user, `${user}-s1`, 0, chosen, values);
    await choose(user, `${user}-s1`, 0, chosen, values, 5);
    await choose(user, `${user}-s2`, 1, chosen, values);
  }

  async function graphsHolding(s: string, p: string): Promise<string[]> {
    const res = await store.query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { <${s}> <${p}> ?o } }`);
    return (res.bindings ?? []).map((b) => b.g.value).sort();
  }
  const prefTriples = async () =>
    ((await store.query(`SELECT ?g ?s ?o WHERE { GRAPH ?g { ?s <${CORE_PREFERENCE_PREDICATE}> ?o } }`)).bindings ?? []).map((b) => ({
      g: b.g.value, s: b.s.value, o: b.o.value,
    }));
  async function quadCount(): Promise<number> {
    const res = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
    return (res.bindings ?? []).length;
  }
  async function episodeCount(): Promise<number> {
    const res = await store.query(`SELECT ?e WHERE { GRAPH <${EPISODIC}> { ?e a <${COGT}Episode> } }`);
    return (res.bindings ?? []).length;
  }
  async function claimsOf(sourceKind: string): Promise<string[]> {
    const res = await store.query(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}sourceKind> "${sourceKind}" ; <${CORE}status> "accepted" } }`);
    return (res.bindings ?? []).map((b) => b.c.value);
  }

  describe('capture', () => {
    it('writes a choice-offered episode with the alternatives, user, session and channel, and a linked choice-made episode', async () => {
      const ref = await offer('anna', 's1', 0, ['/model b', '/model a', '/model c']);
      const offered = (await em.recent('anna', 50)).filter((e) => e.episodeType === 'choice-offered');
      expect(offered).toHaveLength(1);
      expect(offered[0].forUser).toBe('anna');
      expect(offered[0].sessionId).toBe('s1');
      expect(offered[0].tags).toContain(`offer-ref:${ref}`);
      const alts = offered[0].tags.filter((t) => t.startsWith('alt:')).map((t) => JSON.parse(t.slice(4)));
      expect(alts.sort()).toEqual([['/model a', '/MODEL A'], ['/model b', '/MODEL B'], ['/model c', '/MODEL C']]);

      const r = await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model c', now: new Date(T0 + 60_000) });
      expect(r.recorded).toBe(true);
      const made = (await em.recent('anna', 50)).filter((e) => e.episodeType === 'choice-made');
      expect(made).toHaveLength(1);
      expect(made[0].forUser).toBe('anna');
      expect(made[0].sessionId).toBe('s1');
      expect(made[0].precededBy).toBe(offered[0].uri);
      expect(made[0].tags).toEqual(['chosen:/model c']);
    });

    it('a press by another user writes nothing, even of a listed value', async () => {
      const ref = await offer('anna', 's1', 0);
      const before = await quadCount();
      const r = await capture.recordChoice({ forUser: 'bob', offerRef: ref, callbackData: '/model a' });
      expect(r).toEqual({ recorded: false, reason: 'other-user' });
      expect(await quadCount()).toBe(before);
      // The owner's key is no wildcard either.
      expect(await capture.recordChoice({ forUser: 'owner', offerRef: ref, callbackData: '/model a' })).toEqual({ recorded: false, reason: 'other-user' });
      expect(await quadCount()).toBe(before);
    });

    it('Guardian g: callbacks write nothing: never an alternative, never a choice', async () => {
      // An offer made only of approval buttons is not recorded at all.
      const before = await quadCount();
      const only = await capture.recordOffer({
        forUser: 'owner', offerRef: 'telegram:owner:g1', factGraph: userGraph('owner'),
        buttons: [{ text: 'Approve', callbackData: 'g:a:x1' }, { text: 'Deny', callbackData: 'g:d:x1' }],
      });
      expect(only).toEqual({ recorded: false, reason: 'too-few-alternatives' });
      expect(await quadCount()).toBe(before);

      // Mixed: the g: buttons are dropped from the alternatives.
      const ref = 'telegram:owner:g2';
      await capture.recordOffer({
        forUser: 'owner', offerRef: ref, factGraph: userGraph('owner'),
        buttons: [{ text: 'A', callbackData: '/model a' }, { text: 'B', callbackData: '/model b' }, { text: 'Approve', callbackData: 'g:a:x2' }],
      });
      const offered = (await em.recent('owner', 50)).filter((e) => e.episodeType === 'choice-offered');
      expect(offered[0].tags.filter((t) => t.startsWith('alt:')).map((t) => JSON.parse(t.slice(4))[0]).sort()).toEqual(AB);

      // Pressing an approval button is refused, on this offer and on none.
      const after = await quadCount();
      expect(await capture.recordChoice({ forUser: 'owner', offerRef: ref, callbackData: 'g:a:x2' })).toEqual({ recorded: false, reason: 'guardian-callback' });
      expect(await capture.recordChoice({ forUser: 'owner', offerRef: 'telegram:owner:none', callbackData: 'g:A:zz' })).toEqual({ recorded: false, reason: 'guardian-callback' });
      expect(await quadCount()).toBe(after);
    });

    it('refuses a single button, a value that was not offered, an unknown offer and a second press', async () => {
      expect(await capture.recordOffer({ forUser: 'anna', offerRef: 'r-one', buttons: buttons(['/x']) })).toMatchObject({ recorded: false, reason: 'too-few-alternatives' });
      expect(await capture.recordOffer({ forUser: 'anna', offerRef: '', buttons: buttons(AB) })).toMatchObject({ recorded: false, reason: 'no-ref' });
      expect(await capture.recordOffer({ forUser: 'all', offerRef: 'r-all', buttons: buttons(AB) })).toMatchObject({ recorded: false, reason: 'no-user' });
      const ref = await offer('anna', 's1', 0);
      expect(await capture.recordOffer({ forUser: 'anna', offerRef: ref, buttons: buttons(AB) })).toMatchObject({ recorded: false, reason: 'duplicate-offer' });
      expect(await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model z' })).toMatchObject({ recorded: false, reason: 'not-an-alternative' });
      expect(await capture.recordChoice({ forUser: 'anna', offerRef: 'telegram:nope', callbackData: '/model a' })).toMatchObject({ recorded: false, reason: 'no-offer' });
      expect((await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a' })).recorded).toBe(true);
      const count = await episodeCount();
      expect(await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model b' })).toMatchObject({ recorded: false, reason: 'already-chosen' });
      expect(await episodeCount()).toBe(count);
    });

    it('two simultaneous presses of one offer answer it once', async () => {
      const ref = await offer('anna', 's1', 0);
      const [x, y] = await Promise.all([
        capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a' }),
        capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model b' }),
      ]);
      expect([x.recorded, y.recorded].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('consolidation', () => {
    it('3 choices over the same alternatives in 2 sessions promote exactly one preference into the user graph', async () => {
      await threeChoices('anna');
      const r = await job.run();
      expect(r.qualified).toBe(1);
      expect(r.promoted).toBe(1);

      const subject = userEntityUri('anna');
      expect(await prefTriples()).toEqual([
        { g: userGraph('anna'), s: subject, o: preferenceObject('/model a', AB) },
      ]);
      expect(await graphsHolding(subject, CORE_PREFERENCE_PREDICATE)).toEqual([userGraph('anna')]);

      const claims = await claimsOf('consolidation-preference');
      expect(claims).toHaveLength(1);
      expect(await claimsOf('consolidation-episodic')).toHaveLength(0);
      // The evidence lists the three choices and their three offers.
      const ev = await store.query(`SELECT ?e WHERE { GRAPH <${CLAIMS}> { <${claims[0]}> <${CORE}hasEvidence> ?ev } GRAPH <urn:${AGENT}:evidence> { ?ev <${CORE}sourceEpisode> ?e } }`);
      expect(new Set((ev.bindings ?? []).map((b) => b.e.value)).size).toBe(6);
      // The ledger: one consolidation-promoted episode of the user with the hash.
      const led = (await em.recent('anna', 100)).filter((e) => e.episodeType === 'consolidation-promoted');
      expect(led).toHaveLength(1);
      expect(led[0].forUser).toBe('anna');
      expect(led[0].tags).toContain(`claim-hash:${preferenceClaimHash('anna', choiceSignature(AB), '/model a')}`);
    });

    it('the alternatives are a set: another order is the same offer signature', async () => {
      await choose('anna', 's1', 0, '/model a', ['/model a', '/model b']);
      await choose('anna', 's1', 0, '/model a', ['/model b', '/model a'], 5);
      await choose('anna', 's2', 1, '/model a', ['/model b', '/model a']);
      expect((await job.run()).promoted).toBe(1);
    });

    it('choices over different alternatives are not pooled', async () => {
      await choose('anna', 's1', 0, '/model a', ['/model a', '/model b']);
      await choose('anna', 's2', 1, '/model a', ['/model a', '/model c']);
      await choose('anna', 's3', 2, '/model a', ['/model a', '/model d']);
      const r = await job.run();
      expect(r.qualified).toBe(0);
      expect(await prefTriples()).toEqual([]);
    });

    it('3 choices in one session on one day are one group and do not promote', async () => {
      for (let i = 0; i < 3; i++) await choose('anna', 'only', 0, '/model a', AB, i * 5);
      const r = await job.run();
      expect(r.groupsSeen).toBe(1);
      expect(r.qualified).toBe(0);
      expect(await prefTriples()).toEqual([]);
    });

    it('one session over several days counts as independent groups', async () => {
      for (let d = 0; d < 3; d++) await choose('anna', 'long', d, '/model a');
      expect((await job.run()).promoted).toBe(1);
    });

    it('two choices do not promote', async () => {
      await choose('anna', 's1', 0, '/model a');
      await choose('anna', 's2', 1, '/model a');
      expect((await job.run()).promoted).toBe(0);
    });

    it('a contradicting choice among the newest three blocks the promotion', async () => {
      await threeChoices('anna');
      await choose('anna', 's3', 2, '/model b');
      const r = await job.run();
      expect(r.qualified).toBe(1);
      expect(r.contradicted).toBe(1);
      expect(r.promoted).toBe(0);
      expect(await prefTriples()).toEqual([]);
    });

    it('an older contradiction does not block: the newest three agree', async () => {
      await choose('anna', 's0', 0, '/model b');
      await choose('anna', 's1', 1, '/model a');
      await choose('anna', 's2', 2, '/model a');
      await choose('anna', 's3', 3, '/model a');
      const r = await job.run();
      expect(r.contradicted).toBe(0);
      expect(r.promoted).toBe(1);
      expect((await prefTriples())[0].o).toBe(preferenceObject('/model a', AB));
    });

    it('a rerun is a no-op: identical quad and episode count, nothing promoted', async () => {
      await threeChoices('anna');
      await job.run();
      const quads = await quadCount();
      const episodes = await episodeCount();
      const again = await job.run();
      expect(again.promoted).toBe(0);
      expect(again.alreadyPromoted).toBe(1);
      expect(await quadCount()).toBe(quads);
      expect(await episodeCount()).toBe(episodes);
    });

    it('a preference the user retracted does not come back', async () => {
      await threeChoices('anna');
      await job.run();
      const [pc] = await claimsOf('consolidation-preference');
      await store.update(`DELETE WHERE { GRAPH <${userGraph('anna')}> { <${userEntityUri('anna')}> <${CORE_PREFERENCE_PREDICATE}> ?o } }`);
      await store.update(`DELETE WHERE { GRAPH <${CLAIMS}> { <${pc}> ?p ?o } }`);
      const r = await job.run();
      expect(r.promoted).toBe(0);
      expect(r.alreadyPromoted).toBe(1);
      expect(await prefTriples()).toEqual([]);
    });

    it('does not duplicate a triple the user graph already holds', async () => {
      await threeChoices('anna');
      await store.update(`INSERT DATA { GRAPH <${userGraph('anna')}> { <${userEntityUri('anna')}> <${CORE_PREFERENCE_PREDICATE}> ${JSON.stringify(preferenceObject('/model a', AB))} } }`);
      const before = await quadCount();
      const r = await job.run();
      expect(r.alreadyPresent).toBe(1);
      expect(r.promoted).toBe(0);
      expect(await quadCount()).toBe(before);
    });

    it('thresholds are honoured', async () => {
      await threeChoices('anna');
      expect((await job.run({ minEpisodes: 4, minGroups: 2 })).promoted).toBe(0);
      expect((await job.run({ minEpisodes: 3, minGroups: 3 })).promoted).toBe(0);
      expect((await job.run({ minEpisodes: 3, minGroups: 2 })).promoted).toBe(1);
    });

    describe('cross-user', () => {
      it('user A\'s preference lands in A\'s graph only: never in B\'s graph, the worldview or the owner\'s', async () => {
        await threeChoices('anna');
        // bob chose the same twice: with anna's three that would make five if the evidence mixed.
        await choose('bob', 'b1', 0, '/model a');
        await choose('bob', 'b2', 1, '/model a');
        const r = await job.run();
        expect(r.promoted).toBe(1);
        const triples = await prefTriples();
        expect(triples.map((t) => t.g)).toEqual([userGraph('anna')]);
        expect(triples[0].s).toBe(userEntityUri('anna'));
        // Not B's graph, not the worldview, not the owner's, and no preference about B anywhere.
        for (const g of [userGraph('bob'), WORLDVIEW, userGraph('owner')]) {
          expect(triples.filter((t) => t.g === g)).toEqual([]);
        }
        expect(triples.filter((t) => t.s === userEntityUri('bob'))).toEqual([]);
        const claimGraphs = await store.query(`SELECT ?g WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}sourceKind> "consolidation-preference" ; <${CORE}assertedInGraph> ?g } }`);
        expect((claimGraphs.bindings ?? []).map((b) => b.g.value)).toEqual([userGraph('anna')]);
        // The ledger entry belongs to anna alone.
        expect((await em.recent('bob', 100)).filter((e) => e.episodeType === 'consolidation-promoted')).toEqual([]);
      });

      it('evidence of different users never mixes: 3 users with 2 choices each promote nothing', async () => {
        for (const u of ['anna', 'bob', 'carl']) {
          await choose(u, `${u}1`, 0, '/model a');
          await choose(u, `${u}2`, 1, '/model a');
        }
        expect((await job.run()).promoted).toBe(0);
        expect(await prefTriples()).toEqual([]);
      });

      it('a press by another user never reaches the offered user\'s count', async () => {
        // anna chose twice; a third offer to anna is pressed by bob, who is refused.
        await choose('anna', 'a1', 0, '/model a');
        await choose('anna', 'a2', 1, '/model a');
        const ref = await offer('anna', 'a3', 2);
        const press = await capture.recordChoice({ forUser: 'bob', offerRef: ref, callbackData: '/model a', now: new Date(T0 + 2 * DAY + 1000) });
        expect(press.recorded).toBe(false);
        const r = await job.run();
        expect(r.promoted).toBe(0);
        expect(await prefTriples()).toEqual([]);
        expect((await em.recent('bob', 50)).filter((e) => e.episodeType === 'choice-made')).toEqual([]);
        expect((await em.recent('anna', 50)).filter((e) => e.episodeType === 'choice-made')).toHaveLength(2);
      });

      it('a choice that answers another user\'s offer is not counted', async () => {
        // anna's three choices all answer offers that went to bob (forged links).
        const bobOffers: string[] = [];
        for (let i = 0; i < 3; i++) {
          const ref = await offer('bob', `bob${i}`, i);
          bobOffers.push((await em.recent('bob', 50)).find((e) => e.tags.includes(`offer-ref:${ref}`))!.uri);
        }
        for (let i = 0; i < 3; i++) {
          await em.append({
            episodeType: 'choice-made', forUser: 'anna', factGraph: userGraph('anna'), sessionId: `forged${i}`,
            occurredAt: new Date(T0 + i * DAY), precededBy: bobOffers[i], tags: ['chosen:/model a'],
          });
        }
        const r = await job.run();
        expect(r.excluded.unlinkedChoices).toBe(3);
        expect(r.promoted).toBe(0);
        expect(await prefTriples()).toEqual([]);
      });

      it('the owner promotes into the owner user graph, never the worldview', async () => {
        await threeChoices('owner');
        await job.run();
        expect((await prefTriples()).map((t) => t.g)).toEqual([userGraph('owner')]);
      });

      it('promotes into the recorded fact graph, not the cognitive key\'s graph', async () => {
        for (let i = 0; i < 3; i++) {
          const ref = await offer('owner', `fg${i}`, i, AB, { factGraph: userGraph('u-7') });
          await capture.recordChoice({ forUser: 'owner', offerRef: ref, callbackData: '/model a', now: new Date(T0 + i * DAY + 1000) });
        }
        expect((await job.run()).promoted).toBe(1);
        const triples = await prefTriples();
        expect(triples.map((t) => t.g)).toEqual([userGraph('u-7')]);
        expect(triples[0].s).toBe(userEntityUri('u-7'));
      });
    });

    describe('exclusions', () => {
      it('choices without a recorded fact graph are never promoted from', async () => {
        for (let i = 0; i < 3; i++) {
          const ref = await offer('anna', `nf${i}`, i, AB, { factGraph: undefined });
          await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a', now: new Date(T0 + i * DAY + 1000) });
        }
        const r = await job.run();
        expect(r.excluded.noFactGraphEpisodes).toBe(3);
        expect(r.promoted).toBe(0);
      });

      it('a fact graph that is not one of this agent\'s user graphs is refused', async () => {
        for (let i = 0; i < 3; i++) {
          const ref = await offer('anna', `bg${i}`, i, AB, { factGraph: 'urn:other:user:anna' });
          await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a', now: new Date(T0 + i * DAY + 1000) });
        }
        const r = await job.run();
        expect(r.excluded.noFactGraphEpisodes).toBe(3);
        expect(r.promoted).toBe(0);
      });

      it('choices of an untrusted session are excluded, and the mark spreads to its episodes', async () => {
        await choose('anna', 'a1', 0, '/model a');
        await choose('anna', 'a2', 1, '/model a');
        const ref = await offer('anna', 'dry', 2, AB, { sessionUntrusted: true });
        await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a', now: new Date(T0 + 2 * DAY + 1000) });
        const r = await job.run();
        expect(r.excluded.untrustedEpisodes).toBe(1);
        expect(r.promoted).toBe(0);
      });

      it('a secret-classed offer is excluded', async () => {
        await choose('anna', 'a1', 0, '/model a');
        await choose('anna', 'a2', 1, '/model a');
        const ref = await offer('anna', 'a3', 2, AB, { secret: true });
        await capture.recordChoice({ forUser: 'anna', offerRef: ref, callbackData: '/model a', now: new Date(T0 + 2 * DAY + 1000) });
        const r = await job.run();
        expect(r.excluded.secretEpisodes).toBe(1);
        expect(r.promoted).toBe(0);
      });

      it('a choice without a usable offer link is excluded', async () => {
        for (let i = 0; i < 3; i++) {
          await em.append({
            episodeType: 'choice-made', forUser: 'anna', factGraph: userGraph('anna'), sessionId: `x${i}`,
            occurredAt: new Date(T0 + i * DAY), tags: ['chosen:/model a'],
          });
        }
        const r = await job.run();
        expect(r.excluded.unlinkedChoices).toBe(3);
        expect(r.promoted).toBe(0);
      });
    });

    it('is bounded: promotions per user and run are capped', async () => {
      for (let t = 0; t < 22; t++) {
        const alts = [`/pick ${t} a`, `/pick ${t} b`];
        for (let i = 0; i < 3; i++) await choose('anna', `b${t}_${i % 2}`, i, alts[0], alts);
      }
      const r = await job.run();
      expect(r.promoted).toBe(20);
      expect(r.deferred).toBe(2);
      const again = await job.run();
      expect(again.promoted).toBe(2);
    }, 120_000);
  });

  describe('vocabulary', () => {
    it('core:preference is declared in the TBox with a label and a comment', async () => {
      const ttl = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'ontologies', 'ontofelia-core.ttl'), 'utf8');
      const block = ttl.slice(ttl.indexOf('core:preference rdf:type'));
      expect(block).toContain('owl:DatatypeProperty');
      expect(block.slice(0, block.indexOf(' .\n'))).toMatch(/rdfs:label "preference"[\s\S]*rdfs:comment/);
      expect(CORE_PREFERENCE_PREDICATE).toBe(`${CORE}preference`);
    });
  });
});
