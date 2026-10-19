import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '@ontofelia/config';
import { writeVaultNotes } from '@ontofelia/semantic-memory';

interface VaultImportReport {
  runId: string;
  apply: boolean;
  notes: {
    path: string;
    status: string;
    reason?: string;
    facts: unknown[];
  }[];
  totals: Record<string, number>;
}

interface VaultExportResponse {
  notes: { path: string; content: string }[];
  totals?: Record<string, number>;
}

/**
 * Re-validates a note path received from the server (never trusted): exactly
 * `<folder>/<name>.md`, no absolute path, `..`, `.`, backslash, NUL or empty segment.
 */
export function assertSafeNotePath(rel: unknown): string {
  const ok = typeof rel === 'string'
    && !path.isAbsolute(rel) && !rel.includes('\\') && !rel.includes('\0')
    && rel.split('/').length === 2
    && rel.split('/').every(p => p !== '' && p !== '.' && p !== '..')
    && rel.endsWith('.md') && rel.split('/')[1] !== '.md';
  if (!ok) {
    throw new Error(`Server returned an unsafe note path: ${JSON.stringify(String(rel).slice(0, 80))}`);
  }
  return rel as string;
}

/** Directory basename reduced to [A-Za-z0-9_-], at most 64 characters. */
export function sanitiseVaultName(dir: string): string {
  const base = path.basename(path.resolve(dir));
  return base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export function registerVaultCommand(program: Command) {
  const vaultCmd = program.command('vault').description('Work with Vault-LD folders');

  vaultCmd
    .command('import')
    .description('Import a Vault-LD folder into the knowledge store (dry run unless --apply)')
    .argument('<dir>', 'Vault folder')
    .option('--apply', 'Write the facts (default: dry run)')
    .option('--name <vaultName>', 'Vault name (default: sanitised folder name)')
    .option('--agent <id>', 'Agent id')
    .option('--json', 'Print the raw report as JSON')
    .action(async (dir: string, opts: { apply?: boolean; name?: string; agent?: string; json?: boolean }) => {
      try {
        const config = await loadConfig();
        const body: Record<string, unknown> = {
          root: path.resolve(dir),
          vaultName: opts.name ?? sanitiseVaultName(dir),
          apply: opts.apply === true,
        };
        if (opts.agent) body.agentId = opts.agent;

        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/knowledge/vault-import`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.gateway.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          let detail = '';
          try {
            const err = await res.json() as { error?: string };
            detail = err.error ? ` - ${err.error}` : '';
          } catch { /* no JSON body */ }
          throw new Error(`HTTP ${res.status}${detail}`);
        }
        const report = await res.json() as VaultImportReport;

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (!report.apply) {
          console.log(chalk.yellow('Dry run — nothing written. Re-run with --apply to import.'));
        }
        for (const n of report.notes) {
          const detail = `${n.facts.length} facts${n.reason ? `, ${n.reason}` : ''}`;
          console.log(`${n.status.padEnd(12)}  ${n.path}  (${detail})`);
        }
        const totals = Object.entries(report.totals).map(([k, v]) => `${k}: ${v}`).join(', ');
        console.log(`Totals: ${report.notes.length} notes${totals ? ` (${totals})` : ''}`);
      } catch (err: unknown) {
        console.error(chalk.red(`Vault import failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  vaultCmd
    .command('export')
    .description('Export the agent\'s tool-sourced facts as a Vault-LD folder (the gateway writes nothing; this command does)')
    .argument('<dir>', 'Target folder (created when missing; must be empty unless --overwrite)')
    .option('--overwrite', 'Allow a non-empty folder (never deletes; only replaces the export\'s own files)')
    .option('--agent <id>', 'Agent id')
    .option('--json', 'Print the report as JSON')
    .action(async (dir: string, opts: { overwrite?: boolean; agent?: string; json?: boolean }) => {
      try {
        const config = await loadConfig();
        const query = opts.agent ? `?agentId=${encodeURIComponent(opts.agent)}` : '';
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/knowledge/vault-export${query}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` },
        });
        if (!res.ok) {
          let detail = '';
          try {
            const err = await res.json() as { error?: string };
            detail = err.error ? ` - ${err.error}` : '';
          } catch { /* no JSON body */ }
          throw new Error(`HTTP ${res.status}${detail}`);
        }
        const body = await res.json() as VaultExportResponse;
        if (!body || !Array.isArray(body.notes)) throw new Error('Malformed export response');
        const notes = body.notes.map(n => {
          if (!n || typeof n.content !== 'string') throw new Error('Malformed export response');
          return { path: assertSafeNotePath(n.path), content: n.content };
        });

        const written = await writeVaultNotes(notes, { dir: path.resolve(dir), overwrite: opts.overwrite === true });
        if (opts.json) {
          console.log(JSON.stringify({ dir: written.dir, notesWritten: written.notesWritten, paths: written.paths, totals: body.totals ?? {} }, null, 2));
          return;
        }
        console.log(`Wrote ${written.notesWritten} notes to ${written.dir}`);
      } catch (err: unknown) {
        console.error(chalk.red(`Vault export failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
