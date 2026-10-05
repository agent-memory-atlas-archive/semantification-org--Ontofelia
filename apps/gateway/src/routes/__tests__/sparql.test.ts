import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OxigraphAdapter, InProcessQueryExecutor } from '@ontofelia/semantic-memory';
import type { SparqlResult, RdfTerm } from '@ontofelia/core';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import memoryRoutes from '../memory.js';
import type { GatewayContext } from '../../context.js';

const ABOX = 'urn:ontofelia:agent:ontofelia:abox';
const EX = 'http://example.org/';

interface OxiTerm { termType: string; value: string }
interface OxiStore { query(q: string, opts?: { use_default_graph_as_union?: boolean }): unknown }

/**
 * Oxigraph adapter whose default graph is the union of all graphs, like a
 * backend configured with a union default graph. Used as a second, differently
 * built control for the "no triple pattern outside GRAPH" rule.
 */
class UnionDefaultGraphAdapter extends OxigraphAdapter {
  async query(sparql: string): Promise<SparqlResult> {
    const store = (this as unknown as { store: OxiStore }).store;
    const result = store.query(sparql, { use_default_graph_as_union: true });
    if (typeof result === 'boolean') return { type: 'boolean', boolean: result };
    const rows = result as Map<string, OxiTerm>[];
    const bindings = rows.map((row) => {
      const out: Record<string, RdfTerm> = {};
      for (const [key, term] of row.entries()) {
        out[key] = { type: term.termType === 'NamedNode' ? 'uri' : term.termType === 'BlankNode' ? 'bnode' : 'literal', value: term.value };
      }
      return out;
    });
    return { type: 'bindings', variables: rows.length ? [...rows[0].keys()] : [], bindings };
  }
}

describe('POST /api/knowledge/sparql', () => {
  let app: FastifyInstance;
  let store: OxigraphAdapter;
  let dataDir: string;

  const post = (query: unknown) =>
    app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query } });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-route-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    await store.insertTriples(ABOX, [
      { subject: EX + 'a', predicate: EX + 'knows', object: EX + 'b' },
      { subject: EX + 'a', predicate: EX + 'name', object: { value: 'Alice' } },
    ]);
    await store.insertTriples('urn:ontofelia:user:alice', [
      { subject: EX + 'secret', predicate: EX + 'knows', object: EX + 'x' },
    ]);
    await store.insertTriples('urn:ontofelia:bulk', Array.from({ length: 1005 }, (_, i) => ({
      subject: EX + 'bulk/' + i, predicate: EX + 'kind', object: EX + 'Bulk',
    })));

    app = Fastify();
    await app.register(memoryRoutes, { triplestore: store } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns rows for SELECT', async () => {
    const res = await post(`SELECT ?o WHERE { GRAPH <${ABOX}> { <${EX}a> <${EX}knows> ?o } }`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: 'bindings',
      variables: ['o'],
      bindings: [{ o: { type: 'uri', value: EX + 'b' } }],
      truncated: false,
    });
  });

  it('returns a boolean for ASK', async () => {
    const yes = await post(`ASK { GRAPH <${ABOX}> { <${EX}a> <${EX}knows> <${EX}b> } }`);
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toEqual({ type: 'boolean', boolean: true });
    const no = await post(`ASK { GRAPH <${ABOX}> { <${EX}a> <${EX}knows> <${EX}zzz> } }`);
    expect(no.json()).toEqual({ type: 'boolean', boolean: false });
  });

  it('rejects non-SELECT/ASK forms with 400', async () => {
    for (const q of [
      `INSERT DATA { GRAPH <${ABOX}> { <${EX}x> <${EX}p> <${EX}y> } }`,
      `DELETE WHERE { GRAPH <${ABOX}> { ?s ?p ?o } }`,
      `DROP GRAPH <${ABOX}>`,
      'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }',
      `DESCRIBE <${EX}a>`,
    ]) {
      const res = await post(q);
      expect(res.statusCode, q).toBe(400);
    }
    // The data is still there
    const check = await post(`ASK { GRAPH <${ABOX}> { <${EX}a> <${EX}knows> <${EX}b> } }`);
    expect(check.json().boolean).toBe(true);
  });

  it('rejects unparseable queries and bad bodies with 400', async () => {
    expect((await post('SELECT WHERE {')).statusCode).toBe(400);
    // A regex for "SELECT ... WHERE {...}" would accept this; the parser does not.
    expect((await post('SELECT * WHERE { ?s ?p ?o } garbage')).statusCode).toBe(400);
    expect((await post('SELECT * WHERE { ?s ?p }')).statusCode).toBe(400);
    expect((await post(42)).statusCode).toBe(400);
    expect((await post('')).statusCode).toBe(400);
    const noBody = await app.inject({ method: 'POST', url: '/api/knowledge/sparql' });
    expect(noBody.statusCode).toBe(400);
  });

  it('rejects SERVICE nested in OPTIONAL with 400', async () => {
    const res = await post('SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o OPTIONAL { SERVICE <http://example.org/sparql> { ?s ?q ?r } } }');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/SERVICE/);
  });

  it('rejects graph scoping violations with 403', async () => {
    const queries = [
      'SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }',
      'SELECT * WHERE { GRAPH <urn:ontofelia:user:alice> { ?s ?p ?o } }',
      'SELECT * FROM <urn:ontofelia:session:x> WHERE { ?s ?p ?o }',
      'SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o FILTER EXISTS { GRAPH <urn:ontofelia:user:a> { ?x ?y ?z } } }',
      'SELECT * WHERE { { SELECT * WHERE { GRAPH <urn:ontofelia:user:a> { ?x ?y ?z } } } }',
    ];
    for (const q of queries) {
      const res = await post(q);
      expect(res.statusCode, q).toBe(403);
    }
  });

  it('allows an explicit non-private graph and returns data', async () => {
    const res = await post(`SELECT ?s ?o WHERE { GRAPH <${ABOX}> { ?s <${EX}knows> ?o } }`);
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toHaveLength(1);
  });

  it('rejects triple patterns outside GRAPH unless FROM names the default graph', async () => {
    const noGraph = await post(`SELECT ?o WHERE { <${EX}a> <${EX}knows> ?o }`);
    expect(noGraph.statusCode).toBe(400);
    expect(noGraph.json().error).toMatch(/FROM or GRAPH/);

    const mixed = await post(
      `SELECT ?o WHERE { GRAPH <${ABOX}> { <${EX}a> <${EX}knows> ?o } FILTER EXISTS { ?x ?y ?z } }`);
    expect(mixed.statusCode).toBe(400);

    const fromNamedOnly = await post(`SELECT ?o FROM NAMED <${ABOX}> WHERE { <${EX}a> <${EX}knows> ?o }`);
    expect(fromNamedOnly.statusCode).toBe(400);

    const withFrom = await post(`SELECT ?o FROM <${ABOX}> WHERE { <${EX}a> <${EX}knows> ?o }`);
    expect(withFrom.statusCode).toBe(200);
    expect(withFrom.json().bindings).toEqual([{ o: { type: 'uri', value: EX + 'b' } }]);
  });

  it('caps SELECT at 1000 rows and flags truncation', async () => {
    const res = await post(`SELECT ?s WHERE { GRAPH <urn:ontofelia:bulk> { ?s <${EX}kind> ?o } }`);
    expect(res.statusCode).toBe(200);
    expect(res.json().bindings).toHaveLength(1000);
    expect(res.json().truncated).toBe(true);
  });

  it('respects a smaller user LIMIT and does not raise a larger one', async () => {
    const small = await post(`SELECT ?s WHERE { GRAPH <urn:ontofelia:bulk> { ?s <${EX}kind> ?o } } LIMIT 5`);
    expect(small.json().bindings).toHaveLength(5);
    expect(small.json().truncated).toBe(false);
    const big = await post(`SELECT ?s WHERE { GRAPH <urn:ontofelia:bulk> { ?s <${EX}kind> ?o } } LIMIT 5000`);
    expect(big.json().bindings).toHaveLength(1000);
    expect(big.json().truncated).toBe(true);
  });
});

