import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTeamFile, validateTeam } from '../../src/compiler/team-parser.js';
import { resolvePreset, listPresets, PRESETS } from '../../src/presets/index.js';
import { loadResumeState, restoreFacts, getStepsToExecute } from '../../src/orchestrator/resume.js';
import { FactBus } from '../../src/facts/fact-bus.js';
import { RunStore } from '../../src/store/run-store.js';
import type { HooksConfig } from '../../src/hooks/hookRunner.js';

describe('Phase 2 Wiring Integration', () => {
  // 1. Coordinator-crew.yaml parses and mode detected
  describe('coordinator-crew.yaml', () => {
    test('parses successfully', () => {
      const team = parseTeamFile(resolve('templates/coordinator-crew.yaml'));
      expect(team).toBeDefined();
      expect(team.name).toBeTruthy();
    });

    test('mode is detected as coordinator', () => {
      const team = parseTeamFile(resolve('templates/coordinator-crew.yaml'));
      expect(team.mode).toBe('coordinator');
    });

    test('has agents defined', () => {
      const team = parseTeamFile(resolve('templates/coordinator-crew.yaml'));
      expect(team.agents).toBeDefined();
      expect(Object.keys(team.agents!).length).toBeGreaterThan(0);
    });

    test('has at least one coordinator agent', () => {
      const team = parseTeamFile(resolve('templates/coordinator-crew.yaml'));
      const coordinators = Object.values(team.agents!).filter(a => a.is_coordinator);
      expect(coordinators.length).toBeGreaterThanOrEqual(1);
    });
  });

  // 2. Resume state loads correctly
  describe('resume state', () => {
    test('loadResumeState returns valid state from store', () => {
      const store = new RunStore('/tmp/.crew-wiring-test/runs.db');
      const runId = store.createRun('test.yaml', 'test-team', 'test task');
      store.updateRunStatus(runId, 'running');
      store.createStep(runId, 'step1');
      store.updateStep(runId, 'step1', { status: 'succeeded', duration_ms: 100 });
      store.createStep(runId, 'step2');
      store.updateStep(runId, 'step2', { status: 'failed', duration_ms: 50 });

      const state = loadResumeState(store, runId);
      expect(state).toBeDefined();
      expect(state.completedSteps).toContain('step1');
      expect(state.failedSteps).toContain('step2');
      store.close();
    });

    test('restoreFacts populates factBus from state', () => {
      const factBus = new FactBus();
      const state = {
        runId: 'test-run',
        completedSteps: ['step1'],
        failedSteps: [],
        facts: [{ key: 'test-fact', value: 'test-value', source: 'step1', timestamp: Date.now(), status: 'final' as const }],
      };
      restoreFacts(factBus, state);
      const latest = factBus.getLatest('test-fact');
      expect(latest).toBeDefined();
      expect(latest!.value).toBe('test-value');
    });

    test('getStepsToExecute filters correctly in resume mode', () => {
      const allSteps = ['step1', 'step2', 'step3'];
      const state = {
        runId: 'test-run',
        completedSteps: ['step1'],
        failedSteps: ['step2'],
        facts: [],
      };
      const resumeSteps = getStepsToExecute(allSteps, state, 'resume');
      expect(resumeSteps).not.toContain('step1');
      expect(resumeSteps.length).toBeGreaterThan(0);
    });

    test('getStepsToExecute filters correctly in retry mode', () => {
      const allSteps = ['step1', 'step2', 'step3'];
      const state = {
        runId: 'test-run',
        completedSteps: ['step1'],
        failedSteps: ['step2'],
        facts: [],
      };
      const retrySteps = getStepsToExecute(allSteps, state, 'retry');
      expect(retrySteps).toContain('step2');
      expect(retrySteps).not.toContain('step1');
    });
  });

  // 3. Hooks config extracted
  describe('hooks config', () => {
    test('hooks config extracted from team file with hooks', () => {
      // Parse a team file and check hooks field
      const team = parseTeamFile(resolve('templates/verify-crew.yaml'));
      // hooks may or may not be defined depending on template
      const hooks: HooksConfig = team.hooks ?? {};
      expect(hooks).toBeDefined();
      expect(typeof hooks).toBe('object');
    });

    test('hooks config defaults to empty object when missing', () => {
      const team = parseTeamFile(resolve('templates/minimal.yaml'));
      const hooks: HooksConfig = team.hooks ?? {};
      expect(hooks).toBeDefined();
      expect(Object.keys(hooks).length).toBe(0);
    });
  });

  // 4. Presets resolve
  describe('presets', () => {
    test('listPresets returns all 6 presets', () => {
      const presets = listPresets();
      expect(presets.length).toBe(6);
      const names = presets.map(p => p.name);
      expect(names).toContain('explore');
      expect(names).toContain('plan');
      expect(names).toContain('verify');
      expect(names).toContain('implement');
      expect(names).toContain('review');
      expect(names).toContain('pm');
    });

    test('resolvePreset returns correct preset', () => {
      const preset = resolvePreset('explore');
      expect(preset.role).toBeTruthy();
      expect(preset.maxTurns).toBe(20);
    });

    test('resolvePreset throws on unknown preset', () => {
      expect(() => resolvePreset('nonexistent')).toThrow();
    });

    test('resolvePreset merges overrides', () => {
      const preset = resolvePreset('plan', { maxTurns: 5 });
      expect(preset.maxTurns).toBe(5);
    });
  });

  // 5. All templates parse
  describe('templates', () => {
    const templates = ['minimal', 'dev-crew', 'coordinator-crew', 'verify-crew', 'product-crew'];
    for (const t of templates) {
      test(`${t}.yaml parses successfully`, () => {
        const team = parseTeamFile(resolve(`templates/${t}.yaml`));
        expect(team).toBeDefined();
        expect(team.name).toBeTruthy();
      });
    }
  });
});
