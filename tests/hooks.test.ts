
import { describe, test, expect } from 'bun:test';
import { runHooks } from '../src/hooks/hookRunner.js';
describe('Hooks', () => {
  const ctx = { runId: 'r1', stepId: 's1' };
  test('success', async () => { const r = await runHooks('before_step', [{ name: 'echo', run: 'echo hello' }], ctx); expect(r[0].success).toBe(true); expect(r[0].stdout).toBe('hello'); });
  test('abort policy', async () => {
    const r = await runHooks('before_step', [{ name: 'fail', run: 'exit 1', on_fail: 'abort' }, { name: 'skip', run: 'echo x' }], ctx);
    expect(r[0].success).toBe(false); expect(r[1].aborted).toBe(true);
  });
  test('continue policy', async () => {
    const r = await runHooks('after_step', [{ name: 'fail', run: 'exit 1', on_fail: 'continue' }, { name: 'ok', run: 'echo y' }], ctx);
    expect(r[1].success).toBe(true);
  });
  test('env vars', async () => { const r = await runHooks('before_run', [{ name: 'env', run: 'echo $CREW_RUN_ID' }], ctx); expect(r[0].stdout).toBe('r1'); });
});