describe('POST /api/knowledge/sparql with a union default graph backend', () => {
  let app: FastifyInstance;
  let store: UnionDefaultGraphAdapter;
  let dataDir: string;
  const secretQuery = `SELECT ?o WHERE { <${EX}secret> <${EX}knows> ?o }`;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-union-'));
    store = new UnionDefaultGraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    await store.insertTriples('urn:ontofelia:user:alice', [
      { subject: EX + 'secret', predicate: EX + 'knows', object: EX + 'x' },
    ]);
    app = Fastify();
    await app.register(memoryRoutes, { triplestore: store, sparqlExecutor: new InProcessQueryExecutor(store) } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('positive control: the wrapped adapter really unions the graphs', async () => {
    const direct = await store.query(secretQuery);
    expect(direct.bindings).toEqual([{ o: { type: 'uri', value: EX + 'x' } }]);
  });

  it('refuses the graph-less query instead of leaking the user graph', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query: secretQuery } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).not.toContain(EX + 'x');
  });
});

describe('POST /api/knowledge/sparql authentication', () => {
  let gateway: FastifyInstance;

  beforeAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    gateway = await startGateway(config);
  });

  afterAll(async () => {
    await gateway.close();
  });

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
  });

  it('rejects requests without a token', async () => {
    const res = await gateway.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query: 'ASK { GRAPH <urn:shared:ontology> { ?s ?p ?o } }' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong token', async () => {
    const res = await gateway.inject({
      method: 'POST', url: '/api/knowledge/sparql',
      headers: { authorization: 'Bearer wrong' }, payload: { query: 'ASK { GRAPH <urn:shared:ontology> { ?s ?p ?o } }' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts requests with the token', async () => {
    const res = await gateway.inject({
      method: 'POST', url: '/api/knowledge/sparql',
      headers: { authorization: 'Bearer test-secret' }, payload: { query: 'ASK { GRAPH <urn:shared:ontology> { ?s ?p ?o } }' },
    });
    expect(res.statusCode).toBe(200);
  });
});
