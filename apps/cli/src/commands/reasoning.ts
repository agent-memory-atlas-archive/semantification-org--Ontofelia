 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerReasoningCommand(program: Command) {
  // ---- REASONING COMMANDS ----
  const reasoningCmd = program.command('reasoning').description('Manage reasoning and reflection');
  
  reasoningCmd
    .command('conflicts')
    .description('Show reasoning conflicts')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/reasoning/conflicts`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.red.bold(`\\nConflicts (${list.length}):`));
        list.forEach(c => {
          console.log(`- [${c.type}] ${c.description}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to get conflicts: ${(err as Error).message}`));
      }
    });
  
  reasoningCmd
    .command('reflect')
    .description('Trigger a memory reflection manually')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/reasoning/reflect`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const data = await res.json() as { id: string, conflicts: unknown[], worldviewTriplesCount: number };
        console.log(chalk.green(`✔ Reflection ${data.id} finished. Found ${data.conflicts.length} conflicts. Worldview holds ${data.worldviewTriplesCount} triples.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to trigger reflection: ${(err as Error).message}`));
      }
    });

  reasoningCmd
    .command('catchup')
    .description('Rebuild the inferred graphs now if the reasoning gate left them stale')
    .option('--force', 'rebuild even when nothing is marked stale')
    .action(async (opts: { force?: boolean }) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/reasoning/catchup${opts.force ? '?force=true' : ''}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const data = await res.json() as { status: string, shared?: number, perUser?: Record<string, number>, stillStale?: boolean, error?: string };
        if (data.status === 'ran') {
          console.log(chalk.green(`✔ Inferred graphs rebuilt (shared: ${data.shared} triples, ${Object.keys(data.perUser ?? {}).length} user graph(s)).${data.stillStale ? ' Facts arrived meanwhile; the background job will run again.' : ''}`));
        } else if (data.status === 'failed') {
          console.error(chalk.red(`Catch-up failed: ${data.error}`));
        } else {
          console.log(`Nothing rebuilt: ${data.status}.`);
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to trigger catch-up: ${(err as Error).message}`));
      }
    });
  
}