import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getDefaultConfig, validateConfig, saveConfig, loadConfig } from '../index.js';

describe('config package', () => {
  const tempDir = path.join(os.tmpdir(), 'ontofelia-test-config');
  const tempConfigFile = path.join(tempDir, 'ontofelia.json5');

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('should provide default config', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.gateway.port).toBe(18780);
  });

  it('should validate valid config', () => {
    const config = getDefaultConfig();
    config.gateway.token = 'secret123';
    
    const result = validateConfig(config);
    expect(result.isOk()).toBe(true);
  });

  it('should save and load config', async () => {
    const config = getDefaultConfig();
    config.gateway.token = 'test-token';
    config.gateway.port = 9999;
    
    await saveConfig(config, tempConfigFile);
    
    const loaded = await loadConfig(tempConfigFile);
    expect(loaded.gateway.token).toBe('test-token');
    expect(loaded.gateway.port).toBe(9999);
  });

  it('should apply environment fallbacks', async () => {
    const config = getDefaultConfig();
    config.gateway.token = 'default-token';
    await saveConfig(config, tempConfigFile);
    
    vi.stubEnv('ONTOFELIA_TOKEN', 'env-token');
    vi.stubEnv('ONTOFELIA_PORT', '8888');
    
    const loaded = await loadConfig(tempConfigFile);
    expect(loaded.gateway.token).toBe('env-token');
    expect(loaded.gateway.port).toBe(8888);
  });

  describe('keys that never had an effect', () => {
    it('are absent from the default config', () => {
      const config = getDefaultConfig() as Record<string, unknown>;
      expect(config).not.toHaveProperty('messages');
      expect(config).not.toHaveProperty('routing');
      expect(config).not.toHaveProperty('commands');
      expect(config.session).not.toHaveProperty('scope');
      expect(config.security).not.toHaveProperty('requireGuardian');
      // Neighbouring live keys are untouched.
      expect(config.session).toHaveProperty('maxHistory');
      expect(config.security).toHaveProperty('guardianTimeoutMs');
    });

    it('in an existing config file still load and are dropped', async () => {
      await fs.writeFile(tempConfigFile, `{
        messages: { maxContext: 5, truncateAt: 100 },
        routing: { agents: { a: {} } },
        commands: { prefix: '!', allowAdminOnly: true },
        session: { scope: 'main', maxHistory: 7 },
        security: { requireGuardian: false, guardianTimeoutMs: 1234 },
      }`, 'utf-8');

      const loaded = (await loadConfig(tempConfigFile)) as Record<string, unknown>;
      expect(loaded).not.toHaveProperty('messages');
      expect(loaded).not.toHaveProperty('routing');
      expect(loaded).not.toHaveProperty('commands');
      expect(loaded.session).not.toHaveProperty('scope');
      expect(loaded.security).not.toHaveProperty('requireGuardian');
      // Live keys in the same sections are kept.
      expect((loaded.session as { maxHistory: number }).maxHistory).toBe(7);
      expect((loaded.security as { guardianTimeoutMs: number }).guardianTimeoutMs).toBe(1234);
    });
  });
});
