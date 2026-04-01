import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RunStore } from '../../src/store/run-store.js';
import { FactBus } from '../../src/facts/fact-bus.js';
import { MockProvider } from '../../src/studio/mock.js';
import { loadResumeState, restoreFacts, getStepsToExecute } from '../../src/orchestrator/resume.js';
import type { Fact } from '../../src/types.js';
import { unlinkSync, mkdirSync } from 'node:fs';

const TEST_DB = '/tmp/.crew-test-resume-e2e/runs.db';

describe('Resume E2E', () => {
  let store: RunStore;

  beforeEach(() => {
    mkdirSync('/tmp/.crew-test-resume-e2e', { recursive: true });
    try { unlinkSync(TEST_DB); } catch {}
    store = new RunStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  test('resumes run from where it stopped, only executing remaining steps', async () => {
    const runId = store.createRun('team.yaml', 'resume-test', 'Build a feature');
    store.updateRunStatus(runId, 'running');

    const allSteps = ['explore', 'plan', 'implement', 'verify', 'review'];
    for (const s of allSteps) store.createStep(runId, s);

    store.updateStep(runId, 'explore', { status: 'succeeded', duration_ms: 1000 });
    store.updateStep(runId, 'plan', { status: 'succeeded', duration_ms: 2000 });

    store.publishFact(runId, 'explore', {
      key: 'codebase_map', value: 'Found 15 relevant files in src/', source: 'explore',
      timestamp: Date.now(), status: 'final',
    });
    store.publishFact(runId, 'explore', {
      key: 'relevant_files', value: 'src/auth.ts, src/login.tsx', source: 'explore',
      timestamp: Date.now(), status: 'final',
    });
    store.publishFact(runId, 'plan', {
      key: 'implementation_plan', value: '1. Add login\n2. Connect API\n3. Tests', source: 'plan',
      timestamp: Date.now(), status: 'final',
    });

    store.updateRunStatus(runId, 'failed', 'Process crashed');

    const state = loadResumeState(store, runId);
    expect(state.completedSteps).toEqual(['explore', 'plan']);
    expect(state.completedSteps).not.toContain('implement');
    expect(state.facts.length).toBe(3);

    const factBus = new FactBus();
    restoreFacts(factBus, state);
    expect(factBus.getLatest('codebase_map')).toBeDefined();
    expect(factBus.getLatest('implementation_plan')).toBeDefined();

    const stepsToRun = getStepsToExecute(allSteps, state, 'resume');
    expect(stepsToRun).toEqual(['implement', 'verify', 'review']);

    const provider = new MockProvider({ chunkDelay: 0 });
    const executedSteps: string[] = [];

    for (const stepId of stepsToRun) {
      const agent = { id: stepId, name: stepId, systemPrompt: 'You are ' + stepId, model: 'mock-model', maxTurns: 15 };
      let output = '';
      for await (const ev of provider.executeAgent(agent, 'Resume task')) {
        if (ev.type === 'text') output += String(ev.data);
      }
      store.updateStep(runId, stepId, { status: 'succeeded', duration_ms: 500, output });
      executedSteps.push(stepId);
    }

    expect(executedSteps).toEqual(['implement', 'verify', 'review']);
    expect(executedSteps).not.toContain('explore');
    expect(executedSteps).not.toContain('plan');

    const allRunSteps = store.getRunSteps(runId);
    const succeeded = allRunSteps.filter(s => s.status === 'succeeded');
    expect(succeeded.length).toBe(5);
  });

  test('retry mode only re-runs failed steps', async () => {
    const runId = store.createRun('team.yaml', 'retry-test', 'Retry test');
    store.updateRunStatus(runId, 'running');

    const allSteps = ['a', 'b', 'c', 'd'];
    for (const s of allSteps) store.createStep(runId, s);

    store.updateStep(runId, 'a', { status: 'succeeded', duration_ms: 100 });
    store.updateStep(runId, 'b', { status: 'failed', error: 'timeout', duration_ms: 5000 });
    store.updateStep(runId, 'c', { status: 'succeeded', duration_ms: 200 });
    store.updateStep(runId, 'd', { status: 'failed', error: 'API error', duration_ms: 300 });

    const state = loadResumeState(store, runId);
    const retrySteps = getStepsToExecute(allSteps, state, 'retry');

    expect(retrySteps).toEqual(['b', 'd']);

    const provider = new MockProvider({ chunkDelay: 0 });
    for (const stepId of retrySteps) {
      const agent = { id: stepId, name: stepId, systemPrompt: 'Retry ' + stepId, model: 'mock-model', maxTurns: 15 };
      for await (const ev of provider.executeAgent(agent, 'Retry')) { /* consume */ }
      store.updateStep(runId, stepId, { status: 'succeeded', duration_ms: 100 });
    }

    const allRunSteps = store.getRunSteps(runId);
    const succeeded = allRunSteps.filter(s => s.status === 'succeeded');
    expect(succeeded.length).toBe(4);
  });
});
