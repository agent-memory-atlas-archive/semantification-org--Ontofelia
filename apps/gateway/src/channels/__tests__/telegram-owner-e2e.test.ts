import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTelegramSender } from '@ontofelia/channels';
import { AgentRuntime } from '@ontofelia/agent-runtime';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, ToolContext,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog, MemoryStoreTool } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A Telegram sender resolved with channels.telegram.ownerId set, followed
// through the real runtime (owner-only commands) and the real memory tool
// (per-user graph) on an embedded store.

const AGENT = 'ontofelia';
const OWNER_ID = '1000001';
const FRIEND_ID = '2000002';
const OWNER_GRAPH = `urn:${AGENT}:user:owner`;
const FRIEND_GRAPH = `urn:${AGENT}:user:telegram:${FRIEND_ID}`;
const WORLDVIEW = `urn:${AGENT}:worldview`;

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-owner-e2e-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'per-channel-peer' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
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

/** Build the envelope exactly as the adapter does, via the shared resolver. */
function envelopeFrom(fromId: string, text: string): MessageEnvelope {
  const sender = resolveTelegramSender(fromId, 'x', OWNER_ID);
  if (!sender) throw new Error('resolver refused a valid id');
  return {
    id: '1', channel: 'telegram' as ChannelType, accountId: 'default', chatType: 'dm', sender,
    timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  } as MessageEnvelope;
}

/** The tool context the runtime builds from an envelope (buildToolContext). */
const toolCtx = (env: MessageEnvelope): ToolContext => ({
  agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: env.channel,
  senderId: env.sender.id, isOwner: env.sender.isOwner,
} as unknown as ToolContext);

let store: OxigraphAdapter;
let ke: KnowledgeEngine;
let runtime: AgentRuntime;

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: mkdtempSync(join(tmpdir(), 'tg-owner-')), port: 0, endpoint: '' });
  ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
  const sessionStore = new SessionStore(mkdtempSync(join(tmpdir(), 'tg-owner-sess-')));
  runtime = new AgentRuntime(
    AGENT, mockConfig, new StubProvider(), sessionStore,
    new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
    new AuditLog(mkdtempSync(join(tmpdir(), 'tg-owner-audit-'))), new SkillRegistry(),
    new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined,
    ke, undefined,
  );
});

describe('an approved non-owner has no owner rights', () => {
  for (const cmd of ['/goals', '/initiative', '/reseed-persona']) {
    it(`${cmd} is refused for the non-owner and not for the owner`, async () => {
      const friend = await runtime.handleMessage(envelopeFrom(FRIEND_ID, cmd));
      expect(friend.text).toContain('owner-only');
      const owner = await runtime.handleMessage(envelopeFrom(OWNER_ID, cmd));
      expect(owner.text).not.toContain('This command is owner-only.');
    });
  }
});

describe('an approved non-owner has a private store', () => {
  const store1 = (env: MessageEnvelope, object: string) => new MemoryStoreTool(ke).execute(
    { subject: 'user', subjectType: 'Person', predicate: 'hasDiagnosis', object, objectType: 'literal' },
    toolCtx(env),
  );
  const inGraph = (g: string, o: string) => store.ask(`ASK { GRAPH <${g}> { ?s ?p "${o}" } }`);

  it('a fact from the non-owner lands in their own graph, not the owner graph or the worldview', async () => {
    const res = await store1(envelopeFrom(FRIEND_ID, 'x'), 'FriendSecret');
    expect(res.success).toBe(true);
    expect(await inGraph(FRIEND_GRAPH, 'FriendSecret')).toBe(true);
    expect(await inGraph(OWNER_GRAPH, 'FriendSecret')).toBe(false);
    expect(await inGraph(WORLDVIEW, 'FriendSecret')).toBe(false);
    // and the owner does not read it back
    expect(await ke.getRecentFacts(AGENT, 50, 'owner')).not.toContain('FriendSecret');
    expect(await ke.getRecentFacts(AGENT, 50, `telegram:${FRIEND_ID}`)).toContain('FriendSecret');
  });

  it('the owner keeps the unchanged "owner" graph', async () => {
    const res = await store1(envelopeFrom(OWNER_ID, 'x'), 'OwnerSecret');
    expect(res.success).toBe(true);
    expect(await inGraph(OWNER_GRAPH, 'OwnerSecret')).toBe(true);
    expect(await inGraph(FRIEND_GRAPH, 'OwnerSecret')).toBe(false);
  });
});
