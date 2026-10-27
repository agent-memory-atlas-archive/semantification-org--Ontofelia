/**
 * Pure mapper from one Vault-LD note (already-parsed YAML frontmatter) to
 * `FactInput`s for `KnowledgeEngine.storeFact`. No I/O, no store access.
 *
 * Scope: key names are used as predicate names verbatim — JSON-LD @context
 * composition is deliberately NOT implemented.
 */
import type { FactInput } from '../types.js';
import { isUserAliasSubject } from '../KnowledgeEngine.js';
import { sparqlIri } from '../utils/SparqlSyntax.js';

export interface VaultNote {
  /** Vault-relative path, e.g. 'Recipes/hummus.md'. */
  path: string;
  /** Already parsed YAML frontmatter. */
  frontmatter: Record<string, unknown>;
  /** Markdown body, used as evidence text. */
  body?: string;
  /** Hash of the whole file, e.g. 'sha256:<hex>'. */
  contentHash: string;
  /** Vault name, e.g. 'demo'. */
  vaultName: string;
}

export interface VaultNoteMapping {
  facts: FactInput[];
  /** Keys deliberately or necessarily not turned into facts. */
  unmapped: { key: string; reason: string }[];
  /** Set when the whole note is refused; `facts` is then empty. */
  refused?: string;
}

/** Longest body excerpt kept as evidence text. */
const MAX_SPAN = 2000;

/**
 * Vault-LD §4.3 "Host-tool keys are not triples": `tags`, `aliases` and
 * `cssclasses` belong to the host editor; while unmapped a tool MUST NOT emit
 * them as triples (and MUST NOT warn about them as unknown constructs).
 */
const HOST_KEYS = new Set(['tags', 'aliases', 'cssclasses']);

const WIKI_LINK = /^\s*\[\[([^\]]*)\]\]\s*$/;
// prefix:local — prefix starts with a letter, no whitespace, local part does not start with '/'.
const CURIE = /^[A-Za-z][\w.-]*:[^\s/][^\s]*$/;

/** Target note name of a wiki link body: drop `|alias`, `#heading`, folder path and `.md`. */
function wikiTarget(inner: string): string {
  const noAlias = inner.split('|')[0];
  const noFragment = noAlias.split('#')[0];
  const last = noFragment.trim().split('/').pop() ?? '';
  return last.replace(/\.md$/i, '').trim();
}

/**
 * True when a plain YAML string would be read back as a reference (wiki link
 * or CURIE) rather than as a literal. The exporter uses this to decide which
 * string literals must be written in the explicit `{"@value": ...}` form.
 */
export function isReferenceString(value: string): boolean {
  if (WIKI_LINK.test(value)) return true;
  const text = value.trim();
  return CURIE.test(text) && !text.includes('//');
}

/**
 * True when `[[name]]` is read back as exactly `name`. A name that fails this
 * (it contains `]`, `|`, `#` or `/`, has outer whitespace or ends in `.md`)
 * can only be written as an explicit `{"@id": name}` reference.
 */
export function isWikiLinkSafe(name: string): boolean {
  const m = WIKI_LINK.exec(`[[${name}]]`);
  return m !== null && name !== '' && wikiTarget(m[1]) === name;
}

const LANG_TAG = /^[a-zA-Z]+(-[a-zA-Z0-9]+)*$/;

type Mapped =
  | { object: string; objectType: 'literal' | 'Concept'; note?: string }
  | { skip: string };

/**
 * Explicit forms (YAML-LD value objects), the only way to say what a plain
 * string cannot:
 *   `{"@value": "text"}`                      a literal, never a reference
 *   `{"@value": "text", "@language": "de"}`   the same; the tag is validated
 *                                             but NOT stored (the store keeps
 *                                             plain literals), reported as unmapped
 *   `{"@id": "name or absolute IRI"}`         a reference to exactly that name
 * Any other object stays unmapped.
 */
function mapValueObject(value: Record<string, unknown>): Mapped {
  const keys = Object.keys(value);
  const unsupported: Mapped = { skip: 'nested object or list (not mapped)' };
  if (keys.length === 1 && keys[0] === '@id') {
    const id = value['@id'];
    if (typeof id !== 'string' || !id.trim()) return { skip: 'empty reference' };
    const name = id.trim();
    if (/^(urn:|https?:\/\/)/.test(name)) {
      try { sparqlIri(name); } catch { return { skip: 'invalid IRI reference' }; }
    }
    return { object: name, objectType: 'Concept' };
  }
  if (keys.includes('@value') && keys.every(k => k === '@value' || k === '@language')) {
    const v = value['@value'];
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return unsupported;
    const text = String(v);
    if (!text.trim()) return { skip: 'empty value' };
    const lang = value['@language'];
    if (lang === undefined) return { object: text, objectType: 'literal' };
    if (typeof lang !== 'string' || !LANG_TAG.test(lang)) return { skip: 'invalid language tag' };
    return { object: text, objectType: 'literal', note: 'language tag not stored (literal kept without it)' };
  }
  return unsupported;
}

