import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dependenciesStale } from '../commands/rebuild.js';

describe('dependenciesStale', () => {
  let root: string;
  const marker = () => path.join(root, 'node_modules', '.modules.yaml');
  const lock = () => path.join(root, 'pnpm-lock.yaml');
  const at = (file: string, seconds: number) => fs.utimesSync(file, seconds, seconds);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-stale-'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(lock(), 'lockfileVersion: 9\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is stale when the install marker is missing', () => {
    expect(dependenciesStale(root)).toBe(true);
  });

  it('is stale when the lockfile is newer than the marker', () => {
    fs.writeFileSync(marker(), '');
    at(marker(), 1_000_000);
    at(lock(), 2_000_000);
    expect(dependenciesStale(root)).toBe(true);
  });

  it('is not stale when the marker is newer than the lockfile', () => {
    fs.writeFileSync(marker(), '');
    at(lock(), 1_000_000);
    at(marker(), 2_000_000);
    expect(dependenciesStale(root)).toBe(false);
  });
});
