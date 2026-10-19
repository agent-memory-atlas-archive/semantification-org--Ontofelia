import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';

// Exercises the real @fastify/multipart plugin (and sharp, for image uploads) through the
// gateway's upload routes.
const TOKEN = 'test-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const BOUNDARY = '----ontofelia-test-boundary';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(parts: Array<{ name: string; filename?: string; type?: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const multipartHeaders = (extra: Record<string, string> = {}) => ({
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
  ...extra,
});

describe('Multipart uploads', () => {
  let fastify: FastifyInstance;
  let tmpHome: string;
  let prevHome: string | undefined;
  const mediaFiles = () => {
    const dir = path.join(tmpHome, '.ontofelia', 'media', 'files');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  beforeAll(async () => {
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-upload-'));
    process.env.HOME = tmpHome;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = TOKEN;
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  for (const route of ['/api/media/upload', '/canvas/upload']) {
    describe(`POST ${route}`, () => {
      it('refuses an upload without the token and stores nothing', async () => {
        const before = mediaFiles().length;
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: multipartHeaders(),
          payload: multipartBody([{ name: 'file', filename: 'a.txt', type: 'text/plain', data: 'hello' }]),
        });
        expect(res.statusCode).toBe(401);
        expect(mediaFiles().length).toBe(before);
      });

      it('stores an authenticated text upload and returns an id and signed url', async () => {
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: multipartHeaders(AUTH),
          payload: multipartBody([{ name: 'file', filename: 'note.txt', type: 'text/plain', data: 'hello upload' }]),
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { id: string; url: string };
        expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.url).toContain(body.id);
        const stored = mediaFiles().find((f) => f.startsWith(body.id));
        expect(stored).toBeDefined();
        expect(fs.readFileSync(path.join(tmpHome, '.ontofelia', 'media', 'files', stored!), 'utf8')).toBe('hello upload');
      });

      it('stores a PNG upload and decodes it with sharp', async () => {
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: multipartHeaders(AUTH),
          payload: multipartBody([{ name: 'file', filename: 'pixel.png', type: 'image/png', data: PNG }]),
        });
        expect(res.statusCode).toBe(200);
        const { id } = res.json() as { id: string };
        const list = await fastify.inject({ method: 'GET', url: '/api/media', headers: AUTH });
        const entry = (list.json() as Array<{ id: string; mimeType: string; width?: number; height?: number }>).find((e) => e.id === id);
        expect(entry).toBeDefined();
        expect(entry!.mimeType).toBe('image/png');
        expect(entry!.width).toBe(1);
        expect(entry!.height).toBe(1);
      });

      it('answers 400 for a multipart body without a file part', async () => {
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: multipartHeaders(AUTH),
          payload: multipartBody([{ name: 'note', data: 'just a field' }]),
        });
        expect(res.statusCode).toBe(400);
      });

      it('never writes outside the media directory for a hostile filename', async () => {
        const before = fs.readdirSync(tmpHome);
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: multipartHeaders(AUTH),
          payload: multipartBody([{ name: 'file', filename: '../../../escape.txt', type: 'text/plain', data: 'x' }]),
        });
        expect([200, 400]).toContain(res.statusCode);
        expect(fs.readdirSync(tmpHome)).toEqual(before);
        expect(fs.existsSync(path.join(path.dirname(tmpHome), 'escape.txt'))).toBe(false);
        if (res.statusCode === 200) {
          const { id } = res.json() as { id: string };
          const stored = mediaFiles().find((f) => f.startsWith(id));
          expect(stored).toBeDefined();
          expect(stored).not.toContain('/');
        }
      });

      it('rejects a non-multipart body on the upload route', async () => {
        const res = await fastify.inject({
          method: 'POST',
          url: route,
          headers: { ...AUTH, 'content-type': 'application/json' },
          payload: JSON.stringify({ file: 'nope' }),
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      });
    });
  }
});
