/**
 * E2E test: Product crew — full DAG run with MockProvider
 * Verifies: all steps run in order, facts published, summaries saved
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTeamFile, validateTeam } from '../../src/compiler/team-parser.js';
import { FactBus } from '../../src/facts/fact-bus.js';
import { MockProvider } from '../../src/studio/mock.js';
import { RunStore } from '../../src/store/run-store.js';
import { initSummaryTable, saveStepSummary, summarizeStepOutput, loadStepSummaries } from '../../src/trace/summarizer.js';
import type { Fact } from '../../src/types.js';
import { estimateCost } from '../../src/types.js';
import { unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..', '..', 'templates');
const TEST_DB = '/tmp/.crew-test-product-e2e/runs.db';

describe('Product Crew E2E', () => {
  let store: RunStore;
  let factBus: FactBus;
  let provider: MockProvider;

  beforeEach(() => {
    mkdirSync('/tmp/.crew-test-product-e2e', { recursive: true });
    try { unlinkSync(TEST_DB); } catch {}
    store = new RunStore(TEST_DB);
    factBus = new FactBus();
    provider = new MockProvider({ chunkDelay: 0 });
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  test('runs full DAG pipeline with all steps in order', async () => {
    const teamFile = resolve(TEMPLATES_DIR, 'product-crew.yaml');
    const team = parseTeamFile(teamFile);
    const validation = validateTeam(team);

    expect(validation.valid).toBe(true);
    expect(validation.executionOrder.length).toBeGreaterThan(0);

    const runId = store.createRun(teamFile, team.name, 'Build a login page');
    store.updateRunStatus(runId, 'running');
    initSummaryTable(store.db);

    const model = team.defaults?.model ?? 'claude-sonnet-4-20250514';
    const executedSteps: string[] = [];

    for (const stepId of validation.executionOrder) {
      const step = team.flow[stepId];
      store.createStep(runId, stepId);

      // Skip conditional steps if fact not present
      if (step.when) {
        const condFact = typeof step.when === 'string' ? step.when : step.when.fact;
        const latest = factBus.getLatest(condFact);
        if (!latest) {
          store.updateStep(runId, stepId, { status: 'skipped', duration_ms: 0 });
          continue;
        }
        if (typeof step.when === 'object' && step.when.equals !== undefined) {
          if (latest.value !== step.when.equals) {
            store.updateStep(runId, stepId, { status: 'skipped', duration_ms: 0 });
            continue;
          }
        }
      }

      if (!step.agent) continue;

      const agent = typeof step.agent === 'string'
        ? await provider.resolveAgent(step.agent)
        : { id: stepId, name: stepId, systemPrompt: step.agent.system, model: step.agent.model ?? model, maxTurns: step.agent.maxTurns ?? 15 };

      let output = '', tokIn = 0, tokOut = 0;
      for await (const ev of provider.executeAgent(agent, 'Build a login page')) {
        if (ev.type === 'text') output += String(ev.data);
        if (ev.tokensIn) tokIn += ev.tokensIn;
        if (ev.tokensOut) tokOut += ev.tokensOut;
      }

      // Publish facts
      for (const key of step.publishes ?? []) {
        const fact: Fact = { key, value: `Mock value for ${key}`, source: stepId, timestamp: Date.now(), status: 'final' };
        factBus.publish([fact]);
        store.publishFact(runId, stepId, fact);
      }

      const cost = estimateCost(model, tokIn, tokOut);
      store.updateStep(runId, stepId, { status: 'succeeded', completed_at: new Date().toISOString(), output, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost, duration_ms: 100 });

      const summary = summarizeStepOutput(output, agent.name, stepId);
      saveStepSummary(store.db, { runId, stepId, agentId: agent.name, summary, tokensUsed: tokIn + tokOut, costUsd: cost, durationMs: 100 });

      executedSteps.push(stepId);
    }

    store.completeRun(runId, 'succeeded', { tokens: 0, cost: 0 });

    // Verify: steps ran in DAG order
    expect(executedSteps.length).toBeGreaterThanOrEqual(4); // spec, explore, plan, implement at minimum
    expect(executedSteps[0]).toBe('spec');
    expect(executedSteps.indexOf('explore')).toBeGreaterThan(executedSteps.indexOf('spec'));
    expect(executedSteps.indexOf('plan')).toBeGreaterThan(executedSteps.indexOf('explore'));
    expect(executedSteps.indexOf('implement')).toBeGreaterThan(executedSteps.indexOf('plan'));

    // Verify: facts were published
    const productSpec = factBus.getLatest('product_spec');
    expect(productSpec).toBeDefined();
    const codebaseMap = factBus.getLatest('codebase_map');
    expect(codebaseMap).toBeDefined();
    const implPlan = factBus.getLatest('implementation_plan');
    expect(implPlan).toBeDefined();

    // Verify: summaries saved
    const summaries = loadStepSummaries(store.db, runId);
    expect(summaries.length).toBeGreaterThanOrEqual(4);

    // Verify: run completed in store
    const run = store.getRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('succeeded');
  });

  test('validates product-crew.yaml structure', () => {
    const teamFile = resolve(TEMPLATES_DIR, 'product-crew.yaml');
    const team = parseTeamFile(teamFile);
    const validation = validateTeam(team);

    expect(validation.valid).toBe(true);
    expect(Object.keys(team.flow)).toContain('spec');
    expect(Object.keys(team.flow)).toContain('explore');
    expect(Object.keys(team.flow)).toContain('plan');
    expect(Object.keys(team.flow)).toContain('implement');
    expect(Object.keys(team.flow)).toContain('verify');
    expect(Object.keys(team.flow)).toContain('review');

    // Check hooks are parsed
    expect(team.hooks).toBeDefined();
    expect(team.hooks?.before_run?.length).toBe(1);
    expect(team.hooks?.after_run?.length).toBe(1);
  });
});
