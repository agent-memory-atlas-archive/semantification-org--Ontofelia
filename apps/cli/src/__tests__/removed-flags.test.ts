import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerOnboardCommand } from '../commands/onboard.js';
import { registerGatewayCommand } from '../commands/gateway.js';
import { registerStatusCommand } from '../commands/status.js';

function flagsOf(cmd: Command | undefined): string[] {
  return (cmd?.options ?? []).map((o) => o.long ?? o.short ?? '');
}

describe('CLI flags without an effect are not declared', () => {
  const program = new Command();
  registerOnboardCommand(program);
  registerGatewayCommand(program);
  registerStatusCommand(program);

  const onboard = program.commands.find((c) => c.name() === 'onboard');
  const status = program.commands.find((c) => c.name() === 'status');
  const gateway = program.commands.find((c) => c.name() === 'gateway');
  const start = gateway?.commands.find((c) => c.name() === 'start');

  it('onboard has no --install-daemon but keeps --non-interactive', () => {
    expect(flagsOf(onboard)).not.toContain('--install-daemon');
    expect(flagsOf(onboard)).toContain('--non-interactive');
  });

  it('gateway start has no --verbose but keeps --foreground', () => {
    expect(flagsOf(start)).not.toContain('--verbose');
    expect(flagsOf(start)).toContain('--foreground');
  });

  it('status has no --usage but keeps --json', () => {
    expect(flagsOf(status)).not.toContain('--usage');
    expect(flagsOf(status)).toContain('--json');
  });
});
