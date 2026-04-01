/**
 * Integration test: Coordinator mode run
 * Verifies that when a team YAML has mode: coordinator,
 * the CoordinatorEngine is used instead of the DAG loop.
 */
import { describe, test, expect } from 'bun:test';
import { CoordinatorEngine } from '../src/orchestrator/coordinatorEngine.js';
import { InMemoryMailbox } from '../src/facts/mailbox.js';
import { MockProvider } from '../src/studio/mock.js';
import { FactBus } from '../src/facts/fact-bus.js';

describe('Coordinator Run Integration', () => {
  test('detects coordinator mode and runs via CoordinatorEngine', async () => {
    const mailbox = new InMemoryMailbox();
    const provider = new MockProvider();
    const factBus = new FactBus();
    const engine = new CoordinatorEngine(mailbox, provider, factBus);

    const team = {
      name: 'test-coordinator',
      task: 'Write a simple report',
      config: { scratchpad: true, maxWorkers: 3, maxRounds: 5 },
      agents: {
        lead: { name: 'lead', role: 'Coordinate the team', isCoordinator: true, system: 'You are the coordinator.' },
        researcher: { name: 'researcher', role: 'Research topics', isCoordinator: false, system: 'You research.' },
        writer: { name: 'writer', role: 'Write content', isCoordinator: false, system: 'You write.' },
      },
    };

    const result = await engine.run(team, 'test-run-001');

    expect(result.status).toBe('succeeded');
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.rounds).toBeLessThanOrEqual(5);
    expect(result.agentResults.size).toBeGreaterThan(0);
    expect(result.totalTokensIn).toBeGreaterThanOrEqual(0);
    expect(result.totalTokensOut).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test('coordinator receives messages from workers', async () => {
    const mailbox = new InMemoryMailbox();
    const provider = new MockProvider();
    const factBus = new FactBus();
    const engine = new CoordinatorEngine(mailbox, provider, factBus);

    const team = {
      name: 'msg-test',
      task: 'Test messaging',
      config: { scratchpad: false, maxWorkers: 2, maxRounds: 3 },
      agents: {
        coord: { name: 'coord', role: 'Coordinator', isCoordinator: true, system: 'Coordinate.' },
        worker1: { name: 'worker1', role: 'Worker', isCoordinator: false, system: 'Work.' },
      },
    };

    const result = await engine.run(team, 'test-run-002');
    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe('test-run-002');
  });
});
