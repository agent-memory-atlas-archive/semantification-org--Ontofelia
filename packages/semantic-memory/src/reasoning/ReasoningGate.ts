/**
 * Reasoning gate: the operator setting that lets `storeFact` skip the
 * synchronous OWL materialisation on a large graph, and the durable "inferred
 * graphs are stale" marker a background catch-up reads.
 *
 * Why the setup graph (and not the gateway config file): the knowledge engine
 * has no access to the gateway config, the setup graph is the established home
 * of operator-tunable engine settings (the cognitive-layer keys live there),
 * it is re-read on every use so a change takes effect without a restart, and
 * only the owner can write it.
 *
 * Settings and marker are triples on one subject, `urn:<agent>:setup:reasoning`:
 *
 *   reasoning/asyncThreshold   integer >= 1: number of triples in the graphs the
 *                              reasoner reads (the "ABox") above which a stored
 *                              fact is not materialised synchronously. Absent,
 *                              0, negative, fractional or unparseable: never skip.
 *   reasoning/inferredStale    xsd:dateTime, written by the engine: since when
 *                              the inferred graphs may lag behind the facts.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { sparqlIri } from '../utils/SparqlSyntax.js';

export const REASONING_NS = 'urn:shared:ontology#reasoning/';

/** IRI of the per-agent reasoning-settings resource in the setup graph. */
export function reasoningSettingsSubject(agentId: string): string {
  return `urn:${agentId}:setup:reasoning`;
}

const ASYNC_THRESHOLD = `${REASONING_NS}asyncThreshold`;
const INFERRED_STALE = `${REASONING_NS}inferredStale`;

/**
 * Read `reasoning/asyncThreshold` from the setup graph. Returns 0 ("never
 * skip", today's behaviour) when the key is absent, not a positive integer, or
 * the read fails: a broken setting must never silently thin out the reasoning.
 */
