 
import { Command } from 'commander';
import chalk from 'chalk';


import { confirm } from '@inquirer/prompts';
import { loadConfig } from '@ontofelia/config';

export const PAIRING_APPROVE_WARNING =
  'WARNING: Approving a Telegram pairing gives that person the same rights as the owner: ' +
  'shell access on this host through the agent (exec tool), owner commands, and access to ' +
  "the owner's private memory. Only approve accounts that belong to you. " +
  'Separate per-user identities are planned but not implemented yet. ' +
  'Discord users are not treated as the owner.';

export const PAIRING_APPROVE_WARNING_OWNER_SET =
  'Note: channels.telegram.ownerId is set. The approved Telegram user gets their own identity ' +
  "and a private memory, without owner rights (no owner commands, no owner memory). " +
  'Only the configured owner account is the owner. Discord users are not treated as the owner.';

export const PAIRING_LIST_NOTE =
  'Note: approving a Telegram request grants owner rights (shell access, owner commands, owner memory).';

export const PAIRING_LIST_NOTE_OWNER_SET =
  'Note: channels.telegram.ownerId is set; approved Telegram users get their own identity without owner rights.';

type OwnerAwareConfig = { channels?: { telegram?: { ownerId?: string | number } } } | undefined;

/** True when the Telegram owner id is configured, so approval grants no owner rights. */
export function telegramOwnerConfigured(config: OwnerAwareConfig): boolean {
  const id = config?.channels?.telegram?.ownerId;
  return id !== undefined && id !== null && String(id) !== '';
}

/** Best effort: an unreadable config means the conservative legacy warning. */
async function ownerConfigured(): Promise<boolean> {
  try {
    return telegramOwnerConfigured((await loadConfig()) as OwnerAwareConfig);
  } catch {
    return false;
  }
}

/** Decide whether `pairing approve` may proceed. `answer` is the confirmation result when prompted. */
export function shouldProceed(opts: { yes?: boolean; isTTY?: boolean; answer?: boolean }): boolean {
  if (opts.yes) return true;
  if (!opts.isTTY) return false;
  return opts.answer === true;
}



export function registerPairingCommand(program: Command) {
  // ---- PAIRING COMMANDS ----
  const pairingCmd = program.command('pairing').description('Manage channel pairing requests');
  
  pairingCmd
    .command('list')
    .description('List pending pairing requests')
    .argument('[channel]', 'Filter by channel')
    .action(async (channel) => {
      try {
        const config = await loadConfig();
        const url = new URL(`http://127.0.0.1:${config.gateway.port}/api/pairing`);
        if (channel) url.searchParams.set('channel', channel);
        
        const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${config.gateway.token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const requests = await res.json() as { code: string, channel: string, senderId: string, displayName?: string, createdAt: string }[];
        console.log(chalk.blue.bold(`\nPending Pairing Requests (${requests.length}):`));
        requests.forEach(r => {
          console.log(`${chalk.yellow(r.code)}: ${r.channel} user ${r.displayName || r.senderId} (${r.senderId}) - requested at ${new Date(r.createdAt).toLocaleString()}`);
        });
        if (requests.length > 0) {
          const note = telegramOwnerConfigured(config as OwnerAwareConfig) ? PAIRING_LIST_NOTE_OWNER_SET : PAIRING_LIST_NOTE;
          console.log(chalk.yellow(`\n${note}`));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list pairing requests: ${(err as Error).message}`));
      }
    });
  
  pairingCmd
    .command('approve')
    .description('Approve a pairing request')
    .argument('<code>', 'The pairing code')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (code, options: { yes?: boolean }) => {
      try {
        const ownerSet = await ownerConfigured();
        console.log(chalk.yellow(ownerSet ? PAIRING_APPROVE_WARNING_OWNER_SET : PAIRING_APPROVE_WARNING));
        const isTTY = Boolean(process.stdin.isTTY);
        if (!options.yes && !isTTY) {
          console.error(chalk.red('Refusing to approve without confirmation in a non-interactive session. Pass --yes to approve.'));
          process.exitCode = 1;
          return;
        }
        const answer = options.yes || !isTTY
          ? undefined
          : await confirm({ message: ownerSet ? 'Approve this pairing (the user gets their own identity, no owner rights)?' : 'Approve this pairing and grant owner rights?', default: false });
        if (!shouldProceed({ yes: options.yes, isTTY, answer })) {
          console.log(chalk.gray('Cancelled.'));
          return;
        }
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/pairing/approve`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing request ${code} approved.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to approve pairing request: ${(err as Error).message}`));
      }
    });
  
  pairingCmd
    .command('reject')
    .description('Reject a pairing request')
    .argument('<code>', 'The pairing code')
    .action(async (code) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/pairing/reject`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing request ${code} rejected.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to reject pairing request: ${(err as Error).message}`));
      }
    });
  
}