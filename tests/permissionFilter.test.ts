import { describe, it, expect } from 'vitest';
import { createPermissionRule, isToolBlocked, filterAgentTools, buildPermissionRuleFromYaml } from '../src/orchestrator/permissionFilter.js';
import type { ResolvedAgent } from '../src/types.js';

describe('permissionFilter', () => {
  it('blocks exact name matches', () => {
    const rule = createPermissionRule(['BashTool', 'FileWrite']);
    expect(isToolBlocked('BashTool', rule)).toBe(true);
    expect(isToolBlocked('bashtool', rule)).toBe(true);  // case insensitive
    expect(isToolBlocked('FileRead', rule)).toBe(false);
  });

  it('blocks prefix matches', () => {
    const rule = createPermissionRule([], ['mcp_', 'internal_']);
    expect(isToolBlocked('mcp_notion', rule)).toBe(true);
    expect(isToolBlocked('internal_admin', rule)).toBe(true);
    expect(isToolBlocked('file_read', rule)).toBe(false);
  });

  it('allowOnly restricts to explicit set', () => {
    const rule = createPermissionRule([], [], ['FileRead', 'FileEdit']);
    expect(isToolBlocked('FileRead', rule)).toBe(false);
    expect(isToolBlocked('BashTool', rule)).toBe(true);
  });

  it('filters agent tools in place', () => {
    const agent: ResolvedAgent = { id: 'a1', name: 'worker', systemPrompt: '', model: 'mock', maxTurns: 5, tools: ['BashTool', 'FileRead', 'mcp_notion', 'FileEdit'] };
    const rule = createPermissionRule(['BashTool'], ['mcp_']);
    const filtered = filterAgentTools(agent, rule);
    expect(filtered.tools).toEqual(['FileRead', 'FileEdit']);
  });

  it('buildPermissionRuleFromYaml returns null when empty', () => {
    expect(buildPermissionRuleFromYaml({})).toBeNull();
  });

  it('buildPermissionRuleFromYaml parses step config', () => {
    const rule = buildPermissionRuleFromYaml({ deny_tools: ['Bash'], deny_prefixes: ['mcp_'] });
    expect(rule).not.toBeNull();
    expect(isToolBlocked('bash', rule!)).toBe(true);
    expect(isToolBlocked('mcp_slack', rule!)).toBe(true);
  });
});
