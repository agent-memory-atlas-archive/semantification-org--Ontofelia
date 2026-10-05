import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ExecTool } from '../exec.js';
import { ToolContext } from '@ontofelia/core';
import { NoopSandboxAdapter } from '@ontofelia/sandbox';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('ExecTool', () => {
  it('uses context.sandboxConfig if provided', async () => {
    const sandboxMock = {
      getOrCreate: vi.fn().mockResolvedValue('sandbox-id'),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' })
    } as unknown as ConstructorParameters<typeof ExecTool>[0];
    
    const tool = new ExecTool(sandboxMock);
    
    const context: ToolContext = {
      agentId: 'a1',
      sessionId: 's1',
      workspacePath: '/ws',
      channelType: 'cli',
      senderId: 'usr',
      isOwner: true,
      sandboxConfig: { scope: 'agent', workspaceAccess: 'ro' }
    };

    await tool.execute({ command: 'echo hello' }, context);
    
    expect(sandboxMock.getOrCreate).toHaveBeenCalledWith(
      'a1', 's1', { scope: 'agent', workspaceAccess: 'ro' }, '/ws'
    );
    expect(sandboxMock.exec).toHaveBeenCalledWith(
      'sandbox-id', 'echo hello', expect.anything()
    );
  });

  describe('self-restart guardrail', () => {
    const forbidden = [
      'node apps/cli/dist/index.js gateway restart',
      'cd /home/user/Ontofelia && bash run-gateway.sh gateway restart',
      'run-gateway.sh gateway stop',
      'gateway start',
      'bash ~/ontofelia-docker/run.sh',
      'docker restart ontofelia-gateway',
      'docker stop ontofelia-gateway',
      'pkill -f node',
      'killall node',
      'kill -9 1',
      'systemctl restart ontofelia',
      // Extended lifecycle guard: unit operations in either word order,
      // service(8), kills matching the gateway process, and the run script
      // with or without extension — in ANY directory.
      'systemctl stop ontofelia-gateway.service',
      'sudo systemctl kill ontofelia',
      'systemctl --user ontofelia-gateway disable',
      'systemctl disable ontofelia-gateway',
      'service ontofelia-gateway stop',
      'sudo service ontofelia restart',
      'pkill -f ontofelia',
      'killall ontofelia-gateway',
      'pkill -f "node.*gateway"',
      'kill -9 $(pgrep -f ontofelia)',
      'kill $(pidof node)',
      'cd /tmp && bash /opt/ontofelia/run-gateway',
      // Gateway kill-guard gaps found in review: compose teardown (space and
      // hyphen forms, with or without an explicit service target) and fuser -k
      // on the gateway's listener port.
      'docker compose down',
      'docker compose stop ontofelia',
      'docker-compose down',
      'fuser -k 18780/tcp',
    ];
    for (const cmd of forbidden) {
      it(`refuses self-destructive command: ${cmd}`, async () => {
        const sandboxMock = { getOrCreate: vi.fn(), exec: vi.fn() } as unknown as ConstructorParameters<typeof ExecTool>[0];
        const tool = new ExecTool(sandboxMock);
        const ctx: ToolContext = {
          agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
          senderId: 'usr', isOwner: true,
        } as ToolContext;
        const res = await tool.execute({ command: cmd }, ctx);
        expect(res.success).toBe(false);
        expect((res.output as { exitCode?: number }).exitCode).toBe(126);
        // the command must NOT have reached the sandbox
        expect(sandboxMock.getOrCreate).not.toHaveBeenCalled();
        expect(sandboxMock.exec).not.toHaveBeenCalled();
      });
    }

    const allowed = [
      'echo hello',
      'grep -rn "gateway" packages/',          // mentions gateway but not a lifecycle verb
      'node build.js',
      'git status',
      'pnpm --filter @ontofelia/eval test',
      'systemctl status ontofelia',            // status query, not a lifecycle verb
      'systemctl restart nginx',               // other units stay manageable
      'ps aux | grep gateway',                 // observing the process is fine
      'docker ps',                             // listing containers is fine
      'docker compose ps',                     // compose status, not a teardown verb
      'fuser 18780/tcp',                       // querying the port (no -k) is fine
    ];
    for (const cmd of allowed) {
      it(`allows benign command: ${cmd}`, async () => {
        const sandboxMock = {
          getOrCreate: vi.fn().mockResolvedValue('sb'),
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        } as unknown as ConstructorParameters<typeof ExecTool>[0];
        const tool = new ExecTool(sandboxMock);
        const ctx: ToolContext = {
          agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
          senderId: 'usr', isOwner: true,
        } as ToolContext;
        await tool.execute({ command: cmd }, ctx);
        expect(sandboxMock.exec).toHaveBeenCalled();
      });
    }
  });

  describe('timeout handling (BUG-B)', () => {
    const ctx: ToolContext = {
      agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
      senderId: 'usr', isOwner: true,
    } as ToolContext;
    const mkSandbox = (result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }) => ({
      getOrCreate: vi.fn().mockResolvedValue('sb'),
      exec: vi.fn().mockResolvedValue(result),
    } as unknown as ConstructorParameters<typeof ExecTool>[0]);

    it('defaults the per-command timeout when none is given', async () => {
      const sandboxMock = mkSandbox({ exitCode: 0, stdout: '', stderr: '' });
      await new ExecTool(sandboxMock).execute({ command: 'echo hi' }, ctx);
      const opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts.timeoutMs).toBe(ExecTool.DEFAULT_TIMEOUT_MS);
    });

    it('passes a caller timeout through and clamps it to the max', async () => {
      const sandboxMock = mkSandbox({ exitCode: 0, stdout: '', stderr: '' });
      const tool = new ExecTool(sandboxMock);
      await tool.execute({ command: 'pnpm build', timeout: 600_000 }, ctx);
      let opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts.timeoutMs).toBe(600_000); // honored, not capped at 30s

      await tool.execute({ command: 'pnpm build', timeout: 99_999_999 }, ctx);
      opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[1][2];
      expect(opts.timeoutMs).toBe(ExecTool.MAX_TIMEOUT_MS); // clamped
    });

    it('exposes an executor-level ceiling above the max command timeout', () => {
      // ToolExecutor times out at `tool.timeoutMs`; it must exceed MAX so exec's
      // own timeout always fires first and returns a clean timedOut result.
      const tool = new ExecTool(mkSandbox({ exitCode: 0, stdout: '', stderr: '' }));
      expect(tool.timeoutMs).toBeGreaterThan(ExecTool.MAX_TIMEOUT_MS);
    });

    it('returns an actionable, non-crashing result on timeout', async () => {
      const sandboxMock = mkSandbox({ exitCode: 124, stdout: 'partial', stderr: 'boom', timedOut: true });
      const res = await new ExecTool(sandboxMock).execute({ command: 'pnpm build' }, ctx);
      expect(res.success).toBe(false);
      const out = res.output as { timedOut?: boolean; stderr?: string };
      expect(out.timedOut).toBe(true);
      expect(out.stderr).toMatch(/timed out/i);
      expect(out.stderr).toMatch(/larger `?timeout`?/i);
    });
  });

  describe('build/install classifier', () => {
    const positives = [
      'pnpm install', 'pnpm i', 'pnpm ci', 'pnpm add left-pad', 'pnpm build', 'pnpm run build',
      'pnpm rebuild', 'npm install', 'npm ci', 'npm run build', 'yarn install', 'yarn add x',
      'yarn build', 'turbo build', 'turbo run build', 'cargo build', 'cargo build --release',
      'npx tsc -b', 'cd x && pnpm install', 'echo hi; npm ci', 'ls | pnpm build',
      'false || cargo build', 'CI=1 pnpm install --frozen-lockfile',
      'pnpm --filter @scope/pkg build', 'pnpm -F pkg build', 'pnpm -r build', 'pnpm --dir x install',
      'pnpm -C x install', 'npm --prefix x install', 'npm --prefix x run build', 'pnpm -w install',
      'pnpm --filter=pkg build', 'pnpm -r --workspace-concurrency=1 build', 'pnpm --filter x add left-pad',
      'yarn workspace pkg build', 'yarn workspace @scope/pkg add x', 'yarn --cwd x install',
      'cd x && pnpm --filter y build',
      // documented false refusal: a package literally named like a verb
      'pnpm --filter build test',
    ];
    for (const cmd of positives) {
      it(`matches: ${cmd}`, () => expect(ExecTool.isBuildLike(cmd)).toBe(true));
    }
    const negatives = [
      'pnpm test', 'npm run lint', 'ls build/', 'echo install', 'pnpm --filter x test',
      'cargo test', 'cargo check', 'git status', 'npx tsc --noEmit', 'turbo test',
      'pnpm install-test', 'cat install.log && echo build', 'grep -rn "pnpm install" docs/',
      'npm run builder', '',
      'pnpm -r lint', 'pnpm -r test', 'npm --prefix x run test', 'npm --prefix x test',
      'pnpm --filter x lint', 'pnpm --dir x test', 'yarn workspace pkg test', 'yarn workspace build lint',
      'pnpm --filter x --filter y typecheck',
    ];
    for (const cmd of negatives) {
      it(`does not match: ${JSON.stringify(cmd)}`, () => expect(ExecTool.isBuildLike(cmd)).toBe(false));
    }
  });

  describe('build/install lock', () => {
    let root: string;
    let binDir: string;
    let origPath: string | undefined;
    const mkctx = (workspacePath: string): ToolContext => ({
      agentId: 'a1', sessionId: 's1', workspacePath, channelType: 'cli',
      senderId: 'usr', isOwner: true,
    } as ToolContext);
    const mkdir = (name: string) => {
      const d = path.join(root, name);
      fs.mkdirSync(d);
      return d;
    };
    const blocked = (res: { output: unknown; auditEntry?: { output?: unknown } }) =>
      (res.auditEntry?.output as { blocked?: boolean } | undefined)?.blocked === true;

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-lock-'));
      binDir = path.join(root, 'bin');
      fs.mkdirSync(binDir);
      // Fake package manager: never installs anything. Sleeps for FAKE_SLEEP
      // seconds (default 1) and exits with FAKE_EXIT (default 0).
      const fake = path.join(binDir, 'pnpm');
      fs.writeFileSync(fake, '#!/bin/sh\nsleep "${FAKE_SLEEP:-1}"\nexit "${FAKE_EXIT:-0}"\n');
      fs.chmodSync(fake, 0o755);
      origPath = process.env.PATH;
      process.env.PATH = `${binDir}:${origPath ?? ''}`;
    });
    afterAll(() => {
      process.env.PATH = origPath;
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('lets exactly one of two concurrent builds in the same cwd run', async () => {
      const cwd = mkdir('same');
      const tool = new ExecTool(new NoopSandboxAdapter());
      const [a, b] = await Promise.all([
        tool.execute({ command: 'pnpm install' }, mkctx(cwd)),
        tool.execute({ command: 'pnpm build' }, mkctx(cwd)),
      ]);
      const results = [a, b];
      const refused = results.filter(blocked);
      expect(refused).toHaveLength(1);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const out = refused[0].output as { exitCode: number; stderr: string };
      expect(out.exitCode).toBe(126);
      expect(refused[0].success).toBe(false);
      expect(out.stderr).toMatch(/already running in .*same; wait for it to finish/);
    });

    it('shares the lock across ExecTool instances and across symlinked paths', async () => {
      const cwd = mkdir('real');
      const link = path.join(root, 'link');
      fs.symlinkSync(cwd, link);
      const [a, b] = await Promise.all([
        new ExecTool(new NoopSandboxAdapter()).execute({ command: 'pnpm install' }, mkctx(cwd)),
        new ExecTool(new NoopSandboxAdapter()).execute({ command: 'pnpm install', cwd: link }, mkctx('/unused')),
      ]);
      expect([a, b].filter(blocked)).toHaveLength(1);
    });

    it('lets the same command run in two different cwds', async () => {
      const c1 = mkdir('one');
      const c2 = mkdir('two');
      const tool = new ExecTool(new NoopSandboxAdapter());
      const res = await Promise.all([
        tool.execute({ command: 'pnpm install' }, mkctx(c1)),
        tool.execute({ command: 'pnpm install' }, mkctx(c2)),
      ]);
      expect(res.filter(blocked)).toHaveLength(0);
      expect(res.every((r) => r.success)).toBe(true);
    });

    it('does not block a non-build command next to a running build', async () => {
      const cwd = mkdir('mixed');
      const tool = new ExecTool(new NoopSandboxAdapter());
      const build = tool.execute({ command: 'pnpm install' }, mkctx(cwd));
      const other = await tool.execute({ command: 'echo hello' }, mkctx(cwd));
      expect(blocked(other)).toBe(false);
      expect(other.success).toBe(true);
      expect((await build).success).toBe(true);
    });

    it('releases the lock after a timeout', async () => {
      const cwd = mkdir('timeout');
      const tool = new ExecTool(new NoopSandboxAdapter());
      const slow = await tool.execute({ command: 'FAKE_SLEEP=30 pnpm install', timeout: 200 }, mkctx(cwd));
      expect((slow.output as { timedOut: boolean }).timedOut).toBe(true);
      const next = await tool.execute({ command: 'FAKE_SLEEP=0 pnpm install' }, mkctx(cwd));
      expect(blocked(next)).toBe(false);
      expect(next.success).toBe(true);
    });

    it('releases the lock after a non-zero exit', async () => {
      const cwd = mkdir('fail');
      const tool = new ExecTool(new NoopSandboxAdapter());
      const failed = await tool.execute({ command: 'FAKE_SLEEP=0 FAKE_EXIT=3 pnpm install' }, mkctx(cwd));
      expect((failed.output as { exitCode: number }).exitCode).toBe(3);
      expect(blocked(failed)).toBe(false);
      const next = await tool.execute({ command: 'FAKE_SLEEP=0 pnpm install' }, mkctx(cwd));
      expect(blocked(next)).toBe(false);
      expect(next.success).toBe(true);
    });

    it('releases the lock when the sandbox throws', async () => {
      const cwd = mkdir('throws');
      const throwing = {
        getOrCreate: vi.fn().mockResolvedValue('sb'),
        exec: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as ConstructorParameters<typeof ExecTool>[0];
      await expect(new ExecTool(throwing).execute({ command: 'pnpm install' }, mkctx(cwd))).rejects.toThrow('boom');
      const next = await new ExecTool(new NoopSandboxAdapter())
        .execute({ command: 'FAKE_SLEEP=0 pnpm install' }, mkctx(cwd));
      expect(blocked(next)).toBe(false);
      expect(next.success).toBe(true);
    });
  });
});
