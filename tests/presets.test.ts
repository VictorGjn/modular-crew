
import { describe, test, expect } from 'bun:test';
import { PRESETS, resolvePreset, listPresets } from '../src/presets/index.js';
describe('Presets', () => {
  test('all defined', () => { expect(Object.keys(PRESETS)).toEqual(['explore', 'plan', 'verify', 'implement', 'review', 'pm']); });
  test('each has role+maxTurns', () => { for (const p of Object.values(PRESETS)) { expect(p.role).toBeTruthy(); expect(p.maxTurns).toBeGreaterThan(0); } });
  test('resolvePreset copy', () => { const r = resolvePreset('explore'); r.role = 'x'; expect(PRESETS.explore.role).not.toBe('x'); });
  test('overrides', () => { expect(resolvePreset('explore', { maxTurns: 5 }).maxTurns).toBe(5); });
  test('unknown throws', () => { expect(() => resolvePreset('nope')).toThrow('Unknown'); });
  test('listPresets', () => { expect(listPresets()).toHaveLength(6); });
});
