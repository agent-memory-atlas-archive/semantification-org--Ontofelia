import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FusekiManager, FUSEKI_DOWNLOAD } from '../fuseki/FusekiManager.js';

let tmp: string;
let fusekiHome: string;

function makeTarball(): Buffer {
  const src = path.join(tmp, 'src', 'apache-jena-fuseki-test');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'fuseki-server.jar'), 'placeholder');
  const out = path.join(tmp, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', path.join(tmp, 'src'), 'apache-jena-fuseki-test']);
  return Buffer.from(execFileSync('cat', [out]));
}

function manager(body: Buffer, hash: string) {
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(body), { status: 200 }));
  const m = new FusekiManager(
    {
      dataDir: path.join(tmp, 'data'),
      port: 0,
      configPath: path.join(tmp, 'cfg.ttl'),
      fusekiHome,
      javaPath: 'java',
      dataset: 'test',
    },
    {
      fetch: fetchMock as unknown as typeof fetch,
      download: { url: 'https://example.invalid/fuseki.tar.gz', sha512: hash },
    },
  );
  return { m, fetchMock };
}

describe('Fuseki download integrity', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tmp = mkdtempSync(path.join(tmpdir(), 'fuseki-dl-'));
    fusekiHome = path.join(tmp, 'home');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pins a 128-hex SHA-512 next to the URL', () => {
    expect(FUSEKI_DOWNLOAD.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(FUSEKI_DOWNLOAD.url).toContain('apache-jena-fuseki-5.0.0.tar.gz');
  });

  it('unpacks an archive whose hash matches', async () => {
    const tarball = makeTarball();
    const { m } = manager(tarball, createHash('sha512').update(tarball).digest('hex'));
    await m.ensureFuseki();
    expect(existsSync(path.join(fusekiHome, 'fuseki-server.jar'))).toBe(true);
    expect(existsSync(path.join(fusekiHome, 'fuseki.tar.gz'))).toBe(false);
  });

  it('rejects tampered bytes and leaves nothing behind', async () => {
    const tarball = makeTarball();
    const hash = createHash('sha512').update(tarball).digest('hex');
    const tampered = Buffer.concat([tarball, Buffer.from('x')]);
    const { m } = manager(tampered, hash);
    await expect(m.ensureFuseki()).rejects.toThrow(/integrity check.*expected/);
    expect(existsSync(path.join(fusekiHome, 'fuseki.tar.gz'))).toBe(false);
    expect(existsSync(path.join(fusekiHome, 'fuseki-server.jar'))).toBe(false);
    expect(readdirSync(fusekiHome)).toEqual([]);
  });

  it('does not fetch when the jar already exists', async () => {
    mkdirSync(fusekiHome, { recursive: true });
    writeFileSync(path.join(fusekiHome, 'fuseki-server.jar'), 'x');
    const { m, fetchMock } = manager(Buffer.from('unused'), 'unused');
    await m.ensureFuseki();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
