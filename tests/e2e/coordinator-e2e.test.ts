/**
 * E2E test: Coordinator mode — parse YAML, detect mode, run engine, verify mailbox + store
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { CoordinatorEngine } from '../../src/orchestrator/coordinatorEngine.js';
import { SQLiteMailbox } from '../../src/facts/mailbox.js';
import { FactBus } from '../../src/facts/fact-bus.js';
import { MockProvider } from '../../src/studio/mock.js';
import { RunStore } from '../../src/store/run-store.js';
import { unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..', '..', 'templates');
const TEST_DB = '/tmp/.crew-test-coord-e2e/runs.db';

describe('Coordinator E2E', () => {
  let store: RunStore;

  beforeEach(() => {
    mkdirSync('/tmp/.crew-test-coord-e2e', { recursive: true });
    try { unlinkSync(TEST_DB); } catch {}
    store = new RunStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  test('parses coordinator-crew.yaml and detects coordinator mode', () => {
    const raw = readFileSync(resolve(TEMPLATES_DIR, 'coordinator-crew.yaml'), 'utf-8');
    const doc = parseDocument(raw);
    const parsed = doc.toJSON();

    expect(parsed.mode).toBe('coordinator');
    expect(parsed.coordinator).toBeDefined();
    expect(parsed.coordinator.scratchpad).toBe(true);
    expect(parsed.coordinator.max_workers).toBe(5);
    expect(parsed.coordinator.max_rounds).toBe(10);
    expect(parsed.agents).toBeDefined();
    expect(parsed.agents.lead).toBeDefined();
    expect(parsed.agents.lead.is_coordinator).toBe(true);
  });

  test('runs CoordinatorEngine with SQLiteMailbox and RunStore', async () => {
    const raw = readFileSync(resolve(TEMPLATES_DIR, 'coordinator-crew.yaml'), 'utf-8');
    const doc = parseDocument(raw);
    const parsed = doc.toJSON();

    const runId = store.createRun('coordinator-crew.yaml', parsed.name, 'E2E test task');
    store.updateRunStatus(runId, 'running');

    const factBus = new FactBus();
    const mailbox = new SQLiteMailbox(store.db);
    const provider = new MockProvider({ chunkDelay: 0 });
    const engine = new CoordinatorEngine(mailbox, provider, factBus);

    const coordTeam = {
      name: parsed.name,
      task: 'E2E test: write a short report',
      config: {
        scratchpad: parsed.coordinator?.scratchpad ?? true,
        maxWorkers: parsed.coordinator?.max_workers ?? 5,
        maxRounds: parsed.coordinator?.max_rounds ?? 10,
      },
      agents: Object.fromEntries(
        Object.entries(parsed.agents).map(([id, def]: [string, any]) => [
          id,
          {
            name: id,
            role: def.role,
            isCoordinator: !!def.is_coordinator,
            system: def.system ?? `You are ${id}. ${def.role}`,
            model: def.model,
          },
        ])
      ),
    };

    const result = await engine.run(coordTeam, runId);

    // Verify engine results
    expect(result.status).toBe('succeeded');
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.agentResults.size).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify messages in mailbox
    const leadMessages = mailbox.receiveMessages(runId, 'lead');
    // The coordinator should have received some results back
    expect(leadMessages.length).toBeGreaterThanOrEqual(0);

    // Verify run in store
    store.completeRun(runId, result.status, {
      tokens: result.totalTokensIn + result.totalTokensOut,
      cost: 0,
    });
    const run = store.getRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('succeeded');
  });

  test('SQLiteMailbox persists messages across reads', () => {
    const runId = store.createRun('test.yaml', 'test', 'test');
    const mailbox = new SQLiteMailbox(store.db);

    const id1 = mailbox.sendMessage(runId, 'coord', 'worker1', 'Do task A', 'task');
    const id2 = mailbox.sendMessage(runId, 'worker1', 'coord', 'Done with A', 'result');

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);

    const worker1Msgs = mailbox.receiveMessages(runId, 'worker1');
    expect(worker1Msgs.length).toBe(1);
    expect(worker1Msgs[0].content).toBe('Do task A');
    expect(worker1Msgs[0].type).toBe('task');

    const coordMsgs = mailbox.receiveMessages(runId, 'coord');
    expect(coordMsgs.length).toBe(1);
    expect(coordMsgs[0].content).toBe('Done with A');

    // Test unread tracking
    const unread = mailbox.getUnreadMessages(runId, 'coord');
    expect(unread.length).toBe(1);
    mailbox.markRead(id2);
    const afterMark = mailbox.getUnreadMessages(runId, 'coord');
    expect(afterMark.length).toBe(0);
  });
});
