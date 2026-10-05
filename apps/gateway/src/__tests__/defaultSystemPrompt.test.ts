import { describe, it, expect } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT } from '../defaultSystemPrompt.js';

describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('keeps the FORGET/DELETE rule', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/FORGET or DELETE/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/MUST call memory_retract/);
  });

  it('tells the model that corrections supersede automatically', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/CORRECTS or UPDATES/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/supersession/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/do NOT call memory_retract for corrections/);
  });
});
