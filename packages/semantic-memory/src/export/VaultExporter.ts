/**
 * Build a Vault-LD export (one Markdown note per subject) from the knowledge
 * store, in memory. Nothing is written to disk here.
 *
 * Allow-list (security-relevant): a fact is exported iff `urn:<agent>:claims`
 * holds a claim for it with status "accepted", asserted in
 * `urn:<agent>:worldview`, sourceKind "tool", AND the claim's base triple is
 * currently present in the worldview. Only the claims graph, the worldview and
 * the label sources (worldview, schema, shared ontology) are read, each by
 * explicit IRI. User, self, session, inferred, cog and evidence graphs are
 * never read. Evidence text, raw text and source spans are never exported.
 */
import * as yaml from 'js-yaml';
import type { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphUriResolver, SHARED_GRAPHS } from '../utils/GraphUriResolver.js';
import { sparqlIri } from '../utils/SparqlSyntax.js';

export interface VaultExportOptions { agentId: string; vaultName?: string; }
export interface VaultExportNote { path: string; content: string; subject: string; facts: number; }
export interface VaultExportReport {
  notes: VaultExportNote[];
  skipped: { claim: string; reason: string }[];
  totals: Record<string, number>;
}

const CORE = 'urn:shared:ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC_TYPES = new Set(['integer', 'int', 'long', 'short', 'decimal', 'double', 'float',
  'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger'].map(t => XSD + t));
/** Keys the importer treats specially (identity, host or context keys): never emitted as facts. */
const RESERVED_KEYS = new Set(['id', '@id', '@type', '@context', 'tags', 'aliases', 'cssclasses']);
const MAX_NAME = 120;
const SEP = '\u001f';

type Term = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Part of an IRI after `#` or the last `/` (percent-decoded when valid). */
function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':'));
  const raw = cut >= 0 ? iri.slice(cut + 1) : iri;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Entity IRIs are minted with `_` for whitespace; undo that for display. */
function displayName(iri: string): string {
  return localName(iri).replace(/_/g, ' ').trim() || iri;
}

