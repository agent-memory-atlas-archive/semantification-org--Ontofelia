import { describe, it, expect } from 'vitest';
import type { Triple, TriplestoreAdapter } from '@ontofelia/core';
import { ReasonableEngine } from '../reasoning/ReasonableEngine.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/**
 * Minimal TriplestoreAdapter stub: serves a fixed TBox for the ontology graph
 * and an (optionally non-empty) ABox for any other graph. Only `getGraph` is
 * exercised by ReasonableEngine.materialize.
 */
function makeStore(tboxTtl: string, aboxTtl = ''): TriplestoreAdapter {
  return {
    async getGraph(graphUri: string) {
      return graphUri === 'urn:shared:ontology' ? tboxTtl : aboxTtl;
    },
  } as unknown as TriplestoreAdapter;
}

const objValue = (t: Triple): string =>
  typeof t.object === 'string' ? t.object : t.object.value;

describe('ReasonableEngine (async native reasoner)', () => {
  const tbox = `<http://ex/Dog> <${RDFS_SUBCLASS}> <http://ex/Animal> .`;

  it('materializes the subclass inference via the async reasoner', async () => {
    const engine = new ReasonableEngine(makeStore(tbox));
    const newTriple: Triple = {
      subject: 'http://ex/rex',
      predicate: RDF_TYPE,
      object: { type: 'uri', value: 'http://ex/Dog' },
    };

    // Must be awaited now that inferTriples returns a Promise.
    const inferred = await engine.materialize([newTriple], 'urn:agent:ctx');

    // rex a Dog ⟹ rex a Animal is the only genuinely new inference.
    expect(inferred.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
    // The input fact itself must not be echoed back.
    expect(inferred.some(t => objValue(t) === 'http://ex/Dog')).toBe(false);
  });

  it('handles concurrent materialize calls (native reasoner is re-entrant)', async () => {
    // Two independent engines reasoning in parallel — this would have raced on
    // the shared /tmp/{tbox,abox}_<pid>.ttl path in the old file-based impl.
    const engineA = new ReasonableEngine(makeStore(tbox));
    const engineB = new ReasonableEngine(
      makeStore(`<http://ex/Cat> <${RDFS_SUBCLASS}> <http://ex/Animal> .`),
    );

    const [a, b] = await Promise.all([
      engineA.materialize(
        [{ subject: 'http://ex/rex', predicate: RDF_TYPE, object: { type: 'uri', value: 'http://ex/Dog' } }],
        'urn:agent:a',
      ),
      engineB.materialize(
        [{ subject: 'http://ex/felix', predicate: RDF_TYPE, object: { type: 'uri', value: 'http://ex/Cat' } }],
        'urn:agent:b',
      ),
    ]);

    expect(a.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
    expect(b.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
  });

  describe('bare string objects are literals', () => {
    const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
    const RDFS_SUBPROP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
    const rules =
      `<http://ex/label> <${RDFS_DOMAIN}> <http://ex/Thing2> .\n` +
      `<http://ex/label> <${RDFS_SUBPROP}> <http://ex/tag> .`;
    const run = (object: Triple['object']) =>
      new ReasonableEngine(makeStore(rules)).materialize(
        [{ subject: 'http://ex/a', predicate: 'http://ex/label', object }],
        'urn:agent:ctx',
        { strict: true },
      );

    it('a literal that is not a valid IRI still gets its inference (bare string)', async () => {
      const inferred = await run('urn:a b');
      expect(inferred).toContainEqual({
        subject: 'http://ex/a', predicate: RDF_TYPE, object: { type: 'uri', value: 'http://ex/Thing2' },
      });
      expect(inferred).toContainEqual({
        subject: 'http://ex/a', predicate: 'http://ex/tag', object: { type: 'literal', value: 'urn:a b' },
      });
    });

    it('a literal that looks like an IRI is reasoned as a literal', async () => {
      for (const text of ['urn:ok', 'http://ex/looks-like-an-iri']) {
        const inferred = await run(text);
        expect(inferred).toContainEqual({
          subject: 'http://ex/a', predicate: 'http://ex/tag', object: { type: 'literal', value: text },
        });
        expect(inferred.some(t => t.predicate === 'http://ex/tag' && typeof t.object !== 'string' && t.object.type === 'uri')).toBe(false);
      }
    });

    it('a typed literal and a typed IRI keep their kind', async () => {
      const lit = await run({ type: 'literal', value: 'urn:a b' });
      expect(lit).toContainEqual({
        subject: 'http://ex/a', predicate: 'http://ex/tag', object: { type: 'literal', value: 'urn:a b' },
      });
      const iri = await run({ type: 'uri', value: 'urn:ok' });
      expect(iri).toContainEqual({
        subject: 'http://ex/a', predicate: 'http://ex/tag', object: { type: 'uri', value: 'urn:ok' },
      });
    });

    it('serialises each object kind to its N-Triples term', () => {
      const terms = (object: Triple['object']) =>
        (ReasonableEngine as unknown as {
          tripleToNtTerms(t: Triple): { object: string };
        }).tripleToNtTerms({ subject: 'http://ex/a', predicate: 'http://ex/p', object }).object;
      expect(terms('urn:a b')).toBe('"urn:a b"');
      expect(terms('urn:ok')).toBe('"urn:ok"');
      expect(terms('http://ex/x')).toBe('"http://ex/x"');
      expect(terms({ type: 'uri', value: 'urn:ok' })).toBe('<urn:ok>');
      expect(terms({ type: 'literal', value: 'x', language: 'en' })).toBe('"x"@en');
      expect(() => terms({ type: 'uri', value: 'urn:a b' })).toThrow();
    });
  });
});
