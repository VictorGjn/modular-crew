
import { describe, test, expect } from 'bun:test';
import { requestApproval } from '../src/orchestrator/approvalGate.js';
describe('Approval', () => {
  test('CI auto-approve', async () => { const r = await requestApproval('deploy', { approval: true, ciMode: true, ciAutoApprove: true }); expect(r.approved).toBe(true); expect(r.respondedBy).toBe('ci'); });
  test('CI auto-reject', async () => { const r = await requestApproval('deploy', { approval: true, ciMode: true, ciAutoApprove: false }); expect(r.approved).toBe(false); });
});