export async function readAsyncThreshold(
  triplestore: TriplestoreAdapter,
  agentId: string,
): Promise<number> {
  try {
    const res = await triplestore.query(`
      SELECT ?v WHERE {
        GRAPH ${sparqlIri(GraphUriResolver.getSetupGraph(agentId))} {
          ${sparqlIri(reasoningSettingsSubject(agentId))} ${sparqlIri(ASYNC_THRESHOLD)} ?v
        }
      } LIMIT 1`);
    const raw = res.type === 'bindings' ? res.bindings?.[0]?.v?.value : undefined;
    if (raw === undefined || raw.trim() === '') return 0;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 1 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Write (or, with `null`, remove) `reasoning/asyncThreshold`. Only a positive
 * integer turns the gate on; anything else is rejected rather than stored, so
 * the stored value is always one `readAsyncThreshold` reads back unchanged.
 */
export async function writeAsyncThreshold(
  triplestore: TriplestoreAdapter,
  assertWritable: (graph: string) => string,
  agentId: string,
  threshold: number | null,
): Promise<void> {
  if (threshold !== null && !(Number.isSafeInteger(threshold) && threshold >= 1)) {
    throw new Error('asyncThreshold must be a positive integer, or null to turn the gate off');
  }
  const graph = sparqlIri(assertWritable(GraphUriResolver.getSetupGraph(agentId)));
  const subject = sparqlIri(reasoningSettingsSubject(agentId));
  const predicate = sparqlIri(ASYNC_THRESHOLD);
  await triplestore.update(`DELETE WHERE { GRAPH ${graph} { ${subject} ${predicate} ?v } }`);
  if (threshold !== null) {
    await triplestore.update(`INSERT DATA { GRAPH ${graph} { ${subject} ${predicate}
      "${threshold}"^^<http://www.w3.org/2001/XMLSchema#integer> } }`);
  }
}

/**
 * Number of triples in `graphs` (the ABox the reasoner would read). A plain
 * COUNT over the in-memory store: far cheaper than the Turtle dump and the two
 * reasoner runs it is used to avoid. Returns `undefined` when it cannot be
 * measured, in which case the caller must not skip.
 */
export async function countTriples(
  triplestore: TriplestoreAdapter,
  graphs: string[],
): Promise<number | undefined> {
  try {
    const values = graphs.map((g) => sparqlIri(g)).join(' ');
    const res = await triplestore.query(
      `SELECT (COUNT(*) AS ?c) WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s ?p ?o } }`,
    );
    const raw = res.type === 'bindings' ? res.bindings?.[0]?.c?.value : undefined;
    const n = Number(raw);
    return raw !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Durable stale marker plus the in-process bookkeeping that makes catching up
 * race-free.
 *
 * Every skipped materialisation bumps `epoch`. A catch-up remembers the epoch
 * it started at and clears the marker only if it is unchanged when it
 * finishes: a fact skipped while the rebuild was running keeps the marker, so
 * the next run picks it up. Persisting is done once per stale period, not per
 * fact (every write to the store costs a full dump to disk), and all marker
 * writes go through one queue so a clear can never overtake a later mark.
 */
export class InferredStaleTracker {
  private readonly state = new Map<
    string,
    { loaded: boolean; since?: string; epoch: number; persist?: Promise<unknown> }
  >();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly assertWritable: (graph: string) => string,
  ) {}

  private entry(agentId: string) {
    let e = this.state.get(agentId);
    if (!e) {
      e = { loaded: false, epoch: 0 };
      this.state.set(agentId, e);
    }
    return e;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Load the persisted marker once per process. */
  private async load(agentId: string): Promise<void> {
    const e = this.entry(agentId);
    if (e.loaded) return;
    await this.enqueue(async () => {
      if (e.loaded) return;
      const res = await this.triplestore.query(`
        SELECT ?v WHERE {
          GRAPH ${sparqlIri(GraphUriResolver.getSetupGraph(agentId))} {
            ${sparqlIri(reasoningSettingsSubject(agentId))} ${sparqlIri(INFERRED_STALE)} ?v
          }
        } LIMIT 1`);
      const v = res.type === 'bindings' ? res.bindings?.[0]?.v?.value : undefined;
      if (e.since === undefined && v !== undefined) e.since = v;
      e.loaded = true;
    });
  }

  /** Since when the inferred graphs may be stale; `undefined` when they are current. */
  async staleSince(agentId: string): Promise<string | undefined> {
    await this.load(agentId);
    return this.entry(agentId).since;
  }

  /** The current epoch (see class comment). */
  epoch(agentId: string): number {
    return this.entry(agentId).epoch;
  }

  /**
   * Record that a skipped fact is now in the store. `markStale` runs before the
   * fact is inserted, so a catch-up that read the epoch in between could
   * rebuild from a graph without it; bumping the epoch again after the insert
   * makes that catch-up leave the marker set.
   */
  touch(agentId: string): void {
    this.entry(agentId).epoch++;
  }

  /**
   * Record that a materialisation is being skipped. Resolves `true` once the
   * marker is durable; `false` when it could not be written, in which case the
   * caller must materialise synchronously after all.
   */
  async markStale(agentId: string): Promise<boolean> {
    const e = this.entry(agentId);
    try {
      await this.load(agentId);
      e.epoch++;
      if (e.since !== undefined) {
        // Already stale: just make sure the write that made it so has landed.
        if (e.persist) await e.persist;
        return true;
      }
      const since = new Date().toISOString();
      e.since = since;
      const graph = this.assertWritable(GraphUriResolver.getSetupGraph(agentId));
      const persist = this.enqueue(() => this.triplestore.update(`
        INSERT DATA { GRAPH ${sparqlIri(graph)} {
          ${sparqlIri(reasoningSettingsSubject(agentId))} ${sparqlIri(INFERRED_STALE)}
            "${since}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
        } }`));
      e.persist = persist;
      try {
        await persist;
      } catch (err) {
        if (e.since === since) e.since = undefined;
        throw err;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the marker, but only when no fact was skipped since `epoch` was read.
   * Returns whether it was cleared.
   */
  async clearIfUnchanged(agentId: string, epoch: number): Promise<boolean> {
    const e = this.entry(agentId);
    if (e.epoch !== epoch) return false;
    // Synchronous with the check above: a mark arriving next sees "current"
    // and queues its own INSERT behind the DELETE below.
    const previous = e.since;
    e.since = undefined;
    try {
      const graph = this.assertWritable(GraphUriResolver.getSetupGraph(agentId));
      await this.enqueue(() => this.triplestore.update(`
        DELETE WHERE { GRAPH ${sparqlIri(graph)} {
          ${sparqlIri(reasoningSettingsSubject(agentId))} ${sparqlIri(INFERRED_STALE)} ?v
        } }`));
    } catch (err) {
      // The marker is still persisted: keep reporting stale.
      if (e.since === undefined) e.since = previous;
      throw err;
    }
    return true;
  }
}
