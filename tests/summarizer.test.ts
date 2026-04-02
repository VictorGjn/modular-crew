
import { describe, test, expect } from 'bun:test';
import { summarizeStepOutput, summarizeRun } from '../src/trace/summarizer.js';
describe('Summarizer', () => {
  test('with headers', () => { expect(summarizeStepOutput('# Analysis\ncontent', 'a1', 's1')).toContain('Analysis'); });
  test('empty output', () => { expect(summarizeStepOutput('', 'a1', 's1')).toContain('No output'); });
  test('bullets', () => { expect(summarizeStepOutput('- A\n- B', 'a1', 's1')).toContain('Key points'); });
  test('run summary', () => {
    const s = summarizeRun('r1', 'team', 'task', [
      { stepId: 'a', status: 'succeeded', agentId: 'x', output: '# H\n- p', tokensIn: 100, tokensOut: 200, costUsd: 0.001, durationMs: 500 },
      { stepId: 'b', status: 'failed', tokensIn: 50, tokensOut: 50 },
    ]);
    expect(s.succeededSteps).toBe(1); expect(s.failedSteps).toBe(1); expect(s.totalTokens).toBe(400);
  });
});
