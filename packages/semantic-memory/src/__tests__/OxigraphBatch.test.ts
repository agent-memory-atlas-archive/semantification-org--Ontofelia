/**
 * Perf — coalesce Oxigraph flushes so `storeFact()` persists once.
 *
 * `OxigraphAdapter.flush()` serialises the FULL in-memory dataset to disk on
 * every mutating call (`update`, `putGraph`, `importDataset`, `restore`) —
 * at 270k triples that is ~600ms. `KnowledgeEngine.storeFact()` used to
 * trigger several of those writes (base triple, owl:sameAs, inferred
 * triples, evidence, claim), so one fact cost several full-dataset
 * serialisations.
 *
 * `batch(fn)` coalesces all writes `fn` performs into a single `flush()`
 * when the OUTERMOST batch ends. This suite pins:
 *   - outside a batch, writes still flush individually (no behaviour change
 *     for callers that never use batch());
 *   - inside a batch, N writes produce exactly 1 flush, and the data on disk
 *     reflects all of them once the batch ends;
 *   - nested batches still produce exactly 1 flush;
 *   - an exception inside the batch still leaves the dirty state persisted
 *     (same "disk matches memory after a partial failure" behaviour as
 *     before), and propagates the error;
 *   - `KnowledgeEngine.storeFact()` against a real OxigraphAdapter now
 *     flushes at most once per call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

async function makeAdapter(dataDir: string): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('OxigraphAdapter.batch() — flush coalescing', () => {
  let dataDir: string;
  let adapter: OxigraphAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-oxbatch-'));
    adapter = await makeAdapter(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('outside a batch, two update() calls flush twice', async () => {
    const flushSpy = vi.spyOn(adapter as unknown as { flush(): Promise<void> }, 'flush');

    await adapter.update(`INSERT DATA { <urn:s1> <urn:p1> "a" . }`);
    await adapter.update(`INSERT DATA { <urn:s2> <urn:p2> "b" . }`);

    expect(flushSpy).toHaveBeenCalledTimes(2);
  });

  it('inside a batch, three update() calls flush exactly once, and all three land on disk', async () => {
    const flushSpy = vi.spyOn(adapter as unknown as { flush(): Promise<void> }, 'flush');

    await adapter.batch(async () => {
      await adapter.update(`INSERT DATA { <urn:s1> <urn:p1> "a" . }`);
      await adapter.update(`INSERT DATA { <urn:s2> <urn:p2> "b" . }`);
      await adapter.update(`INSERT DATA { <urn:s3> <urn:p3> "c" . }`);
    });

    expect(flushSpy).toHaveBeenCalledTimes(1);

    const dataFile = path.join(dataDir, 'dataset.nq');
    const onDisk = await fs.readFile(dataFile, 'utf-8');
    expect(onDisk).toContain('urn:s1');
    expect(onDisk).toContain('urn:s2');
    expect(onDisk).toContain('urn:s3');
  });

  it('a nested batch still flushes exactly once, on the outermost exit', async () => {
    const flushSpy = vi.spyOn(adapter as unknown as { flush(): Promise<void> }, 'flush');

    await adapter.batch(async () => {
      await adapter.update(`INSERT DATA { <urn:s1> <urn:p1> "a" . }`);
      await adapter.batch(async () => {
        await adapter.update(`INSERT DATA { <urn:s2> <urn:p2> "b" . }`);
      });
      await adapter.update(`INSERT DATA { <urn:s3> <urn:p3> "c" . }`);
    });

    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('when fn throws, the error propagates and the dirty state is still flushed once', async () => {
    const flushSpy = vi.spyOn(adapter as unknown as { flush(): Promise<void> }, 'flush');

    await expect(
      adapter.batch(async () => {
        await adapter.update(`INSERT DATA { <urn:s1> <urn:p1> "a" . }`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(flushSpy).toHaveBeenCalledTimes(1);

    const dataFile = path.join(dataDir, 'dataset.nq');
    const onDisk = await fs.readFile(dataFile, 'utf-8');
    expect(onDisk).toContain('urn:s1');
  });
});

describe('KnowledgeEngine.storeFact() — flushes at most once on Oxigraph', () => {
  const AGENT = 'ontofelia';
  let dataDir: string;
  let adapter: OxigraphAdapter;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-oxbatch-ke-'));
    adapter = await makeAdapter(dataDir);
    engine = new KnowledgeEngine(adapter as never);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('storeFact() triggers at most one flush per call', async () => {
    const flushSpy = vi.spyOn(adapter as unknown as { flush(): Promise<void> }, 'flush');

    const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's1', isOwner: false };
    const result = await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: 'Hamburg', objectType: 'Place', sourceKind: 'user' },
      ctx,
    );

    expect(result.success).toBe(true);
    // Baseline on 31cc1e1 (before this change): measured separately — see
    // the perf change's commit message / ticket for the exact pre-change
    // count. After this change it must never exceed one.
    expect(flushSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('storeFact() still durably persists the fact (single flush is not a no-op)', async () => {
    const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's1', isOwner: false };
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: 'Hamburg', objectType: 'Place', sourceKind: 'user' },
      ctx,
    );

    const dataFile = path.join(dataDir, 'dataset.nq');
    const onDisk = await fs.readFile(dataFile, 'utf-8');
    expect(onDisk).toContain('Hamburg');
  });
});
