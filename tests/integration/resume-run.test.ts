/**
 * Integration test: Resume/Retry run
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RunStore } from '../src/store/run-store.js';
import { FactBus } from '../src/facts/fact-bus.js';
import { loadResumeState, restoreFacts, getStepsToExecute } from '../src/orchestrator/resume.js';
import { unlinkSync, mkdirSync } from 'node:fs';

const TEST_DB = '/tmp/.crew-test-resume/runs.db';

describe('Resume Run Integration', () => {
  let store: RunStore;
  let factBus: FactBus;

  beforeEach(() => {
    mkdirSync('/tmp/.crew-test-resume', { recursive: true });
    try { unlinkSync(TEST_DB); } catch {}
    store = new RunStore(TEST_DB);
    factBus = new FactBus();
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(TEST_DB); } catch {}
  });

  test('resume skips completed steps and runs remaining', () => {
    const runId = store.createRun('team.yaml', 'test-team', 'test task');
    store.updateRunStatus(runId, 'running');
    store.createStep(runId, 'explore');
    store.createStep(runId, 'plan');
    store.createStep(runId, 'implement');
    store.updateStep(runId, 'explore', { status: 'succeeded', duration_ms: 100 });
    store.updateStep(runId, 'plan', { status: 'succeeded', duration_ms: 200 });
    store.publishFact(runId, 'explore', {
      key: 'codebase_map', value: 'Found 10 files', source: 'explore',
      timestamp: Date.now(), status: 'final',
    });

    const state = loadResumeState(store, runId);
    expect(state.completedSteps).toContain('explore');
    expect(state.completedSteps).toContain('plan');
    expect(state.completedSteps).not.toContain('implement');
    expect(state.facts.length).toBe(1);

    restoreFacts(factBus, state);
    expect(factBus.getLatest('codebase_map')).toBeDefined();

    const order = ['explore', 'plan', 'implement'];
    const resumeSteps = getStepsToExecute(order, state, 'resume');
    expect(resumeSteps).toEqual(['implement']);
  });

  test('retry only re-runs failed steps', () => {
    const runId = store.createRun('team.yaml', 'test-team', 'test task');
    store.updateRunStatus(runId, 'running');
    store.createStep(runId, 'explore');
    store.createStep(runId, 'plan');
    store.createStep(runId, 'implement');
    store.updateStep(runId, 'explore', { status: 'succeeded', duration_ms: 100 });
    store.updateStep(runId, 'plan', { status: 'failed', error: 'timeout', duration_ms: 5000 });
    store.updateStep(runId, 'implement', { status: 'failed', error: 'dependency', duration_ms: 0 });

    const state = loadResumeState(store, runId);
    expect(state.failedSteps).toContain('plan');
    expect(state.failedSteps).toContain('implement');

    const order = ['explore', 'plan', 'implement'];
    const retrySteps = getStepsToExecute(order, state, 'retry');
    expect(retrySteps).toEqual(['plan', 'implement']);
    expect(retrySteps).not.toContain('explore');
  });

  test('loadResumeState throws for nonexistent run', () => {
    expect(() => loadResumeState(store, 'nonexistent-id')).toThrow();
  });
});
