import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CognitiveConfig, COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, EpisodicMemory, userEntityUri, CORE_PREFERENCE_PREDICATE,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// The preference consolidation (pattern 3) through the runtime: the capture
// methods the channel adapters call (gated by the episodic memory flag), and the
// owner-only `/cog consolidate-episodes` job (gated by its own flag, default off).

const AGENT = 'ontofelia';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-prefp-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

class StubProvider implements ProviderAdapter {
  name = 'stub';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

const env = (text: string, over: Partial<MessageEnvelope> & { sender?: MessageEnvelope['sender'] } = {}): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

const stranger = { id: 'stranger', channelPrefix: 'webchat', isOwner: false };
const anna = { id: 'anna', channelPrefix: 'telegram', isOwner: false };
const bob = { id: 'bob', channelPrefix: 'telegram', isOwner: false };
const EP_FLAG = { name: 'flagEpisodicMemory', key: 'episodicMemory', description: '' };
const PREF_FLAG = { name: 'flagPreferenceConsolidation', key: 'preferenceConsolidation', description: '' };
const EPC_FLAG = { name: 'flagEpisodicConsolidation', key: 'episodicConsolidation', description: '' };
const BUTTONS = [{ text: 'A', callbackData: '/model a' }, { text: 'B', callbackData: '/model b' }];

describe('preference consolidation through the runtime', { timeout: 60_000 }, () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let em: EpisodicMemory;
  let dataDir: string;
  let n = 0;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `prefp-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `prefp-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/prefp-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
    em = new EpisodicMemory(store, AGENT);
  });

  afterEach(async () => {
    await runtime.flushCognitiveWrites();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  /** An offer to `sender` and the same sender's press, through the runtime's capture methods. */
  async function choice(sender: typeof anna, session: string, chosen = '/model a') {
    const ref = `telegram:${sender.id}:${++n}`;
    await runtime.recordChoiceOffered({ sender, channel: 'telegram', sessionId: session, offerRef: ref, buttons: BUTTONS });
    return runtime.recordChoiceMade({ sender, offerRef: ref, callbackData: chosen });
  }
  /** Three choices in two sessions (the same UTC day, two groups). */
  async function threeChoices(sender: typeof anna) {
    await choice(sender, `${sender.id}-s1`);
    await choice(sender, `${sender.id}-s1`);
    await choice(sender, `${sender.id}-s2`);
  }

  const quads = async () => ((await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).bindings ?? []).length;
  const prefs = async () =>
    ((await store.query(`SELECT ?g ?s WHERE { GRAPH ?g { ?s <${CORE_PREFERENCE_PREDICATE}> ?o } }`)).bindings ?? []).map((b) => `${b.g.value} ${b.s.value}`);
  const choiceEpisodes = async (user: string) =>
    (await em.recent(user, 200)).filter((e) => e.episodeType === 'choice-offered' || e.episodeType === 'choice-made');
  const OFF_TEXT = 'Episodic consolidation is off (flagEpisodicConsolidation). Nothing was read or changed. Enable with /cog flag episodicconsolidation on.';

  describe('capture', () => {
    it('writes nothing while episodic memory is off, and offered/made episodes once it is on', async () => {
      expect(await cfg.isEpisodicMemoryEnabled()).toBe(false);
      const before = await quads();
      expect(await choice(anna, 's1')).toBe(false);
      expect(await quads()).toBe(before);

      await cfg.setEnabled(EP_FLAG, true);
      expect(await choice(anna, 's1')).toBe(true);
      const eps = await choiceEpisodes('anna');
      expect(eps.map((e) => e.episodeType).sort()).toEqual(['choice-made', 'choice-offered']);
      expect(eps.every((e) => e.forUser === 'anna' && e.sessionId === 's1')).toBe(true);
    });

    it('a press by another user writes nothing', async () => {
      await cfg.setEnabled(EP_FLAG, true);
      const ref = 'telegram:chat:1';
      expect(await runtime.recordChoiceOffered({ sender: anna, channel: 'telegram', sessionId: 's1', offerRef: ref, buttons: BUTTONS })).toBe(true);
      const before = await quads();
      expect(await runtime.recordChoiceMade({ sender: bob, offerRef: ref, callbackData: '/model a' })).toBe(false);
      expect(await runtime.recordChoiceMade({ sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true }, offerRef: ref, callbackData: '/model a' })).toBe(false);
      expect(await quads()).toBe(before);
      expect(await runtime.recordChoiceMade({ sender: anna, offerRef: ref, callbackData: '/model a' })).toBe(true);
    });

    it('Guardian g: callbacks write nothing', async () => {
      await cfg.setEnabled(EP_FLAG, true);
      const before = await quads();
      expect(await runtime.recordChoiceOffered({
        sender: anna, offerRef: 'telegram:chat:g', buttons: [{ text: 'Approve', callbackData: 'g:a:1' }, { text: 'Deny', callbackData: 'g:d:1' }],
      })).toBe(false);
      expect(await runtime.recordChoiceMade({ sender: anna, offerRef: 'telegram:chat:g', callbackData: 'g:a:1' })).toBe(false);
      expect(await quads()).toBe(before);
    });

    it('a response without buttons is not an offer', async () => {
      await cfg.setEnabled(EP_FLAG, true);
      const before = await quads();
      expect(await runtime.recordChoiceOffered({ sender: anna, offerRef: 'telegram:chat:2', buttons: undefined })).toBe(false);
      expect(await runtime.recordChoiceOffered({ sender: anna, offerRef: 'telegram:chat:2', buttons: [] })).toBe(false);
      expect(await quads()).toBe(before);
    });

    it('a button whose value looks like a credential marks the offer secret, so it never counts', async () => {
      await cfg.setEnabled(EP_FLAG, true);
      await cfg.setEnabled(PREF_FLAG, true);
      const secretButtons = [{ text: 'A', callbackData: '/set token=abcdef123456' }, { text: 'B', callbackData: '/set b' }];
      for (let i = 0; i < 3; i++) {
        const ref = `telegram:s:${i}`;
        await runtime.recordChoiceOffered({ sender: anna, sessionId: `sec${i}`, offerRef: ref, buttons: secretButtons });
        await runtime.recordChoiceMade({ sender: anna, offerRef: ref, callbackData: '/set b' });
      }
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text).toContain('0 qualified');
      expect(await prefs()).toEqual([]);
    });
  });

  describe('/cog consolidate-episodes', () => {
    beforeEach(async () => {
      await cfg.setEnabled(EP_FLAG, true);
      await threeChoices(anna);
      // bob chose twice: below K for him, and never mixed with anna's.
      await choice(bob, 'bob-s1');
      await choice(bob, 'bob-s2');
    });

    it('with the flag off (the default) it says the consolidation is off and reads and writes nothing', async () => {
      expect(await cfg.isFlagEnabledByName('flagPreferenceConsolidation')).toBe(false);
      const before = await quads();
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text).toBe(OFF_TEXT);
      expect(await quads()).toBe(before);
      expect(await prefs()).toEqual([]);
    });

    it('with pattern 1 on and the preference flag off, no preference is promoted', async () => {
      await cfg.setEnabled(EPC_FLAG, true);
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text).toContain('Episodic consolidation:');
      expect(res.text).not.toContain('Preference consolidation');
      expect(await prefs()).toEqual([]);
    });

    it('with the flag on it promotes into the offered user\'s graph only, and a rerun changes nothing', async () => {
      await cfg.setEnabled(PREF_FLAG, true);
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text).toBe('🧩 Preference consolidation: 5 choices of 2 user(s), 1 qualified, 1 promoted, 0 already known, 0 contradicted.');
      expect(await prefs()).toEqual([`urn:${AGENT}:user:anna ${userEntityUri('anna')}`]);
      const after = await quads();
      const again = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(again.text).toContain('0 promoted, 1 already known');
      expect(await quads()).toBe(after);
    });

    it('with both flags on it reports one line per pattern', async () => {
      await cfg.setEnabled(EPC_FLAG, true);
      await cfg.setEnabled(PREF_FLAG, true);
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text.split('\n')).toHaveLength(2);
      expect(res.text).toContain('Episodic consolidation:');
      expect(res.text).toContain('Preference consolidation:');
    });

    it('honours K and Q from the setup graph', async () => {
      await cfg.setEnabled(PREF_FLAG, true);
      await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:setup> { <urn:${AGENT}:setup:cognitive> <urn:shared:ontology#cog/consolidationMinEpisodes> "4"^^<http://www.w3.org/2001/XMLSchema#integer> } }`);
      const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
      expect(res.text).toContain('0 qualified');
      expect(await prefs()).toEqual([]);
    });

    it('is owner-only and changes nothing for a non-owner', async () => {
      await cfg.setEnabled(PREF_FLAG, true);
      const before = await quads();
      const res = await runtime.handleMessage(env('/cog consolidate-episodes', { sender: stranger }));
      expect(res.text).toBe('This command is owner-only.');
      expect(await quads()).toBe(before);
    });
  });

  describe('the flag', () => {
    it('is on the /cog flag allowlist, visible in /cog flags, default off, and set by name', async () => {
      expect(COGNITIVE_FLAGS.map((f) => f.name)).toContain('flagPreferenceConsolidation');
      expect(await cfg.isFlagEnabledByName('flagPreferenceConsolidation')).toBe(false);
      const flags = await runtime.handleMessage(env('/cog flags'));
      expect(flags.text).toContain('• flagPreferenceConsolidation (preferenceconsolidation): off');
      const res = await runtime.handleMessage(env('/cog flag preferenceconsolidation on'));
      expect(res.text).toBe('⚙️ flagPreferenceConsolidation = true.');
      expect(await cfg.isFlagEnabledByName('flagPreferenceConsolidation')).toBe(true);
    });

    it('is not part of /cog defaults: apply turns the others on and leaves it off', async () => {
      const shown = await runtime.handleMessage(env('/cog defaults'));
      expect(shown.text).toContain('• flagPreferenceConsolidation: stays off');
      await runtime.handleMessage(env('/cog defaults apply'));
      expect(await cfg.isFlagEnabledByName('flagEpisodicConsolidation')).toBe(true);
      expect(await cfg.isFlagEnabledByName('flagPreferenceConsolidation')).toBe(false);
    });
  });
});