function mapScalar(value: unknown): Mapped {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)) {
    return mapValueObject(value as Record<string, unknown>);
  }
  if (value instanceof Date) return { object: value.toISOString(), objectType: 'literal' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { object: String(value), objectType: 'literal' };
  }
  if (typeof value !== 'string') {
    return { skip: value === null || value === undefined ? 'null value' : 'unsupported value type' };
  }
  const link = WIKI_LINK.exec(value);
  if (link) {
    const target = wikiTarget(link[1]);
    return target ? { object: target, objectType: 'Concept' } : { skip: 'empty wiki link' };
  }
  const text = value.trim();
  if (!text) return { skip: 'empty value' };
  if (CURIE.test(text) && !text.includes('//')) return { object: text, objectType: 'Concept' };
  return { object: value, objectType: 'literal' };
}

export function mapVaultNote(note: VaultNote): VaultNoteMapping {
  const fm = note.frontmatter ?? {};
  const unmapped: { key: string; reason: string }[] = [];
  const fileName = (note.path.split('/').pop() ?? note.path).replace(/\.md$/i, '');
  const label = typeof fm.label === 'string' && fm.label.trim() ? fm.label.trim() : undefined;
  const subject = label ?? fileName;

  const refuse = (reason: string): VaultNoteMapping => ({ facts: [], unmapped, refused: reason });

  if (isUserAliasSubject(subject)) {
    return refuse(`subject "${subject}" is a user alias`);
  }
  // Vault-LD §4.4.1: "A note with no frontmatter, or whose frontmatter lacks
  // `@type`, does **not** participate in the graph; it is an ordinary
  // document." `type` is the declared alias of `@type` (§4.3); both spellings count.
  const typeKey = 'type' in fm ? 'type' : '@type' in fm ? '@type' : undefined;
  const typeValue = typeKey ? fm[typeKey] : undefined;
  const hasType = Array.isArray(typeValue)
    ? typeValue.length > 0
    : typeValue !== undefined && typeValue !== null && typeValue !== '';
  if (!hasType) return refuse('no type (not in the graph per Vault-LD)');

  const sourceUri = 'vault://' + encodeURIComponent(note.vaultName) + '/'
    + note.path.split('/').map(encodeURIComponent).join('/');
  const span = (note.body ?? '').trim().slice(0, MAX_SPAN);

  const facts: FactInput[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (key === 'id' || key === '@id') {
      unmapped.push({ key, reason: 'identity key (not mapped yet)' });
      continue;
    }
    if (HOST_KEYS.has(key)) {
      unmapped.push({ key, reason: 'host key (not a triple)' });
      continue;
    }
    if (key === '@context') {
      unmapped.push({ key, reason: 'context declaration (composition not implemented)' });
      continue;
    }
    // `type`/`@type` is expressed as the predicate 'type': KnowledgeEngine's
    // BUILTIN_PREDICATES funnels it to rdf:type, so the reasoner sees a real
    // type edge. Every other key is used verbatim as the predicate name.
    const predicate = key === '@type' ? 'type' : key;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const m = mapScalar(v);
      if ('skip' in m) {
        const reason = m.skip === 'unsupported value type' && typeof v === 'object' && v !== null
          ? 'nested object or list (not mapped)' : m.skip;
        if (!unmapped.some(u => u.key === key && u.reason === reason)) unmapped.push({ key, reason });
        continue;
      }
      if (m.note && !unmapped.some(u => u.key === key && u.reason === m.note)) {
        unmapped.push({ key, reason: m.note });
      }
      facts.push({
        // subjectType 'Concept' (the generic type the parser uses) makes
        // storeFact create the subject node with its label; the Vault-LD class
        // itself is carried by the `type` fact, not by subjectType.
        subject,
        subjectType: 'Concept',
        predicate,
        object: m.object,
        objectType: m.objectType,
        sourceKind: 'tool',
        channel: 'vault-import',
        evidenceType: 'document',
        sourceUri,
        contentHash: note.contentHash,
        ...(span ? { sourceSpan: span } : {}),
        confidenceLabel: 'high',
        status: 'accepted',
      });
    }
  }
  return { facts, unmapped };
}
