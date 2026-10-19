import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWebUi } from '../index.js';

// Exercises the real @fastify/static plugin through the gateway's own registerWebUi():
// file serving, the SPA fallback, and that no path spelling resolves outside the web UI root.
describe('Web UI static serving', () => {
  let app: FastifyInstance;
  let tmp: string;
  const SECRET = 'outside-the-web-ui-root';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-webui-'));
    const root = path.join(tmp, 'dist');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<html>spa-index</html>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("app");');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), SECRET);
    app = Fastify();
    await registerWebUi(app, root);
    // A concrete API route next to the wildcard static route, as in the gateway.
    app.get('/api/ping', async () => ({ pong: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves an existing file with its content type', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log("app");');
  });

  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-index');
  });

  it('supports HEAD and conditional requests', async () => {
    const first = await app.inject({ method: 'GET', url: '/assets/app.js' });
    const head = await app.inject({ method: 'HEAD', url: '/assets/app.js' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    const etag = first.headers.etag;
    const lastModified = first.headers['last-modified'];
    expect(etag || lastModified).toBeTruthy();
    const cond = await app.inject({
      method: 'GET',
      url: '/assets/app.js',
      headers: etag ? { 'if-none-match': String(etag) } : { 'if-modified-since': String(lastModified) },
    });
    expect(cond.statusCode).toBe(304);
  });

  it('falls back to index.html for unknown client-side routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/models' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-index');
  });

  it('keeps API, WebSocket and webhook paths out of the SPA fallback', async () => {
    for (const url of ['/api/missing', '/API/missing', '/%61pi/missing', '/ws/nothing', '/webhooks/nothing']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('spa-index');
    }
    const ok = await app.inject({ method: 'GET', url: '/api/ping' });
    expect(ok.json()).toEqual({ pong: true });
  });

  it('never serves a file outside the root, whatever the path spelling', async () => {
    const urls = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/assets/../../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/assets/%252e%252e/%252e%252e/secret.txt',
      '/....//secret.txt',
      '/assets\\..\\..\\secret.txt',
      '/dist/../secret.txt',
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain(SECRET);
    }
  });

  it('rejects non-canonical spellings of a file under the root', async () => {
    // Empty path segments reach the static handler unnormalised (the router does not collapse
    // them), so they must be refused rather than resolved to the file.
    for (const url of ['//assets/app.js', '/assets//app.js', '/assets/app.js%00']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).not.toContain('console.log');
    }
  });
});
