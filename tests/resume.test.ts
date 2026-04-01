
import { describe, test, expect } from 'bun:test';
import { getStepsToExecute, loadResumeState } from '../src/orchestrator/resume.js';
import type { ResumeState } from '../src/orchestrator/resume.js';
describe('Resume', () => {
  const state: ResumeState = { runId: 'r', completedSteps: ['a', 'b'], failedSteps: ['c'], pendingSteps: ['d'], facts: [] };
  test('resume skips completed', () => { expect(getStepsToExecute(['a','b','c','d'], state, 'resume')).toEqual(['c', 'd']); });
  test('retry only failed', () => { expect(getStepsToExecute(['a','b','c','d'], state, 'retry')).toEqual(['c']); });
  test('throws for missing run', () => { expect(() => loadResumeState({ getRun: () => null, getRunSteps: () => [], getRunFacts: () => [] }, 'x')).toThrow('not found'); });
});
