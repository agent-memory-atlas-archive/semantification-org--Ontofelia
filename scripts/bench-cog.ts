/**
 * Micro-benchmark for the cognitive layer's hot paths.
 *
 *   LOG_LEVEL=silent npx tsx scripts/bench-cog.ts [--traces N] [--episodes M] [--appends K] [--cycles C]
 *
 * Defaults are small (200 traces, 1000 episodes, 200 appends, 30 cycles). Needs
 * the packages built (`pnpm turbo run build`). Always run it under a memory cap:
 *
 *   systemd-run --user --scope -p MemoryMax=4G env LOG_LEVEL=silent npx tsx scripts/bench-cog.ts
 *
 * What it measures, against the embedded Oxigraph store (the in-memory adapter
 * has no SPARQL):
 *  - episode append latency (p50/p95/max) with M episodes already in the graph,
 *    next to the cost of the three full-graph reads the previous implementation
 *    made on every append;
 *  - the reply-path latency of one cycle with a mock core: cycle manager off,
 *    on with persistence queued, and on with persistence awaited;
 *  - procedural consolidation over N traces, and a second run that finds nothing.
 *
 * Budgets are printed as information; nothing here fails the build or the tests.
 * Seeding goes through one bulk load per graph (an `update` re-writes the whole
 * dataset to disk, so seeding thousands of rows one by one would be quadratic).
 */

import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OxigraphAdapter,
  GraphRegistry,
  EpisodicMemory,
  ProceduralMemory,
} from '../packages/semantic-memory/dist/index.js';
import { CycleManager } from '../packages/agent-runtime/dist/cognitive/CycleManager.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a non-negative number`);
  return Math.floor(n);
}

const N_TRACES = arg('traces', 200);
const M_EPISODES = arg('episodes', 1000);
const K_APPENDS = arg('appends', 200);
const C_CYCLES = arg('cycles', 30);

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] ?? 0 };
}
const ms = (x: number) => `${x.toFixed(2)} ms`;
const line = (label: string, s: ReturnType<typeof stats>) =>
  console.log(`  ${label.padEnd(44)} n=${String(s.n).padStart(5)}  p50=${ms(s.p50).padStart(10)}  p95=${ms(s.p95).padStart(10)}  max=${ms(s.max).padStart(10)}`);

