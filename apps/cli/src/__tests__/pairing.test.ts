import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as configPkg from '@ontofelia/config';
import {
  registerPairingCommand,
  shouldProceed,
  PAIRING_APPROVE_WARNING,
  PAIRING_APPROVE_WARNING_OWNER_SET,
  telegramOwnerConfigured,
} from '../commands/pairing.js';

vi.mock('@ontofelia/config', () => ({
  loadConfig: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }));

const originalFetch = global.fetch;

describe('pairing approve', () => {
  let program: Command;
  let fetchMock: ReturnType<typeof vi.fn>;
  const ttyDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  beforeEach(() => {
    program = new Command();
    registerPairingCommand(program);
    vi.mocked(configPkg.loadConfig).mockResolvedValue({ gateway: { port: 1, token: 't' } } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    process.exitCode = undefined;
    if (ttyDesc) Object.defineProperty(process.stdin, 'isTTY', ttyDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it('declares --yes', () => {
    const approve = program.commands.find(c => c.name() === 'pairing')!.commands.find(c => c.name() === 'approve')!;
    expect(approve.options.map(o => o.long)).toContain('--yes');
  });

  it('warning mentions shell and owner', () => {
    expect(PAIRING_APPROVE_WARNING).toContain('shell');
    expect(PAIRING_APPROVE_WARNING).toContain('owner');
  });

  const printed = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join('\n');

  it('ownerId unset: prints the owner-rights warning', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await program.parseAsync(['node', 'test', 'pairing', 'approve', 'ABC123', '--yes']);
    expect(printed()).toContain('gives that person the same rights as the owner');
  });

  it('ownerId set: no owner-rights claim, says the user gets their own identity', async () => {
    vi.mocked(configPkg.loadConfig).mockResolvedValue({
      gateway: { port: 1, token: 't' }, channels: { telegram: { ownerId: '1000001' } },
    } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await program.parseAsync(['node', 'test', 'pairing', 'approve', 'ABC123', '--yes']);
    const out = printed();
    expect(out).not.toContain('gives that person the same rights as the owner');
    expect(out).toContain('own identity');
    expect(out).toContain('without owner rights');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('telegramOwnerConfigured', () => {
    expect(telegramOwnerConfigured(undefined)).toBe(false);
    expect(telegramOwnerConfigured({ channels: { telegram: {} } })).toBe(false);
    expect(telegramOwnerConfigured({ channels: { telegram: { ownerId: '5' } } })).toBe(true);
    expect(PAIRING_APPROVE_WARNING_OWNER_SET).toContain('ownerId');
  });

  it('non-TTY without --yes does not call fetch', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await program.parseAsync(['node', 'test', 'pairing', 'approve', 'ABC123']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('--yes proceeds without a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await program.parseAsync(['node', 'test', 'pairing', 'approve', 'ABC123', '--yes']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('shouldProceed', () => {
  it('decides correctly', () => {
    expect(shouldProceed({ yes: true, isTTY: false })).toBe(true);
    expect(shouldProceed({ isTTY: false })).toBe(false);
    expect(shouldProceed({ isTTY: true, answer: false })).toBe(false);
    expect(shouldProceed({ isTTY: true, answer: true })).toBe(true);
  });
});
