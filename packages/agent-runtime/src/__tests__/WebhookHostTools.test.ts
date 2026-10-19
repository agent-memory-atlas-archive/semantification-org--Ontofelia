/**
 * A webhook envelope reaches the tools with `ToolContext.allowHostTools` set only
 * when the gateway put the flag in the routing hints (from the stored webhook
 * config). Without it the webhook is offered and runs no host tool; with it the
 * pre-existing allow-list rules apply. The flag is ignored on any other channel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, ToolDefinition, ToolResult, ToolContext, MessageEnvelope,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-webhook-workspace',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

/** Replays scripted responses and records the tool names it was offered. */
class ScriptedProvider implements ProviderAdapter {
  name = 'scripted';
  offered: string[][] = [];
  private i = 0;
  constructor(private readonly script: ChatResponse[]) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'scripted', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.offered.push((request.tools ?? []).map(t => t.name));
    const r = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    return r;
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

interface Spy { tool: ToolDefinition; ran: () => boolean; context: () => ToolContext | undefined }

function spyTool(name: string, hostOnly: boolean): Spy {
  let didRun = false;
  let seen: ToolContext | undefined;
  const tool: ToolDefinition = {
    name, description: name, category: 'utility', inputSchema: { type: 'object', properties: {} }, permissions: [], hostOnly,
    async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
      didRun = true;
      seen = context;
      return { success: true, output: `${name} ran`, auditEntry: { toolName: name, timestamp: '', duration: 0, input: {}, output: '', success: true, permissions: [] } };
    },
  };
  return { tool, ran: () => didRun, context: () => seen };
}

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const call = (name: string): ChatResponse => ({
  id: 'r1', content: '', finishReason: 'tool_calls', usage,
  toolCalls: [{ id: 'c1', name, arguments: '{"path":"notes.txt"}' }],
});
const stop = (): ChatResponse => ({ id: 'r2', content: 'done', finishReason: 'stop', toolCalls: [], usage });

const webhookEnv = (routingHints?: MessageEnvelope['routingHints'], channel: ChannelType = 'webhook'): MessageEnvelope => ({
  id: 'w1', channel, accountId: 'system', chatType: 'webhook',
  sender: { id: 'webhook:w1', channelPrefix: 'webhook', isOwner: false },
  timestamp: new Date().toISOString(), text: 'Webhook received: {}', mentions: [], attachments: [],
  routingHints: { forceNewSession: true, ...routingHints },
});

describe('host tools for a webhook', () => {
  let sid: string;
  let registry: ToolRegistry;
  let tools: Record<string, Spy>;

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    registry = new ToolRegistry();
    tools = { fs_read: spyTool('fs_read', false), datetime: spyTool('datetime', false) };
    for (const t of Object.values(tools)) registry.register(t.tool);
  });
  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-webhook-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  // fs_read is on the allow-list: with the flag the webhook runs it without an approval round trip.
  const runtimeFor = (provider: ProviderAdapter) => new AgentRuntime(
    'test', mockConfig, provider, new SessionStore(`/tmp/ontofelia-webhook-sessions-${sid}`), registry,
    new ToolPolicyEngine({ allow: ['fs_read', 'datetime'], deny: [] }), new AuditLog(`/tmp/ontofelia-webhook-workspace-${sid}`),
    new SkillRegistry(), new SkillExecutor(new SkillRegistry()), new PluginRegistry(),
  );

  it('does not advertise or run fs_read when the webhook has no flag', async () => {
    const provider = new ScriptedProvider([call('fs_read'), stop()]);
    await runtimeFor(provider).handleMessage(webhookEnv());
    expect(provider.offered[0]).not.toContain('fs_read');
    expect(provider.offered[0]).toContain('datetime');
    expect(tools.fs_read.ran()).toBe(false);
  });

  it('does not run fs_read when the flag is anything but a literal true', async () => {
    for (const bad of [false, 'true', 1] as unknown[]) {
      const provider = new ScriptedProvider([call('fs_read'), stop()]);
      await runtimeFor(provider).handleMessage(webhookEnv({ allowHostTools: bad as boolean }));
      expect(provider.offered[0]).not.toContain('fs_read');
      expect(tools.fs_read.ran()).toBe(false);
    }
  });

  it('copies the flag into the ToolContext and runs fs_read when the routing hint is true', async () => {
    const provider = new ScriptedProvider([call('fs_read'), call('datetime'), stop()]);
    await runtimeFor(provider).handleMessage(webhookEnv({ allowHostTools: true }));
    expect(provider.offered[0]).toContain('fs_read');
    expect(tools.fs_read.ran()).toBe(true);
    expect(tools.fs_read.context()?.allowHostTools).toBe(true);
    expect(tools.fs_read.context()?.channelType).toBe('webhook');
    expect(tools.fs_read.context()?.isOwner).toBe(false);
  });

  it('ignores the routing hint on any other channel', async () => {
    const provider = new ScriptedProvider([call('datetime'), stop()]);
    await runtimeFor(provider).handleMessage(webhookEnv({ allowHostTools: true }, 'telegram'));
    expect(tools.datetime.ran()).toBe(true);
    expect(tools.datetime.context()?.allowHostTools).toBeUndefined();
  });
});
