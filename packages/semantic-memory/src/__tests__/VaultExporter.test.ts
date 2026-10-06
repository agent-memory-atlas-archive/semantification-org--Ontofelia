/**
 * buildVaultExport: allow-list selection (accepted tool claims whose base
 * triple is still in the worldview), rendering, determinism, round trip into
 * the mapper. Real engine on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { importVault } from '../ingestion/VaultImporter.js';
import { mapVaultNote } from '../ingestion/VaultNoteMapper.js';
import { buildVaultExport, sanitizeFileName, type VaultExportReport } from '../export/VaultExporter.js';

const AGENT = 'ontofelia';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');
const CANARIES = ['Cologne', 'livesIn', 'SecretCanary', 'OrphanCanary', 'RetiredCanary', 'SelfCanary', 'InferredCanary'];

/** Returns the canaries found anywhere in a report's note paths and contents. */
function leakedCanaries(report: { notes: { path: string; content: string }[] }): string[] {
  const all = report.notes.map(n => `${n.path}\n${n.content}`).join('\n');
  return CANARIES.filter(c => all.includes(c));
}

let report: VaultExportReport;
let engine: KnowledgeEngine;
let store: OxigraphAdapter;

beforeAll(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'vexp-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  const imp = await importVault(engine, { root: FIXTURE, vaultName: 'demo', agentId: AGENT, apply: true });
  expect(imp.totals.stored).toBeGreaterThan(0);

  const ctx = { agentId: AGENT, sessionId: 's1', isOwner: false, userId: 'alice' };
  // (a) third-party, user-sourced fact: lands in the worldview, claim says "user"
  await engine.storeFact({ subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
    objectType: 'Concept', sourceKind: 'user', status: 'accepted' } as never, ctx);
  // (b) owner fact about "me": routed to alice's user graph
  await engine.storeFact({ subject: 'me', subjectType: 'Person', predicate: 'secretNote', object: 'SecretCanary',
    objectType: 'literal', sourceKind: 'user', status: 'accepted' } as never, { ...ctx, isOwner: true });
  // (d) tool claim whose base triple is then removed from the worldview
  await engine.storeFact({ subject: 'hummus', subjectType: 'Concept', predicate: 'retiredNote', object: 'RetiredCanary',
    objectType: 'literal', sourceKind: 'tool', status: 'accepted' } as never,
    { agentId: AGENT, sessionId: 's2', isOwner: false });
  const wv = `urn:${AGENT}:worldview`;
  const hummus = 'urn:ontofelia:entity:hummus';
  await store.update(`DELETE WHERE { GRAPH <${wv}> { <${hummus}> <urn:ontofelia:core#retiredNote> ?o } }`);
  // (c) worldview triple without any claim
  await store.update(`INSERT DATA { GRAPH <${wv}> { <${hummus}> <urn:ontofelia:core#orphanNote> "OrphanCanary" } }`);
  // (e) self and inferred graphs
  await store.update(`INSERT DATA {
    GRAPH <urn:${AGENT}:self> { <${hummus}> <urn:ontofelia:core#selfNote> "SelfCanary" }
    GRAPH <urn:${AGENT}:inferred> { <${hummus}> <urn:ontofelia:core#inferredNote> "InferredCanary" } }`);

  report = await buildVaultExport(engine, { agentId: AGENT });
});

describe('buildVaultExport', () => {
  it('exports nothing outside the allow-list (no canary anywhere)', () => {
    expect(leakedCanaries(report)).toEqual([]);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('the canary check is not vacuous: it reports a crafted leak', () => {
    const crafted = { notes: [{ path: 'Untyped/x.md', content: '---\nsecretNote: SecretCanary\n---\n' }] };
    expect(leakedCanaries(crafted)).toEqual(['SecretCanary']);
  });

  it('canaries really sit in the store (so their absence is selection, not emptiness)', async () => {
    const r: any = await store.query(`SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o }
      FILTER(?o IN ("Cologne","SecretCanary","OrphanCanary","SelfCanary","InferredCanary") ||
             STRENDS(STR(?o), "Cologne")) }`);
    expect(r.bindings.length).toBeGreaterThanOrEqual(5);
    const claim: any = await store.query(`SELECT ?c WHERE { GRAPH <urn:${AGENT}:claims> {
      ?c <urn:shared:ontology#claimObject> "RetiredCanary" ; <urn:shared:ontology#sourceKind> "tool" } }`);
    expect(claim.bindings.length).toBe(1);
  });

  it('reports why claims were skipped', () => {
    expect(report.totals['skipped: sourceKind user']).toBeGreaterThanOrEqual(1);
    expect(report.totals['skipped: base triple missing']).toBe(1);
    expect(report.totals.claimsConsidered).toBe(report.totals.claimsExported + report.totals.claimsSkipped);
    expect(report.skipped.every(s => s.claim.length > 0 && s.reason.length > 0)).toBe(true);
  });

  it('renders the fixture notes', () => {
    const paths = report.notes.map(n => n.path);
    expect(paths).toEqual([...paths].sort());
    const byPath = new Map(report.notes.map(n => [n.path, n.content]));
    const hummus = byPath.get('Recipe/hummus.md')!;
    expect(hummus).toBeDefined();
    const fm = parse(hummus);
    expect(fm.type).toBe('[[Recipe]]');
    expect(fm.label).toBe('hummus');
    expect(fm.requiresIngredient).toBe('[[Chickpeas]]');
    expect(fm.difficulty).toBe('[[Beginner]]');
    expect(fm.prepTimeMinutes).toBe(25);
    expect(Object.keys(fm).slice(0, 2)).toEqual(['type', 'label']);
    expect(hummus.endsWith('---\n# hummus\n')).toBe(true);
    expect(parse(byPath.get('Ingredient/Chickpeas.md')!).type).toBe('[[Ingredient]]');
    expect(byPath.has('Concept/Beginner.md') || [...byPath.keys()].some(p => p.endsWith('/Beginner.md'))).toBe(true);
    // evidence text of the vault notes must not leak into bodies
    expect(hummus).not.toContain('smooth purée');
  });

  it('is deterministic', async () => {
    const again = await buildVaultExport(engine, { agentId: AGENT });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it('round-trips through mapVaultNote with the same predicate/object pairs', () => {
    for (const n of report.notes) {
      const fm = parse(n.content);
      const mapped = mapVaultNote({ path: n.path, frontmatter: fm, body: '', contentHash: 'sha256:x', vaultName: 'demo' });
      expect(mapped.refused).toBeUndefined();
      const pairs = mapped.facts.map(f => `${f.predicate}=${f.object}`).sort();
      const expected: string[] = [];
      for (const [k, v] of Object.entries(fm)) {
        for (const x of Array.isArray(v) ? v : [v]) {
          const s = String(x);
          const m = /^\[\[(.*)\]\]$/.exec(s);
          expected.push(`${k}=${m ? m[1] : s}`);
        }
      }
      expect(pairs).toEqual(expected.sort());
    }
  });
});

describe('sanitizeFileName', () => {
  it('removes forbidden characters, leading dots and long names', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFileName('..hidden')).toBe('hidden');
    expect(sanitizeFileName('x'.repeat(300)).length).toBe(120);
    expect(sanitizeFileName('...')).toBe('Unnamed');
  });
});

function parse(content: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content)!;
  return yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
}
