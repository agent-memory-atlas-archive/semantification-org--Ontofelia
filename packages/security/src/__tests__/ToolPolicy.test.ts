import { describe, it, expect } from 'vitest';
import { ToolPolicyEngine } from '../ToolPolicy.js';
import { ToolDefinition, ToolContext, ToolAuditEntry } from '@ontofelia/core';

describe('ToolPolicyEngine', () => {
  const mockContext: ToolContext = {
    agentId: 'a1', sessionId: 's1', workspacePath: '/w', channelType: 'cli', senderId: 'u1', isOwner: true
  };

  const createTool = (name: string, hostOnly = false, sandboxOnly = false): ToolDefinition => ({
    name,
    description: '',
    category: 'utility',
    inputSchema: {},
    permissions: [],
    hostOnly,
    sandboxOnly,
    execute: async () => ({ success: true, output: '', auditEntry: {} as unknown as ToolAuditEntry })
  });

  it('blocks DEFAULT_DENY tools without allow-list', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toMatch(/dangerous and requires explicit approval/);
  });

  it('allows DEFAULT_DENY tools if in allow-list', () => {
    const engine = new ToolPolicyEngine({ allow: ['exec'], deny: [] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(true);
  });

  it('denies tool if in both allow-list and deny-list', () => {
    const engine = new ToolPolicyEngine({ allow: ['exec'], deny: ['exec'] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/deny list/);
  });

  it('allows safe tool without config', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('safe_tool');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(true);
  });

  it('denies hostOnly tool without allow', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('custom_host', true, false);
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toMatch(/hostOnly/);
  });

  describe('non-owner people get no host tools', () => {
    const person: ToolContext = { ...mockContext, channelType: 'telegram', senderId: 'telegram:42', isOwner: false };
    const hostTools = [createTool('exec', true), createTool('fs_write', true), createTool('fs_read'), createTool('fs_list'), createTool('cron_manage', true)];

    it('denies every host tool to a non-owner on a chat channel, without approval and despite the allow-list', () => {
      const engine = new ToolPolicyEngine({ allow: ['exec', 'fs_write', 'fs_read', 'fs_list', 'cron_manage'], deny: [] });
      for (const tool of hostTools) {
        const res = engine.isAllowed(tool, person);
        expect(res.allowed, tool.name).toBe(false);
        expect(res.requiresApproval, tool.name).toBeFalsy();
        expect(res.reason).toMatch(/reserved for the owner/);
      }
      expect(engine.filterAllowed(hostTools, person)).toEqual([]);
    });

    it('applies on every person channel and leaves other tools alone', () => {
      const engine = new ToolPolicyEngine({ allow: [], deny: [] });
      for (const channelType of ['discord', 'webchat', 'slack'] as const) {
        expect(engine.isAllowed(createTool('exec', true), { ...person, channelType }).allowed).toBe(false);
      }
      expect(engine.isAllowed(createTool('memory_ask'), person).allowed).toBe(true);
    });

    it('keeps the owner and machine senders as they were', () => {
      const engine = new ToolPolicyEngine({ allow: ['exec'], deny: [] });
      expect(engine.isAllowed(createTool('exec', true), { ...person, isOwner: true }).allowed).toBe(true);
      const webhook = engine.isAllowed(createTool('exec', true), { ...person, channelType: 'webhook' as never, senderId: 'webhook:w1' });
      expect(webhook.allowed).toBe(true);
    });
  });
});
