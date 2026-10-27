import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import { KnowledgeEngine } from '@ontofelia/semantic-memory';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..', 'packages', 'semantic-memory', 'src', '__tests__', 'fixtures', 'vault',
);
const AUTH = { authorization: 'Bearer test-secret' };
const URL_ = '/api/knowledge/vault-export';

type Exported = { notes: { path: string; content: string }[]; totals: Record<string, number> };

describe('GET /api/knowledge/vault-export', () => {
  let fastify: FastifyInstance;
  let tmpHome: string;
  const seen: KnowledgeEngine[] = [];
  let engine: KnowledgeEngine | undefined;
  const realHome = process.env.HOME;

  // The engine is not reachable through the HTTP surface, so the test captures the
  // gateway's own instance from its first export read and seeds private canaries
  // through it (a user-graph fact, a user-sourced worldview fact).
  const origSelect = KnowledgeEngine.prototype.selectExplicitGraphs;

  beforeAll(async () => {
    KnowledgeEngine.prototype.selectExplicitGraphs = function (this: KnowledgeEngine, ...a: Parameters<typeof origSelect>) {
      seen.push(this);
      return origSelect.apply(this, a);
    } as typeof origSelect;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    tmpHome = mkdtempSync(join(tmpdir(), 'gw-vexp-home-'));
    process.env.HOME = tmpHome;
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'oxigraph';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    KnowledgeEngine.prototype.selectExplicitGraphs = origSelect;
    await fastify.close();
    process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
  });

  const get = (url = URL_, headers: Record<string, string> = AUTH) =>
    fastify.inject({ method: 'GET', url, headers });

  it('rejects a request without token with 401 (global gate, no exemption)', async () => {
    expect((await get(URL_, {})).statusCode).toBe(401);
    expect((await get(URL_, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
  });

  it('returns the imported vault notes, and no private canary', async () => {
    // Claims with vault provenance via the importer, the same path the exporter tests use.
    const imp = await fastify.inject({
      method: 'POST', url: '/api/knowledge/vault-import', headers: AUTH,
      payload: { root: FIXTURE, vaultName: 'exportdemo', apply: true },
    });
    expect(imp.statusCode).toBe(200);

    // First read captures the engine; seed canaries, then read again.
    expect((await get()).statusCode).toBe(200);
    engine = seen[0];
    expect(engine).toBeDefined();
    const ctx = { agentId: 'ontofelia', sessionId: 's1', isOwner: false, userId: 'alice' };
    await engine!.storeFact({ subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
      objectType: 'Concept', sourceKind: 'user', status: 'accepted' } as never, ctx);
    await engine!.storeFact({ subject: 'me', subjectType: 'Person', predicate: 'secretNote', object: 'SecretCanary',
      objectType: 'literal', sourceKind: 'user', status: 'accepted' } as never, { ...ctx, isOwner: true });

    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json() as Exported;
    expect(Object.keys(body).sort()).toEqual(['notes', 'totals']);
    expect(body.notes.length).toBeGreaterThan(0);
    expect(body.notes.some(n => n.path === 'Recipe/hummus.md' || /^[^/]+\/hummus\.md$/i.test(n.path))).toBe(true);
    for (const n of body.notes) {
      expect(Object.keys(n).sort()).toEqual(['content', 'path']);
      expect(n.path).toMatch(/^[^/\\]+\/[^/\\]+\.md$/);
      expect(n.path.startsWith('..')).toBe(false);
    }
    const all = JSON.stringify(body);
    for (const canary of ['Cologne', 'livesIn', 'SecretCanary', 'secretNote']) expect(all).not.toContain(canary);

    // Not vacuous: the canaries really are in the store, claimed as user facts.
    const claims = await engine!.selectExplicitGraphs(`SELECT ?c WHERE { GRAPH <urn:ontofelia:claims> {
      ?c <urn:shared:ontology#claimObject> ?o ; <urn:shared:ontology#sourceKind> "user" .
      FILTER(CONTAINS(STR(?o), "Cologne") || CONTAINS(STR(?o), "SecretCanary")) } }`);
    expect(claims.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await get(`${URL_}?agentId=nobody`);
    expect(res.statusCode).toBe(404);
  });

  it('has no fs write path in the route source', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'memory.ts'), 'utf8');
    const start = src.indexOf("'/api/knowledge/vault-export'");
    const end = src.indexOf('// --- Ontology & Reasoning Endpoints ---');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = src.slice(start, end);
    expect(handler).not.toMatch(/\bfs\b|writeVault|writeFile|mkdir|createWriteStream|body\b|\.dir\b|\.root\b/);
  });

  it('is read-only: ignores a directory parameter, answers pure JSON, creates no file', async () => {
    const probe = mkdtempSync(join(tmpdir(), 'gw-vexp-probe-'));
    try {
      const res = await get(`${URL_}?dir=${encodeURIComponent(probe)}&root=${encodeURIComponent(probe)}`);
      expect(res.statusCode).toBe(200);
      expect(() => JSON.parse(res.body)).not.toThrow();
      expect(readdirSync(probe)).toEqual([]);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });
});
