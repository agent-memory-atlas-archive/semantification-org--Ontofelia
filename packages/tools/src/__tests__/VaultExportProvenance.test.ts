/**
 * The Vault-LD export must not depend on a model-settable field: facts written
 * through `memory_store` with `source: tool` (owner or not, about the user or a
 * third party) are never exported, while a fact imported from a vault is.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine, buildVaultExport, importVault } from '@ontofelia/semantic-memory';
import { MemoryStoreTool } from '../memory/memory_store.js';

const AGENT = 'ontofelia';
const WORLDVIEW = `urn:${AGENT}:worldview`;

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let tool: MemoryStoreTool;

const ctx = (senderId: string, isOwner: boolean): ToolContext =>
  ({ agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner }) as unknown as ToolContext;

async function importOneNote(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'vexp-prov-vault-'));
  mkdirSync(join(root, 'Recipe'));
  writeFileSync(join(root, 'Recipe', 'Soup.md'), '---\ntype: "[[Recipe]]"\nlabel: Soup\ndifficulty: easy\n---\n# Soup\n');
  const imp = await importVault(engine, { root, vaultName: 'prov', agentId: AGENT, apply: true });
  expect(imp.totals.stored).toBeGreaterThan(0);
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'vexp-prov-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  tool = new MemoryStoreTool(engine);
});

describe('vault export vs memory_store (source: tool)', () => {
  for (const [label, senderId, isOwner] of [['owner', 'boss', true], ['non-owner', 'alice', false]] as const) {
    it(`${label}: a self fact and a third-party fact are not exported`, async () => {
      await importOneNote();
      const self = await tool.execute({ subject: 'user', subjectType: 'Person', predicate: 'hasDiagnosis',
        object: `Secret-${label}`, objectType: 'literal', source: 'tool' }, ctx(senderId, isOwner));
      const other = await tool.execute({ subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: `City-${label}`, objectType: 'literal', source: 'tool' }, ctx(senderId, isOwner));
      expect(self.success).toBe(true);
      expect(other.success).toBe(true);
      if (isOwner) {
        // Not vacuous: the owner's third-party fact really sits in the worldview.
        expect(await store.ask(`ASK { GRAPH <${WORLDVIEW}> { ?s ?p "City-${label}" } }`)).toBe(true);
      }
      const out = await buildVaultExport(engine, { agentId: AGENT });
      const all = out.notes.map(n => `${n.path}\n${n.content}`).join('\n');
      expect(all).not.toContain(`Secret-${label}`);
      expect(all).not.toContain(`City-${label}`);
      expect(all).not.toContain('Anna');
      // Positive control: the imported note is exported.
      expect(out.notes.some(n => /Soup\.md$/.test(n.path))).toBe(true);
    });
  }
});
