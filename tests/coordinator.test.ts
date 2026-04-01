
import { describe, test, expect } from 'bun:test';
import { CoordinatorEngine } from '../src/orchestrator/coordinatorEngine.js';
import { InMemoryMailbox } from '../src/facts/mailbox.js';
import { FactBus } from '../src/facts/fact-bus.js';
import { MockProvider } from '../src/studio/mock.js';
describe('Coordinator', () => {
  test('creates engine', () => {
    const e = new CoordinatorEngine(new InMemoryMailbox(), new MockProvider({ chunkDelay: 0 }), new FactBus());
    expect(e).toBeDefined();
  });
});
