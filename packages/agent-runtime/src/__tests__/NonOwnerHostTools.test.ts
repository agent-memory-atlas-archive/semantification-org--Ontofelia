/**
 * An approved non-owner who talks to the agent on a chat channel never gets a
 * host tool: it is neither advertised nor executed, even when the LLM names it
 * and even when the tool is on the allow-list. The owner keeps it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, ToolDefinition, ToolResult,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-nonowner-workspace',
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

function spyTool(name: string, hostOnly: boolean): { tool: ToolDefinition; ran: () => boolean } {
  let didRun = false;
  const tool: ToolDefinition = {
    name, description: name, category: 'utility', inputSchema: { type: 'object', properties: {} }, permissions: [], hostOnly,
    async execute(): Promise<ToolResult> {
      didRun = true;
      return { success: true, output: `${name} ran`, auditEntry: { toolName: name, timestamp: '', duration: 0, input: {}, output: '', success: true, permissions: [] } };
    },
  };
  return { tool, ran: () => didRun };
}

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const call = (name: string): ChatResponse => ({
  id: 'r1', content: '', finishReason: 'tool_calls', usage,
  toolCalls: [{ id: 'c1', name, arguments: '{"command":"echo hi","path":"notes.txt"}' }],
});
const stop = (): ChatResponse => ({ id: 'r2', content: 'done', finishReason: 'stop', toolCalls: [], usage });

const telegramEnv = (isOwner: boolean) => ({
  id: 't1', channel: 'telegram' as ChannelType, accountId: 'default', chatType: 'dm' as const,
  sender: { id: isOwner ? 'owner' : 'telegram:4242', channelPrefix: 'telegram', isOwner },
  timestamp: new Date().toISOString(), text: 'run it', mentions: [], attachments: [],
});

describe('host tools for an approved non-owner on Telegram', () => {
  let sid: string;
  let registry: ToolRegistry;
  let tools: Record<string, { tool: ToolDefinition; ran: () => boolean }>;

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    registry = new ToolRegistry();
    tools = { exec: spyTool('exec', true), fs_read: spyTool('fs_read', false), datetime: spyTool('datetime', false) };
    for (const t of Object.values(tools)) registry.register(t.tool);
  });
  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-nonowner-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  // All three on the allow-list: the owner runs exec without an approval round trip.
  const runtimeFor = (provider: ProviderAdapter) => new AgentRuntime(
    'test', mockConfig, provider, new SessionStore(`/tmp/ontofelia-nonowner-sessions-${sid}`), registry,
    new ToolPolicyEngine({ allow: ['exec', 'fs_read', 'datetime'], deny: [] }), new AuditLog(`/tmp/ontofelia-nonowner-workspace-${sid}`),
    new SkillRegistry(), new SkillExecutor(new SkillRegistry()), new PluginRegistry(),
  );

  for (const name of ['exec', 'fs_read'] as const) {
    it(`does not advertise or run ${name} for the non-owner`, async () => {
      const provider = new ScriptedProvider([call(name), stop()]);
      await runtimeFor(provider).handleMessage(telegramEnv(false));
      expect(provider.offered[0]).not.toContain(name);
      expect(provider.offered[0]).toContain('datetime');
      expect(tools[name].ran()).toBe(false);
    });

    it(`still runs ${name} for the owner (control)`, async () => {
      const provider = new ScriptedProvider([call(name), stop()]);
      await runtimeFor(provider).handleMessage(telegramEnv(true));
      expect(provider.offered[0]).toContain(name);
      expect(tools[name].ran()).toBe(true);
    });
  }
});
