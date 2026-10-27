import { describe, it, expect, vi, afterEach } from 'vitest';
import { FusekiAdapter } from '../adapters/FusekiAdapter.js';

const originalFetch = global.fetch;

describe('FusekiAdapter.query', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('passes an AbortSignal and keeps the Timeout header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ head: { vars: [] }, results: { bindings: [] } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new FusekiAdapter();
    await adapter.initialize({ backend: 'fuseki', type: 'sidecar', dataDir: '', port: 0, endpoint: 'http://127.0.0.1:1/ds' });
    await adapter.query('SELECT * WHERE { ?s ?p ?o }');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['Timeout']).toBe('30000');
  });
});
