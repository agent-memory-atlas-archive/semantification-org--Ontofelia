import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebhookRegistry } from '@ontofelia/scheduler';
import type { MessageEnvelope } from '@ontofelia/core';
import systemRoutes from '../system.js';
import type { GatewayContext } from '../../context.js';

// The host-tool opt-in of a webhook comes from its stored config record and from
// nothing the caller controls. The route builds the envelope; the runtime copies
// the routing hint into the ToolContext (covered in the agent-runtime tests).

const SECRET = 'wh-secret';
const bearer = { authorization: `Bearer ${SECRET}` };

describe('POST /webhooks/:path host-tool flag', () => {
  let app: FastifyInstance;
  let dir: string;
  let registry: WebhookRegistry;
  let seen: MessageEnvelope[];

  const add = (name: string, extra: Record<string, unknown> = {}) => registry.create({
    name, path: name, secret: SECRET, authMethod: 'bearer', agentId: 'ontofelia',
    enabled: true, maxPayloadBytes: 1_000_000, replayWindowMs: 300_000, ...extra,
  } as Parameters<WebhookRegistry['create']>[0]);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-webhook-flag-'));
    registry = new WebhookRegistry(dir);
    await add('plain');
    await add('optin', { allowHostTools: true });
    await add('optout', { allowHostTools: false });
    // A stored record is untrusted input too: a hand-edited non-boolean must not enable the flag.
    const file = path.join(dir, 'webhooks.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>[];
    stored.push({ ...stored[0], id: 'stringy', path: '/webhooks/stringy', allowHostTools: 'true' });
    fs.writeFileSync(file, JSON.stringify(stored));
    registry = new WebhookRegistry(dir);
    await registry.load();

    const agent = {
      handleMessage: async (env: MessageEnvelope) => { seen.push(env); return { text: 'ok', sessionId: 's' }; },
    };
    app = Fastify();
    await app.register(systemRoutes, {
      agents: new Map([['ontofelia', agent]]),
      config: { gateway: { auth: { tokenRequired: false }, token: SECRET } },
      webhookRegistry: registry,
    } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { seen = []; });

  const post = (p: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/webhooks/${p}`, headers: { ...bearer, ...headers }, payload: payload as object });

  it('carries no flag for a webhook without allowHostTools', async () => {
    expect((await post('plain', { event: 'push' })).statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe('webhook');
    expect(seen[0].sender.isOwner).toBe(false);
    expect(seen[0].routingHints?.allowHostTools).toBeUndefined();
  });

  it('carries no flag for allowHostTools: false', async () => {
    await post('optout', { event: 'push' });
    expect(seen[0].routingHints?.allowHostTools).toBeUndefined();
  });

  it('carries the flag from the stored config of an opted-in webhook', async () => {
    expect((await post('optin', { event: 'push' })).statusCode).toBe(200);
    expect(seen[0].routingHints?.allowHostTools).toBe(true);
    expect(seen[0].routingHints?.forceNewSession).toBe(true);
  });

  it('does not turn the flag on from a payload field, query or header', async () => {
    const res = await app.inject({
      method: 'POST', url: '/webhooks/plain?allowHostTools=true',
      headers: { ...bearer, 'x-allow-host-tools': 'true', 'x-routing-hints': '{"allowHostTools":true}' },
      payload: { allowHostTools: true, routingHints: { allowHostTools: true }, sender: { isOwner: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].routingHints?.allowHostTools).toBeUndefined();
    expect(seen[0].sender.isOwner).toBe(false);
  });

  it('does not enable the flag for a non-boolean stored value', async () => {
    expect((await post('stringy', { event: 'push' })).statusCode).toBe(200);
    expect(seen[0].routingHints?.allowHostTools).toBeUndefined();
  });

  it('rejects a non-boolean allowHostTools when the webhook is created', async () => {
    for (const bad of ['true', 1, null, {}]) {
      await expect(add(`bad-${String(typeof bad)}-${String(bad)}`, { allowHostTools: bad })).rejects.toThrow(/allowHostTools must be a boolean/);
    }
    expect(registry.list().some(w => w.path.startsWith('/webhooks/bad-'))).toBe(false);
  });
});
