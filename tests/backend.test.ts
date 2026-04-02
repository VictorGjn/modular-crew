
import { describe, test, expect } from 'bun:test';
import { InProcessBackend } from '../src/backends/inProcessBackend.js';
import { getBackend } from '../src/backends/registry.js';
import { MockProvider } from '../src/studio/mock.js';
describe('Backend', () => {
  test('registry', () => { expect(getBackend('in-process', new MockProvider({ chunkDelay: 0 }))).toBeDefined(); });
  test('spawn+waitAll', async () => {
    const b = new InProcessBackend(new MockProvider({ chunkDelay: 0 }));
    const h = await b.spawn('a1', { agentId: 'a1', systemPrompt: 'test', model: 'mock-model', maxTurns: 5, input: 'go' });
    expect(h.status).toBe('running');
    const r = await b.waitAll(); expect(r.get('a1')!.status).toBe('completed');
    await b.shutdown();
  });
});
