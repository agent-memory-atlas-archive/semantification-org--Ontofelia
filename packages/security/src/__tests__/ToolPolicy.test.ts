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

    it('keeps the owner as it was', () => {
      const engine = new ToolPolicyEngine({ allow: ['exec'], deny: [] });
      expect(engine.isAllowed(createTool('exec', true), { ...person, isOwner: true }).allowed).toBe(true);
    });
  });

  describe('webhooks get no host tools unless their config says so', () => {
    const webhook: ToolContext = { ...mockContext, channelType: 'webhook', senderId: 'webhook:w1', isOwner: false };
    const hostTools = [createTool('exec', true), createTool('fs_write', true), createTool('fs_read'), createTool('fs_list')];

    it('denies fs_read, fs_list, exec and fs_write without approval, despite the allow-list', () => {
      for (const allow of [[], ['exec', 'fs_write', 'fs_read', 'fs_list']]) {
        const engine = new ToolPolicyEngine({ allow, deny: [] });
        for (const tool of hostTools) {
          const res = engine.isAllowed(tool, webhook);
          expect(res.allowed, tool.name).toBe(false);
          expect(res.requiresApproval, tool.name).toBeFalsy();
          expect(res.reason).toMatch(/reserved for the owner/);
        }
        expect(engine.filterAllowed(hostTools, webhook)).toEqual([]);
      }
    });

    it('denies a hostOnly or default-denied custom tool too, and ignores isOwner', () => {
      const engine = new ToolPolicyEngine({ allow: [], deny: [] });
      for (const tool of [createTool('custom_host', true), createTool('cron_manage')]) {
        expect(engine.isAllowed(tool, webhook).allowed, tool.name).toBe(false);
        expect(engine.isAllowed(tool, { ...webhook, isOwner: true }).allowed, tool.name).toBe(false);
        expect(engine.isAllowed(tool, { ...webhook, isOwner: true }).requiresApproval, tool.name).toBeFalsy();
      }
    });

    it('still allows a tool that is not a host tool', () => {
      const engine = new ToolPolicyEngine({ allow: [], deny: [] });
      expect(engine.isAllowed(createTool('memory_ask'), webhook).allowed).toBe(true);
      expect(engine.isAllowed(createTool('ontology_inspect'), webhook).allowed).toBe(true);
    });

    it('fails closed: only a literal true turns the flag on', () => {
      const engine = new ToolPolicyEngine({ allow: ['fs_read'], deny: [] });
      for (const allowHostTools of [false, undefined, 'true', 1, 'yes', {}, null]) {
        const res = engine.isAllowed(createTool('fs_read'), { ...webhook, allowHostTools: allowHostTools as never });
        expect(res.allowed, String(allowHostTools)).toBe(false);
      }
    });

    it('with allowHostTools: true behaves as before', () => {
      const ctx: ToolContext = { ...webhook, allowHostTools: true };
      const engine = new ToolPolicyEngine({ allow: [], deny: [] });
      expect(engine.isAllowed(createTool('fs_read'), ctx).allowed).toBe(true);
      expect(engine.isAllowed(createTool('fs_list'), ctx).allowed).toBe(true);
      const exec = engine.isAllowed(createTool('exec', true), ctx);
      expect(exec.allowed).toBe(false);
      expect(exec.requiresApproval).toBe(true);
      expect(engine.isAllowed(createTool('exec', true), { ...ctx, isOwner: true }).requiresApproval).toBe(true);
      expect(new ToolPolicyEngine({ allow: ['exec'], deny: [] }).isAllowed(createTool('exec', true), ctx).allowed).toBe(true);
      expect(new ToolPolicyEngine({ allow: [], deny: ['fs_read'] }).isAllowed(createTool('fs_read'), ctx).allowed).toBe(false);
    });

    it('the flag does not lift the person gate', () => {
      const engine = new ToolPolicyEngine({ allow: ['fs_read'], deny: [] });
      const person: ToolContext = { ...mockContext, channelType: 'telegram', senderId: 'telegram:42', isOwner: false, allowHostTools: true };
      expect(engine.isAllowed(createTool('fs_read'), person).allowed).toBe(false);
    });
  });

  describe('nodes (paired devices) are unchanged', () => {
    it('keeps cli/node senders as they were', () => {
      const node: ToolContext = { ...mockContext, channelType: 'cli', senderId: 'node:n1', isOwner: false };
      const engine = new ToolPolicyEngine({ allow: ['exec', 'fs_read'], deny: [] });
      expect(engine.isAllowed(createTool('exec', true), node).allowed).toBe(true);
      expect(engine.isAllowed(createTool('fs_read'), node).allowed).toBe(true);
      const open = new ToolPolicyEngine({ allow: [], deny: [] });
      expect(open.isAllowed(createTool('exec', true), node).requiresApproval).toBe(true);
    });
  });
});