/** File-system safe name: no / \ : * ? " < > | (nor wiki-link breakers [ ] # ^), no leading dot. */
export function sanitizeFileName(name: string, max = MAX_NAME): string {
  let s = Array.from(name)
    .map(ch => (/[/\\:*?"<>|[\]#^]/.test(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '');
  s = Array.from(s).slice(0, max).join('').replace(/[.\s]+$/, '');
  return s || 'Unnamed';
}

function scalar(t: Term): string | number {
  const text = t.value;
  const numericType = t.datatype !== undefined && NUMERIC_TYPES.has(t.datatype);
  // A plain literal that reads as a canonical number stays a number (the
  // store keeps literals as strings); a non-canonical one such as "1.50" or
  // "007" stays a string so the value round-trips exactly.
  if ((numericType || t.datatype === undefined || t.datatype === XSD + 'string')
    && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && String(Number(text)) === text
    && Number.isSafeInteger(Math.trunc(Number(text)))) {
    return Number(text);
  }
  return text;
}

export async function buildVaultExport(engine: KnowledgeEngine, opts: VaultExportOptions): Promise<VaultExportReport> {
  const claimsG = sparqlIri(GraphUriResolver.getClaimsGraph(opts.agentId));
  const worldG = sparqlIri(GraphUriResolver.getWorldviewGraph(opts.agentId));
  const schemaG = sparqlIri(GraphUriResolver.getSchemaGraph(opts.agentId));
  const ontoG = sparqlIri(SHARED_GRAPHS.ONTOLOGY);

  // 1. The allow-list: the only source of exported facts.
  const allowSparql = `SELECT DISTINCT ?c ?s ?p ?o WHERE {
  GRAPH ${claimsG} {
    ?c a <${CORE}Claim> ;
       <${CORE}status> "accepted" ;
       <${CORE}assertedInGraph> ${worldG} ;
       <${CORE}sourceKind> "tool" ;
       <${CORE}claimSubject> ?s ;
       <${CORE}claimPredicate> ?p ;
       <${CORE}claimObject> ?o .
  }
  GRAPH ${worldG} { ?s ?p ?o }
}`;
  const allowRows = await engine.selectExplicitGraphs(allowSparql);

  // 2. Every claim with its selection attributes, for the skip report only.
  const claimSparql = `SELECT ?c
  (GROUP_CONCAT(DISTINCT ?st; separator="${SEP}") AS ?statuses)
  (GROUP_CONCAT(DISTINCT STR(?ag); separator="${SEP}") AS ?graphs)
  (GROUP_CONCAT(DISTINCT ?sk; separator="${SEP}") AS ?kinds)
WHERE {
  GRAPH ${claimsG} {
    ?c a <${CORE}Claim> .
    OPTIONAL { ?c <${CORE}status> ?st }
    OPTIONAL { ?c <${CORE}assertedInGraph> ?ag }
    OPTIONAL { ?c <${CORE}sourceKind> ?sk }
  }
} GROUP BY ?c`;
  const claimRows = await engine.selectExplicitGraphs(claimSparql);

  // 3. Labels, read-only, from explicitly named graphs.
  const labelSparql = `SELECT ?e ?l WHERE {
  { GRAPH ${worldG} { ?e <${RDFS_LABEL}> ?l } }
  UNION { GRAPH ${schemaG} { ?e <${RDFS_LABEL}> ?l } }
  UNION { GRAPH ${ontoG} { ?e <${RDFS_LABEL}> ?l } }
}`;
  const labelRows = await engine.selectExplicitGraphs(labelSparql);

  const labels = new Map<string, string[]>();
  for (const r of labelRows) {
    if (r.e.type !== 'uri' || r.l.type === 'uri') continue;
    const arr = labels.get(r.e.value) ?? [];
    arr.push(r.l.value);
    labels.set(r.e.value, arr);
  }
  const labelOf = (iri: string): string => {
    const ls = (labels.get(iri) ?? []).filter(l => l.trim()).sort(cmp);
    return ls.length ? ls[0].trim() : displayName(iri);
  };

  // Group the allowed base triples by claim id into distinct facts.
  const allowedClaims = new Set<string>();
  interface Fact { p: string; o: Term }
  const bySubject = new Map<string, Map<string, Fact>>();
  const skipped: { claim: string; reason: string }[] = [];
  const skipReasons: Record<string, number> = {};
  const skip = (claim: string, reason: string): void => {
    skipped.push({ claim, reason });
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };
  const allowSorted = [...allowRows].sort((a, b) =>
    cmp(a.c.value, b.c.value) || cmp(a.s.value, b.s.value) || cmp(a.p.value, b.p.value)
    || cmp(a.o.type + a.o.value, b.o.type + b.o.value));
  for (const r of allowSorted) {
    allowedClaims.add(r.c.value);
    if (r.s.type !== 'uri') { skip(r.c.value, 'blank node subject'); continue; }
    if (r.o.type === 'bnode') { skip(r.c.value, 'blank node object'); continue; }
    if (r.p.value === RDFS_LABEL) continue; // rendered as `label`
    const key = r.p.value === RDF_TYPE ? 'type' : localName(r.p.value);
    if (key === 'label') continue; // rendered as `label`, like rdfs:label
    if (key !== 'type' && RESERVED_KEYS.has(key)) { skip(r.c.value, 'reserved key'); continue; }
    if (!key) { skip(r.c.value, 'empty predicate name'); continue; }
    const facts = bySubject.get(r.s.value) ?? new Map<string, Fact>();
    facts.set(`${r.p.value}\u0000${r.o.type}\u0000${r.o.value}\u0000${r.o.datatype ?? ''}`, { p: r.p.value, o: r.o });
    bySubject.set(r.s.value, facts);
  }

  let considered = 0;
  for (const r of [...claimRows].sort((a, b) => cmp(a.c.value, b.c.value))) {
    considered++;
    if (allowedClaims.has(r.c.value)) continue;
    const statuses = (r.statuses?.value ?? '').split(SEP).filter(Boolean);
    const graphs = (r.graphs?.value ?? '').split(SEP).filter(Boolean);
    const kinds = (r.kinds?.value ?? '').split(SEP).filter(Boolean);
    const world = GraphUriResolver.getWorldviewGraph(opts.agentId);
    if (!statuses.includes('accepted')) skip(r.c.value, `status ${statuses.join('|') || 'missing'}`);
    else if (!graphs.includes(world)) skip(r.c.value, 'asserted outside the worldview');
    else if (!kinds.includes('tool')) skip(r.c.value, `sourceKind ${kinds.join('|') || 'missing'}`);
    else skip(r.c.value, 'base triple missing');
  }

  // 4. Names: unique vault-wide (wiki links resolve by name), subject IRI order.
  const subjects = [...bySubject.keys()].sort(cmp);
  const subjectSet = new Set(subjects);
  const nameOf = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const s of subjects) {
    const base = sanitizeFileName(labelOf(s));
    let name = base;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = sanitizeFileName(base, MAX_NAME - suffix.length) + suffix;
    }
    usedNames.add(name.toLowerCase());
    nameOf.set(s, name);
  }

  // 5. Render.
  const notes: VaultExportNote[] = [];
  for (const s of subjects) {
    const facts = [...bySubject.get(s)!.values()];
    const values = new Map<string, Array<string | number>>();
    const types: string[] = [];
    for (const f of facts) {
      if (f.p === RDF_TYPE) {
        if (f.o.type === 'uri') types.push(labelOf(f.o.value));
        continue;
      }
      const key = localName(f.p);
      let v: string | number;
      if (f.o.type === 'uri') {
        // An exported object becomes a wiki link. An object that is not itself
        // exported is written as its plain label, never as a wiki link, so the
        // vault has no dangling links to notes that do not exist.
        v = subjectSet.has(f.o.value) ? `[[${nameOf.get(f.o.value)}]]` : labelOf(f.o.value);
      } else {
        v = scalar(f.o);
      }
      const arr = values.get(key) ?? [];
      arr.push(v);
      values.set(key, arr);
    }
    const typeLinks = [...new Set(types)].sort(cmp);
    const fm: Record<string, unknown> = {};
    if (typeLinks.length) {
      const links = typeLinks.map(t => `[[${sanitizeFileName(t)}]]`);
      fm.type = links.length === 1 ? links[0] : links;
    }
    const label = labelOf(s);
    fm.label = label;
    const order = (x: string | number): string => `${typeof x === 'number' ? 'n' : 's'}${String(x)}`;
    for (const key of [...values.keys()].sort(cmp)) {
      const vs = [...new Map(values.get(key)!.map(x => [order(x), x])).entries()]
        .sort((a, b) => cmp(a[0], b[0])).map(e => e[1]);
      fm[key] = vs.length === 1 ? vs[0] : vs;
    }
    const front = yaml.dump(fm, {
      schema: yaml.CORE_SCHEMA, sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"',
    });
    const folder = typeLinks.length ? sanitizeFileName(typeLinks[0]) : 'Untyped';
    notes.push({
      path: `${folder}/${nameOf.get(s)}.md`,
      content: `---\n${front}---\n# ${label.replace(/\s+/g, ' ').trim()}\n`,
      subject: s,
      facts: facts.length,
    });
  }
  notes.sort((a, b) => cmp(a.path, b.path));
  skipped.sort((a, b) => cmp(a.claim, b.claim) || cmp(a.reason, b.reason));

  const skippedSet = new Set(skipped.map(k => k.claim));
  const totals: Record<string, number> = {
    claimsConsidered: considered,
    claimsExported: [...allowedClaims].filter(c => !skippedSet.has(c)).length,
    claimsSkipped: skipped.length,
    notes: notes.length,
  };
  for (const [reason, n] of Object.entries(skipReasons).sort((a, b) => cmp(a[0], b[0]))) {
    totals[`skipped: ${reason}`] = n;
  }
  return { notes, skipped, totals };
}