async function time<T>(fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-cog-'));
  const store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
  const registry = GraphRegistry.create([AGENT]);
  const em = new EpisodicMemory(store, AGENT);
  const pm = new ProceduralMemory(store, AGENT, registry);

  console.log(`bench-cog  traces=${N_TRACES} episodes=${M_EPISODES} appends=${K_APPENDS} cycles=${C_CYCLES}`);
  console.log(`machine    ${os.cpus()[0]?.model ?? 'cpu'} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM, node ${process.version}`);

  // --- Seed -------------------------------------------------------------
  const t0 = Date.UTC(2026, 8, 1);
  const epLines: string[] = [];
  const SESSIONS = Math.max(1, Math.ceil(M_EPISODES / 25));
  for (let i = 0; i < M_EPISODES; i++) {
    const u = `<urn:${AGENT}:cog:ep:seed${i}>`;
    const when = new Date(t0 + i * 60_000).toISOString();
    epLines.push(
      `${u} a <${COGT}Episode> ; <${COGT}episodeId> "ep_seed_${String(i).padStart(7, '0')}" ; <${COGT}episodeType> "message-received" ;`,
      `  <${COGT}occurredAt> "${when}"^^<${XSD}dateTime> ; <${COGT}salience> "0.6"^^<${XSD}decimal> ; <${COGT}sessionId> "seed-s${i % SESSIONS}" ;`,
      `  <${COGT}forUser> "urn:${AGENT}:user:u${i % 5}" ; <${COGT}payload> "seed message ${i} about topic ${i % 40}" ;`,
      `  <${COGT}about> <urn:entity:E${i % 50}> , <urn:entity:E${(i + 7) % 50}> ; <${COGT}tags> "t${i % 9}" .`,
    );
  }
  const trLines: string[] = [];
  for (let i = 0; i < N_TRACES; i++) {
    const u = `<urn:${AGENT}:cog:trace:seed${i}>`;
    const when = new Date(t0 + i * 30_000).toISOString();
    trLines.push(
      `${u} a <${COGT}SkillTrace> ; <${COGT}traceId> "tr_seed_${i}" ; <${COGT}toolName> "tool${i % 7}" ;`,
      `  <${COGT}executedAt> "${when}"^^<${XSD}dateTime> ; <${COGT}durationMs> "${10 + (i % 90)}"^^<${XSD}integer> ;`,
      `  <${COGT}outcome> "${i % 5 === 4 ? 'error' : 'success'}" ; <${COGT}forGoalType> "${COGT}AnswerQuestion" ;`,
      `  <${COGT}cycleId> "seedcyc${Math.floor(i / 3)}" ; <${COGT}sequencePos> "${(i % 3) + 1}"^^<${XSD}integer> .`,
    );
  }
  const seedMs = await time(async () => {
    if (epLines.length) await store.putGraph(em.graphUri(), epLines.join('\n'));
    if (trLines.length) await store.putGraph(pm.graphUri(), trLines.join('\n'));
  });
  console.log(`seed       ${M_EPISODES} episodes + ${N_TRACES} traces in ${ms(seedMs)} (bulk load)`);

  // --- Episode append ---------------------------------------------------
  console.log('\nepisode append (session of growing size, M episodes elsewhere in the graph)');
  const appendMs: number[] = [];
  for (let i = 0; i < K_APPENDS; i++) {
    appendMs.push(
      await time(() =>
        em.append({
          episodeType: 'message-received',
          sessionId: 'bench-session',
          forUser: `urn:${AGENT}:user:u0`,
          payload: `bench message ${i}`,
          about: ['urn:entity:E1'],
          tags: ['bench'],
        }),
      ),
    );
  }
  const a = stats(appendMs);
  line('append (current)', a);

  // The three full-graph reads the previous append did, for comparison.
  const graph = em.graphUri();
  const legacyRead = async () => {
    await store.query(`SELECT ?ep ?episodeId ?type ?when ?salience ?sessionId WHERE { GRAPH <${graph}> {
      ?ep a <${COGT}Episode> ; <${COGT}episodeId> ?episodeId ; <${COGT}episodeType> ?type ; <${COGT}occurredAt> ?when ; <${COGT}salience> ?salience .
      ?ep <${COGT}sessionId> "bench-session" . OPTIONAL { ?ep <${COGT}sessionId> ?sessionId } } }`);
    for (const p of ['about', 'tags']) {
      await store.query(`SELECT ?ep ?v WHERE { GRAPH <${graph}> { ?ep a <${COGT}Episode> ; <${COGT}${p}> ?v } }`);
    }
  };
  const legacy: number[] = [];
  for (let i = 0; i < Math.min(K_APPENDS, 50); i++) legacy.push(await time(legacyRead));
  line('previous per-append reads only (no write)', stats(legacy));
  // The store's own floor: one-triple insert, which for this adapter includes
  // re-writing the whole dataset to disk.
  const floor: number[] = [];
  for (let i = 0; i < Math.min(K_APPENDS, 50); i++) {
    floor.push(await time(() => store.update(`INSERT DATA { GRAPH <urn:bench:floor> { <urn:bench:s> <urn:bench:p> "${i}" . } }`)));
  }
  line('store floor: one-triple update incl. disk flush', stats(floor));

  // --- Cycle overhead ---------------------------------------------------
  console.log('\ncycle reply-path latency, mock core (resolves immediately)');
  const envelope = (i: number) => ({
    id: `m${i}`, channel: 'webchat', accountId: 'a', chatType: 'web',
    sender: { id: 'user:owner', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(), text: `what is item ${i}?`, mentions: [], attachments: [],
  });
  const core = async () => ({ text: 'ok', sessionId: 'bench-cycle-session' });
  const sid = (r: { sessionId: string }) => r.sessionId;

  const off: number[] = [];
  for (let i = 0; i < C_CYCLES; i++) off.push(await time(() => core()));
  line('cycle manager off (core only)', stats(off));

  const queuedCm = new CycleManager(store, registry, AGENT);
  const queued: number[] = [];
  const flush: number[] = [];
  for (let i = 0; i < C_CYCLES; i++) {
    queued.push(await time(() => queuedCm.runCycle(envelope(i) as never, core, sid, (r) => r.text, { episodicEnabled: true })));
    flush.push(await time(() => queuedCm.flushPending()));
  }
  line('cycle manager on, persist queued (reply path)', stats(queued));
  line('  queued persist, time to drain', stats(flush));

  const awaitedCm = new CycleManager(store, registry, AGENT, undefined, { awaitPersist: true });
  const awaited: number[] = [];
  for (let i = 0; i < C_CYCLES; i++) {
    awaited.push(await time(() => awaitedCm.runCycle(envelope(i) as never, core, sid, (r) => r.text, { episodicEnabled: true })));
  }
  line('cycle manager on, persist awaited (old path)', stats(awaited));

  const fullCm = new CycleManager(store, registry, AGENT);
  const full: number[] = [];
  for (let i = 0; i < C_CYCLES; i++) {
    full.push(await time(() => fullCm.runCycle(envelope(i) as never, core, sid, (r) => r.text, {
      episodicEnabled: true, goalsEnabled: true, proceduralEnabled: true, metacognitionEnabled: true, selfModelEnabled: true,
    })));
    await fullCm.flushPending();
  }
  line('all flags on, persist queued (reply path)', stats(full));

  // --- Consolidation ----------------------------------------------------
  console.log('\nprocedural consolidation');
  const until = new Date(t0 + (N_TRACES + 1) * 30_000);
  let rep1: Awaited<ReturnType<typeof pm.consolidateIncremental>> | undefined;
  const c1 = await time(async () => { rep1 = await pm.consolidateIncremental({ until, firstWindowMs: 3650 * 86_400_000 }); });
  let rep2: Awaited<ReturnType<typeof pm.consolidateIncremental>> | undefined;
  const c2 = await time(async () => { rep2 = await pm.consolidateIncremental({ until }); });
  console.log(`  first run:  ${ms(c1)}, scanned ${rep1?.tracesScanned}, skills ${rep1?.skillsUpserted}`);
  console.log(`  second run: ${ms(c2)}, scanned ${rep2?.tracesScanned}`);

  // --- Budgets (information only) ----------------------------------------
  const rssMiB = process.resourceUsage().maxRSS / 1024;
  console.log('\nbudgets (informational, not enforced)');
  console.log(`  episode append p95 < 50 ms:                 ${a.p95 < 50 ? 'within' : 'over'} (${ms(a.p95)})`);
  const q = stats(queued);
  const o = stats(off);
  console.log(`  queued cycle adds < 5 ms at p95 over core:  ${q.p95 - o.p95 < 5 ? 'within' : 'over'} (+${ms(q.p95 - o.p95)})`);
  console.log(`peak RSS    ${rssMiB.toFixed(0)} MiB`);

  await store.stop().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
