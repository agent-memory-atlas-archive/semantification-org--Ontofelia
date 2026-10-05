import type { SparqlResult } from '@ontofelia/core';
import type { Term } from 'oxigraph';
import { turtleTerm, type TurtleTermInput } from '../utils/TurtleSyntax.js';

/**
 * Converts the raw value returned by `oxigraph.Store.query` into a
 * `SparqlResult`. Shared by `OxigraphAdapter` and the query worker so both
 * produce identical output.
 *
 * oxigraph returns: boolean (ASK), Map<string,Term>[] (SELECT) or Quad[]
 * (CONSTRUCT/DESCRIBE). Both SELECT and CONSTRUCT are arrays, so distinguish
 * by the row type: SELECT rows are Map, CONSTRUCT rows are Quad objects.
 */
export function convertOxigraphResult(result: unknown): SparqlResult {
  if (typeof result === 'boolean') {
    return { type: 'boolean', boolean: result };
  }

  const isBindings = Array.isArray(result) &&
    (result.length === 0 || result[0] instanceof Map);

  if (isBindings) {
    const rows = result as Map<string, Term>[];
    let variables: string[] = [];
    if (rows.length > 0) {
      variables = [...rows[0].keys()];
    }

    const bindings = rows.map(row => {
      const bindingObj: Record<string, import('@ontofelia/core').RdfTerm> = {};
      for (const [key, value] of row.entries()) {
        if (value.termType === 'NamedNode') {
          bindingObj[key] = { type: 'uri', value: value.value };
        } else if (value.termType === 'Literal') {
          bindingObj[key] = { type: 'literal', value: value.value, language: value.language, datatype: value.datatype?.value };
        } else if (value.termType === 'BlankNode') {
          bindingObj[key] = { type: 'bnode', value: value.value };
        }
      }
      return bindingObj;
    });

    return { type: 'bindings', variables, bindings };
  }

  // CONSTRUCT or DESCRIBE: an array of Quads, formatted as N-Triples-like text
  let graphStr = '';
  type RdfQuad = { subject: TurtleTermInput; predicate: TurtleTermInput; object: TurtleTermInput };
  for (const quad of (result as Iterable<RdfQuad>)) {
    const subject = turtleTerm(quad.subject);
    const predicate = turtleTerm(quad.predicate);
    const object = turtleTerm(quad.object);
    graphStr += `${subject} ${predicate} ${object} .\n`;
  }
  return { type: 'graph', graph: graphStr };
}
