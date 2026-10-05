/**
 * Pure static checks for SPARQL queries submitted over HTTP.
 *
 * The guard walks a parsed query (the `sparqljs` AST) and rejects anything
 * that could reach outside the public knowledge graphs:
 *
 * - `SERVICE` clauses anywhere (federation to remote endpoints), -> 400
 * - `GRAPH ?var { ... }` (could enumerate private graphs), -> 403
 * - any graph IRI under a private prefix (user and session graphs), in a
 *   `GRAPH` pattern or in `FROM` / `FROM NAMED`. -> 403
 * - triple patterns outside any `GRAPH`, unless the top-level query has a
 *   `FROM` clause that defines the default graph. Some backends expose the
 *   union of all graphs as the default graph, so a graph-less pattern could
 *   read private data there. -> 400
 *
 * The walk is generic over the whole AST, so nested groups, OPTIONAL, UNION,
 * MINUS, subqueries and FILTER (NOT) EXISTS are all visited.
 */

/** Graph IRI prefixes that must never be reachable through the HTTP endpoint. */
export const PRIVATE_GRAPH_PREFIXES = ['urn:ontofelia:user:', 'urn:ontofelia:session:'] as const;

export type GuardViolation = { status: 400 | 403; message: string };

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

function privateGraphViolation(term: unknown, where: string): GuardViolation | null {
  if (!isNode(term) || term.termType !== 'NamedNode' || typeof term.value !== 'string') {
    // Anything that is not a plain IRI cannot be checked statically: fail closed.
    return { status: 403, message: `${where} must be a plain IRI` };
  }
  const iri = term.value.toLowerCase();
  if (PRIVATE_GRAPH_PREFIXES.some((prefix) => iri.startsWith(prefix))) {
    return { status: 403, message: `${where} refers to a private graph, which is not queryable here` };
  }
  return null;
}

function visit(node: unknown, covered: boolean): GuardViolation | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const violation = visit(item, covered);
      if (violation) return violation;
    }
    return null;
  }
  if (!isNode(node)) return null;

  if (node.type === 'service') {
    return { status: 400, message: 'SERVICE clauses are not allowed' };
  }

  if (node.type === 'bgp' && !covered && Array.isArray(node.triples) && node.triples.length > 0) {
    return { status: 400, message: 'Triple patterns must be inside a GRAPH pattern; name a graph with FROM or GRAPH' };
  }

  if (node.type === 'graph') {
    if (isNode(node.name) && node.name.termType === 'Variable') {
      return { status: 403, message: 'GRAPH patterns with a variable graph name are not allowed' };
    }
    const violation = privateGraphViolation(node.name, 'GRAPH name');
    if (violation) return violation;
    // Everything inside an allowed GRAPH is scoped to that graph.
    return visit(node.patterns, true);
  }

  // Dataset clause of a (sub)query: { default: NamedNode[], named: NamedNode[] }
  if (isNode(node.from)) {
    for (const key of ['default', 'named'] as const) {
      const graphs = (node.from as Node)[key];
      if (Array.isArray(graphs)) {
        for (const graph of graphs) {
          const violation = privateGraphViolation(graph, 'FROM clause graph');
          if (violation) return violation;
        }
      }
    }
  }

  for (const value of Object.values(node)) {
    const violation = visit(value, covered);
    if (violation) return violation;
  }
  return null;
}

/**
 * Check a parsed SPARQL query. Returns the first violation found, or `null`
 * when the query is acceptable. Never throws for well-formed ASTs; a walk
 * failure (e.g. pathological nesting) is reported as a 400 violation.
 */
export function checkQueryAst(ast: unknown): GuardViolation | null {
  try {
    const from = isNode(ast) && isNode(ast.from) ? (ast.from as Node).default : undefined;
    // A FROM clause defines the default graph (its IRIs are checked in the walk).
    return visit(ast, Array.isArray(from) && from.length > 0);
  } catch {
    return { status: 400, message: 'Query is too deeply nested to be checked' };
  }
}
