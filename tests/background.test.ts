
import { describe, test, expect } from 'bun:test';
import { shouldRunTask, acquireLock, releaseLock } from '../src/background/backgroundRunner.js';
import { orient, consolidate, prune } from '../src/background/memoryConsolidator.js';
import { mkdirSync, rmSync } from 'node:fs';
describe('Background', () => {
  const dir = '/tmp/crew-test-' + Date.now();
  test('shouldRunTask fresh', () => { mkdirSync(dir, { recursive: true }); expect(shouldRunTask({ name: 't', trigger: 'post-run', minInterval: 3600, role: 'x', phases: [] }, dir)).toBe(true); rmSync(dir, { recursive: true, force: true }); });
  test('lock', () => {
    mkdirSync(dir, { recursive: true }); const t = { name: 'l', trigger: 'post-run' as const, minInterval: 0, role: '', phases: [] };
    expect(acquireLock(t, dir)).toBe(true); expect(acquireLock(t, dir)).toBe(false);
    releaseLock(t, dir); expect(acquireLock(t, dir)).toBe(true); releaseLock(t, dir);
    rmSync(dir, { recursive: true, force: true });
  });
  test('orient', () => { const k = orient({ currentRunFacts: [{ key: 'a', value: '1', source: 's', timestamp: 1 }], pastFacts: [{ key: 'b', value: '2', source: 's', timestamp: 1 }], memoryDir: dir }); expect(k).toContain('a'); expect(k).toContain('b'); });
  test('consolidate', () => { const r = consolidate(new Map([['k', [{ value: 'old', source: 's1', timestamp: 1 }, { value: 'new', source: 's2', timestamp: 2 }]]])); expect(r.facts[0].value).toBe('new'); expect(r.mergedCount).toBe(1); });
  test('prune', () => { const r = prune({ facts: [{ key: 'old', value: 'v', sources: ['s'], lastUpdated: Date.now() - 90 * 86400000, confidence: 1 }, { key: 'new', value: 'v', sources: ['s'], lastUpdated: Date.now(), confidence: 1 }], pruned: [], mergedCount: 0 }); expect(r.facts).toHaveLength(1); expect(r.pruned).toContain('old'); });
});
