
import { describe, test, expect } from 'bun:test';
import { shouldTriggerUltraplan } from '../src/orchestrator/ultraplan.js';
describe('Ultraplan', () => {
  test('detects keyword', () => { expect(shouldTriggerUltraplan('Please ultraplan this')).toBe(true); expect(shouldTriggerUltraplan('ULTRAPLAN mode')).toBe(true); expect(shouldTriggerUltraplan('just run')).toBe(false); });
});
