import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { registerVaultCommand, sanitiseVaultName } from '../commands/vault.js';
import * as configPkg from '@ontofelia/config';

vi.mock('@ontofelia/config', () => ({
  loadConfig: vi.fn(),
}));

const originalFetch = global.fetch;
const SECRET = 'super-secret-token';

const report = (apply: boolean) => ({
  runId: 'r1',
  apply,
  notes: [
    { path: 'Recipes/hummus.md', status: apply ? 'imported' : 'would-import', facts: [{}, {}, {}], unmapped: [] },
    { path: 'Plain.md', status: 'refused', reason: 'no frontmatter', facts: [], unmapped: [] },
  ],
  totals: { [apply ? 'imported' : 'would-import']: 1, refused: 1 },
});

describe('sanitiseVaultName', () => {
  it('keeps allowed characters and replaces the rest', () => {
    expect(sanitiseVaultName('/home/me/My Vault.v2')).toBe('My_Vault_v2');
    expect(sanitiseVaultName('/x/ok-name_1')).toBe('ok-name_1');
  });
  it('truncates to 64 characters', () => {
    expect(sanitiseVaultName('/x/' + 'a'.repeat(100))).toHaveLength(64);
  });
});

describe('vault import command', () => {
  let program: Command;
  let logSpy: MockInstance;
  let errSpy: MockInstance;

  beforeEach(() => {
    program = new Command();
    registerVaultCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    vi.mocked(configPkg.loadConfig).mockResolvedValue({
      gateway: { port: 18780, token: SECRET },
    } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    process.exitCode = undefined;
  });

  const allOutput = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');

  it('defaults to a dry run, resolves the dir, sanitises the name and prints the dry-run line', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(report(false)) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', 'some dir/My Vault']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18780/api/knowledge/vault-import');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({
      root: path.resolve('some dir/My Vault'),
      vaultName: 'My_Vault',
      apply: false,
    });
    const out = allOutput();
    expect(out).toContain('Dry run — nothing written. Re-run with --apply to import.');
    expect(out).toContain('would-import');
    expect(out).toContain('Recipes/hummus.md  (3 facts)');
    expect(out).toContain('Plain.md  (0 facts, no frontmatter)');
    expect(out).toContain('Totals:');
    expect(out).not.toContain(SECRET);
    expect(process.exitCode).toBeUndefined();
  });

  it('passes --apply, --name and --agent and omits the dry-run line', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(report(true)) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v', '--apply', '--name', 'demo', '--agent', 'ontofelia']);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      root: '/v', vaultName: 'demo', apply: true, agentId: 'ontofelia',
    });
    expect(allOutput()).not.toContain('Dry run');
  });

  it('--json prints the raw report', async () => {
    const rep = report(false);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rep) }) as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v', '--json']);

    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(rep);
  });

  it('sets exit code 1 on an HTTP error and never prints the token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: () => Promise.resolve({ error: 'root must be an absolute path' }),
    }) as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v']);

    expect(process.exitCode).toBe(1);
    expect(allOutput()).toContain('HTTP 400 - root must be an absolute path');
    expect(allOutput()).not.toContain(SECRET);
  });
});

describe('vault export command', () => {
  let program: Command;
  let logSpy: MockInstance;
  let errSpy: MockInstance;
  let tmp: string;

  const NOTES = [
    { path: 'Recipe/Hummus.md', content: '---\nlabel: Hummus\n---\n# Hummus\n' },
    { path: 'Untyped/Tahini.md', content: '---\nlabel: Tahini\n---\n# Tahini\n' },
  ];
  const respond = (notes: { path: string; content: string }[]) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ notes, totals: { notes: notes.length } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };
  const allOutput = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');
  const listing = (d: string): string[] =>
    fs.readdirSync(d, { recursive: true, withFileTypes: false }).map(String).sort();

  beforeEach(() => {
    program = new Command();
    registerVaultCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-vexp-'));
    vi.mocked(configPkg.loadConfig).mockResolvedValue({
      gateway: { port: 18780, token: SECRET },
    } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fetches with the token, writes the notes and prints a summary', async () => {
    const fetchMock = respond(NOTES);
    const dir = path.join(tmp, 'out');

    await program.parseAsync(['node', 'test', 'vault', 'export', dir, '--agent', 'ontofelia']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18780/api/knowledge/vault-export?agentId=ontofelia');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(fs.readFileSync(path.join(dir, 'Recipe', 'Hummus.md'), 'utf8')).toBe(NOTES[0].content);
    expect(fs.readFileSync(path.join(dir, 'Untyped', 'Tahini.md'), 'utf8')).toBe(NOTES[1].content);
    expect(allOutput()).toContain(`Wrote 2 notes to ${dir}`);
    expect(allOutput()).not.toContain(SECRET);
    expect(process.exitCode).toBeUndefined();
  });

  it('--json prints the report', async () => {
    respond(NOTES);
    const dir = path.join(tmp, 'out');
    await program.parseAsync(['node', 'test', 'vault', 'export', dir, '--json']);
    const rep = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(rep.notesWritten).toBe(2);
    expect(rep.paths).toEqual(['Recipe/Hummus.md', 'Untyped/Tahini.md']);
    expect(allOutput()).not.toContain(SECRET);
  });

  it('refuses a non-empty folder without --overwrite and leaves it untouched', async () => {
    respond(NOTES);
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'mine');

    await program.parseAsync(['node', 'test', 'vault', 'export', tmp]);

    expect(process.exitCode).toBe(1);
    expect(allOutput()).toContain('not empty');
    expect(listing(tmp)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(tmp, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('writes into a non-empty folder with --overwrite, deleting nothing', async () => {
    respond(NOTES);
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'mine');

    await program.parseAsync(['node', 'test', 'vault', 'export', tmp, '--overwrite']);

    expect(process.exitCode).toBeUndefined();
    expect(listing(tmp)).toEqual(['Recipe', 'Recipe/Hummus.md', 'Untyped', 'Untyped/Tahini.md', 'keep.txt']);
  });

  it.each([
    ['../x.md'], ['/etc/x.md'], ['a/b/c.md'], ['a\\b.md'], ['Untyped/x.txt'], ['Untyped/.md'], ['x.md'], ['./x.md'],
  ])('refuses a hostile server path %s and writes nothing', async (hostile) => {
    respond([NOTES[0], { path: hostile, content: 'x' }]);
    const dir = path.join(tmp, 'out');

    await program.parseAsync(['node', 'test', 'vault', 'export', dir]);

    expect(process.exitCode).toBe(1);
    expect(allOutput()).toContain('unsafe note path');
    expect(fs.existsSync(dir)).toBe(false);
    expect(listing(tmp)).toEqual([]);
  });

  it('sets exit code 1 on an HTTP error and never prints the token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, json: () => Promise.resolve({ error: 'Agent not found' }),
    }) as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'export', path.join(tmp, 'out'), '--agent', 'nobody']);

    expect(process.exitCode).toBe(1);
    expect(allOutput()).toContain('HTTP 404 - Agent not found');
    expect(allOutput()).not.toContain(SECRET);
    expect(listing(tmp)).toEqual([]);
  });
});
