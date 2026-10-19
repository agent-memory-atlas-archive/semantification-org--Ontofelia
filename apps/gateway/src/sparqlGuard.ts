/**
 * Pure static checks for SPARQL queries submitted over HTTP.
 *
 * The guard walks a parsed query (the `sparqljs` AST) and rejects anything
 * that could reach outside the graphs the endpoint is meant to serve:
 *
 * - `SERVICE` clauses anywhere (federation to remote endpoints), -> 400
 * - `GRAPH ?var { ... }` (could enumerate private graphs), -> 403
 * - any graph IRI that is not on the allowlist, in a `GRAPH` pattern or in
 *   `FROM` / `FROM NAMED`. The list is a closed allowlist (see
 *   {@link httpReadableGraphs}), not a list of forbidden prefixes: a graph's
 *   name says whose machinery it is, not whose data it holds, and the agent-wide
 *   graphs (claims, evidence, conflicts, episodic memory, working memory, ...)
 *   carry other users' private data. A graph that nobody listed is refused. -> 403
 * - triple patterns outside any `GRAPH`, unless the top-level query has a
 *   `FROM` clause that defines the default graph. Some backends expose the
 *   union of all graphs as the default graph, so a graph-less pattern could
 *   read private data there. -> 400
 *
 * The walk is generic over the whole AST, so nested groups, OPTIONAL, UNION,
 * MINUS, subqueries and FILTER (NOT) EXISTS are all visited.
 */

import { GraphUriResolver, SHARED_GRAPHS } from '@ontofelia/semantic-memory';

/**
 * Graph IRI shapes that are reported as "private" in the error message (any
 * agent id): per-user, per-user-inferred and per-session graphs. The refusal
 * itself comes from the allowlist; this only picks the clearer message.
 */
const PRIVATE_GRAPH_PATTERN = /^urn:[^:]+:(?:inferred:)?(?:user|session):/i;

/**
 * The graphs the HTTP endpoint may read: exactly those that the agent already
 * shows to every user of every channel, so reading them reveals no more than
 * talking to the agent does.
 *
 * - shared vocabulary and registry: `urn:shared:{ontology,meta,shapes,world}`
 * - per agent: `worldview` (facts the agent holds as general knowledge; a
 *   non-owner's facts reach it only as `sourceKind: user` third-party facts,
 *   see `KnowledgeEngine.resolveTargetGraph`), `schema` (learned predicate
 *   vocabulary), `inferred` (derived from the worldview only), `self`
 *   (persona and derived capabilities), `skills` (tool descriptors)
 *
 * Everything else is refused, including every graph that holds user-derived
 * content of non-owner users: `claims`, `evidence`, `conflicts`,
 * `urn:shared:{claims,evidence}`, `setup` (digest items carry model-written
 * text, also from non-owner sessions), `cog:episodic`, `cog:procedural`,
 * `cog:meta`, `cog:goals:*`, `cog:cycles:*`, `cog:working:*`, and all
 * `user:`, `inferred:user:` and `session:` graphs.
 */
export function httpReadableGraphs(agentIds: Iterable<string>): ReadonlySet<string> {
  const graphs = new Set<string>([
    SHARED_GRAPHS.ONTOLOGY,
    SHARED_GRAPHS.META,
    SHARED_GRAPHS.SHAPES,
    SHARED_GRAPHS.WORLD,
  ]);
  for (const agentId of agentIds) {
    graphs.add(GraphUriResolver.getWorldviewGraph(agentId));
    graphs.add(GraphUriResolver.getSchemaGraph(agentId));
    graphs.add(GraphUriResolver.getInferredGraph(agentId));
    graphs.add(GraphUriResolver.getSelfGraph(agentId));
    graphs.add(GraphUriResolver.getSkillsGraph(agentId));
  }
  return graphs;
}

export type GuardViolation = { status: 400 | 403; message: string };

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null;
}

function graphViolation(term: unknown, where: string, allowed: ReadonlySet<string>): GuardViolation | null {
  if (!isNode(term) || term.termType !== 'NamedNode' || typeof term.value !== 'string') {
    // Anything that is not a plain IRI cannot be checked statically: fail closed.
    return { status: 403, message: `${where} must be a plain IRI` };
  }
  // Exact, case-sensitive match: the store compares IRIs the same way.
  if (allowed.has(term.value)) return null;
  if (PRIVATE_GRAPH_PATTERN.test(term.value)) {
    return { status: 403, message: `${where} refers to a private graph, which is not queryable here` };
  }
  return { status: 403, message: `${where} <${term.value}> is not a graph this endpoint serves` };
}

function visit(node: unknown, covered: boolean, allowed: ReadonlySet<string>): GuardViolation | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const violation = visit(item, covered, allowed);
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
    const violation = graphViolation(node.name, 'GRAPH name', allowed);
    if (violation) return violation;
    // Everything inside an allowed GRAPH is scoped to that graph.
    return visit(node.patterns, true, allowed);
  }

  // Dataset clause of a (sub)query: { default: NamedNode[], named: NamedNode[] }
  if (isNode(node.from)) {
    for (const key of ['default', 'named'] as const) {
      const graphs = (node.from as Node)[key];
      if (Array.isArray(graphs)) {
        for (const graph of graphs) {
          const violation = graphViolation(graph, 'FROM clause graph', allowed);
          if (violation) return violation;
        }
      }
    }
  }

  for (const value of Object.values(node)) {
    const violation = visit(value, covered, allowed);
    if (violation) return violation;
  }
  return null;
}

/**
 * Check a parsed SPARQL query against the graphs it may name (`allowed`, see
 * {@link httpReadableGraphs}). Returns the first violation found, or `null`
 * when the query is acceptable. Never throws for well-formed ASTs; a walk
 * failure (e.g. pathological nesting) is reported as a 400 violation.
 */
export function checkQueryAst(ast: unknown, allowed: ReadonlySet<string>): GuardViolation | null {
  try {
    const from = isNode(ast) && isNode(ast.from) ? (ast.from as Node).default : undefined;
    // A FROM clause defines the default graph (its IRIs are checked in the walk).
    return visit(ast, Array.isArray(from) && from.length > 0, allowed);
  } catch {
    return { status: 400, message: 'Query is too deeply nested to be checked' };
  }
}
