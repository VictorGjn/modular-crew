/**
 * Permission Filter — claw-code pattern: Permission = Visibility.
 * Denied tools never enter the agent's context window. The model can't
 * hallucinate calls to tools it can't see.
 */

import type { ResolvedAgent } from '../types.js';

export interface PermissionRule {
  denyNames: Set<string>;       // exact tool name blocks
  denyPrefixes: string[];       // prefix-based blocks (e.g. "mcp_")
  allowOnly?: Set<string>;      // if set, only these tools are visible
}

export function createPermissionRule(
  denyNames: string[] = [],
  denyPrefixes: string[] = [],
  allowOnly?: string[],
): PermissionRule {
  return {
    denyNames: new Set(denyNames.map(n => n.toLowerCase())),
    denyPrefixes: denyPrefixes.map(p => p.toLowerCase()),
    allowOnly: allowOnly ? new Set(allowOnly.map(n => n.toLowerCase())) : undefined,
  };
}

export function isToolBlocked(toolName: string, rule: PermissionRule): boolean {
  const lower = toolName.toLowerCase();
  if (rule.allowOnly && !rule.allowOnly.has(lower)) return true;
  if (rule.denyNames.has(lower)) return true;
  return rule.denyPrefixes.some(prefix => lower.startsWith(prefix));
}

export function filterAgentTools(agent: ResolvedAgent, rule: PermissionRule): ResolvedAgent {
  if (!agent.tools?.length) return agent;
  const visible = agent.tools.filter(t => !isToolBlocked(t, rule));
  return { ...agent, tools: visible };
}

export function buildPermissionRuleFromYaml(stepDef: {
  deny_tools?: string[];
  deny_prefixes?: string[];
  allow_only?: string[];
}): PermissionRule | null {
  if (!stepDef.deny_tools?.length && !stepDef.deny_prefixes?.length && !stepDef.allow_only?.length) {
    return null;
  }
  return createPermissionRule(
    stepDef.deny_tools ?? [],
    stepDef.deny_prefixes ?? [],
    stepDef.allow_only,
  );
}
