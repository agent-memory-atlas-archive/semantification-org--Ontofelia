import { describe, it, expect } from 'vitest';
import { Parser } from 'sparqljs';
import { checkQueryAst, httpReadableGraphs } from '../sparqlGuard.js';

const ALLOWED = httpReadableGraphs(['ontofelia']);
const check = (q: string) => checkQueryAst(new Parser().parse(q), ALLOWED);

describe('sparqlGuard', () => {
  it('accepts explicit public graph patterns', () => {
    expect(check('SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } }')).toBeNull();
    expect(check('SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o }')).toBeNull();
  });

  it('rejects SERVICE anywhere with 400', () => {
    const service = '{ SERVICE <http://example.org/sparql> { ?s ?p ?o } }';
    for (const q of [
      `SELECT * WHERE ${service}`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?a ?b ?c OPTIONAL ${service} }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { { ?a ?b ?c } UNION ${service} }`,
      `SELECT * WHERE { { SELECT * WHERE ${service} } }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?a ?b ?c FILTER EXISTS ${service} }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?a ?b ?c MINUS ${service} }`,
    ]) {
      expect(check(q)?.status, q).toBe(400);
    }
  });

  it('rejects a variable graph name with 403', () => {
    expect(check('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }')?.status).toBe(403);
    expect(check('SELECT * WHERE { OPTIONAL { GRAPH ?g { ?s ?p ?o } } }')?.status).toBe(403);
  });

  it('rejects private graph IRIs in GRAPH, FROM and FROM NAMED with 403', () => {
    for (const q of [
      'SELECT * WHERE { GRAPH <urn:ontofelia:user:alice> { ?s ?p ?o } }',
      'SELECT * WHERE { GRAPH <urn:ontofelia:session:x> { ?s ?p ?o } }',
      'SELECT * WHERE { GRAPH <URN:ONTOFELIA:USER:alice> { ?s ?p ?o } }',
      'SELECT * FROM <urn:ontofelia:user:alice> WHERE { ?s ?p ?o }',
      'SELECT * FROM NAMED <urn:ontofelia:session:x> WHERE { ?s ?p ?o }',
      'ASK { GRAPH <urn:ontofelia:user:owner> { ?s ?p ?o } }',
    ]) {
      expect(check(q)?.status, q).toBe(403);
    }
  });

  it('finds private graphs nested in subqueries, EXISTS, NOT EXISTS, UNION and OPTIONAL', () => {
    const priv = 'GRAPH <urn:ontofelia:user:a> { ?x ?y ?z }';
    for (const q of [
      `SELECT * WHERE { { SELECT * WHERE { ${priv} } } }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o FILTER EXISTS { ${priv} } }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o FILTER NOT EXISTS { ${priv} } }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { { ?s ?p ?o } UNION { ${priv} } }`,
      `SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o OPTIONAL { ${priv} } }`,
    ]) {
      expect(check(q)?.status, q).toBe(403);
    }
  });

  it('refuses near-miss names too: only listed graphs pass', () => {
    expect(check('SELECT * WHERE { GRAPH <urn:ontofelia:users> { ?s ?p ?o } }')?.status).toBe(403);
    expect(check('SELECT * WHERE { GRAPH <urn:ontofelia:worldview2> { ?s ?p ?o } }')?.status).toBe(403);
    expect(check('SELECT * WHERE { GRAPH <urn:ontofelia:WORLDVIEW> { ?s ?p ?o } }')?.status).toBe(403);
  });

  it('refuses other agents\' private graphs, which the old prefix list missed', () => {
    for (const q of [
      'SELECT * WHERE { GRAPH <urn:other:user:a> { ?s ?p ?o } }',
      'SELECT * WHERE { GRAPH <urn:other:session:a> { ?s ?p ?o } }',
      'SELECT * WHERE { GRAPH <urn:ontofelia:inferred:user:a> { ?s ?p ?o } }',
    ]) {
      expect(check(q)?.status, q).toBe(403);
      expect(check(q)?.message, q).toMatch(/private graph/);
    }
  });

  describe('triple patterns outside GRAPH', () => {
    it('rejects graph-less patterns with 400 when no FROM is given', () => {
      for (const q of [
        'SELECT * WHERE { ?s ?p ?o }',
        'SELECT * WHERE { ?s <http://example.org/p>+ ?o }',
        'ASK { ?s ?p ?o }',
        'SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } ?a ?b ?c }',
        'SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } OPTIONAL { ?a ?b ?c } }',
        'SELECT * WHERE { { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } } UNION { ?a ?b ?c } }',
        'SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } MINUS { ?a ?b ?c } }',
        'SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } FILTER EXISTS { ?a ?b ?c } }',
        'SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } FILTER NOT EXISTS { ?a ?b ?c } }',
        'SELECT * WHERE { { SELECT * WHERE { ?a ?b ?c } } }',
        'SELECT * FROM NAMED <urn:ontofelia:worldview> WHERE { ?s ?p ?o }',
      ]) {
        const v = check(q);
        expect(v?.status, q).toBe(400);
        expect(v?.message).toMatch(/FROM or GRAPH/);
      }
    });

    it('accepts graph-less patterns when FROM defines the default graph', () => {
      expect(check('SELECT * FROM <urn:ontofelia:worldview> WHERE { ?s ?p ?o OPTIONAL { ?a ?b ?c } }')).toBeNull();
      expect(check('SELECT * FROM <urn:ontofelia:worldview> WHERE { { SELECT * WHERE { ?a ?b ?c } } }')).toBeNull();
    });

    it('accepts queries without triple patterns', () => {
      expect(check('SELECT ?x WHERE { VALUES ?x { 1 2 } }')).toBeNull();
      expect(check('SELECT ?x WHERE { BIND(1 AS ?x) }')).toBeNull();
    });

    it('still reports private graphs inside covered patterns with 403', () => {
      expect(check('SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { GRAPH <urn:ontofelia:user:a> { ?s ?p ?o } } }')?.status).toBe(403);
    });
  });
});
