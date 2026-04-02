/**
 * Integration test: Hooks lifecycle
 */
import { describe, test, expect } from 'bun:test';
import { runHooks, type HookDefinition, type HookContext } from '../../src/hooks/hookRunner.js';

describe('Hooks Run Integration', () => {
  test('before_run hooks execute and return results', async () => {
    const hooks: HookDefinition[] = [
      { name: 'setup', run: 'echo "before_run setup"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001' };
    const results = await runHooks('before_run', hooks, ctx);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('setup');
    expect(results[0].success).toBe(true);
    expect(results[0].stdout).toContain('before_run setup');
    expect(results[0].phase).toBe('before_run');
  });

  test('before_step hooks receive step context', async () => {
    const hooks: HookDefinition[] = [
      { name: 'step-check', run: 'echo "step=$CREW_STEP_ID"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001', stepId: 'explore' };
    const results = await runHooks('before_step', hooks, ctx);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].stdout).toContain('step=explore');
  });

  test('after_step hooks fire correctly', async () => {
    const hooks: HookDefinition[] = [
      { name: 'after-step-log', run: 'echo "done"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001', stepId: 'implement' };
    const results = await runHooks('after_step', hooks, ctx);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].phase).toBe('after_step');
  });

  test('after_run hooks fire correctly', async () => {
    const hooks: HookDefinition[] = [
      { name: 'cleanup', run: 'echo "after_run cleanup"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001' };
    const results = await runHooks('after_run', hooks, ctx);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].phase).toBe('after_run');
  });

  test('abort policy stops subsequent hooks', async () => {
    const hooks: HookDefinition[] = [
      { name: 'failing-hook', run: 'exit 1', on_fail: 'abort', timeout: 5000 },
      { name: 'should-skip', run: 'echo "should not run"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001' };
    const results = await runHooks('before_run', hooks, ctx);
    expect(results.length).toBe(2);
    expect(results[0].success).toBe(false);
    expect(results[1].aborted).toBe(true);
  });

  test('continue policy runs subsequent hooks after failure', async () => {
    const hooks: HookDefinition[] = [
      { name: 'failing-hook', run: 'exit 1', on_fail: 'continue', timeout: 5000 },
      { name: 'should-run', run: 'echo "ran"', timeout: 5000 },
    ];
    const ctx: HookContext = { runId: 'test-run-001' };
    const results = await runHooks('before_run', hooks, ctx);
    expect(results.length).toBe(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(results[1].aborted).toBe(false);
  });
});
