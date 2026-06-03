import type { ControlPlaneRow } from '../control-plane/data-access.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';

export function fakeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

export function makeRole(name: string, overrides: Partial<Role> = {}): Role {
  return {
    name,
    systemPrompt: `You are the ${name}.`,
    modelLevel: 'standard',
    effort: 'high',
    runner: 'claude-code',
    allowedTools: [],
    scopeRules: {},
    ...overrides,
  };
}

export const TEST_PROFILE: ModelProfile = {
  level: 'standard',
  provider: 'test',
  modelId: 'test-model',
  params: {},
  costPerInput: 0,
  costPerOutput: 0,
};

export const BASE_STEP: Step = {
  id: 'step-1',
  taskId: 'task-1',
  runId: 'run-1',
  role: 'architect',
  kind: 'plan_run',
  status: 'claimed',
  input: null,
  output: null,
  modelProfile: 'standard',
  runAfter: '',
  attemptCount: 0,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: 'worker-1',
  leaseExpiresAt: '',
  deadReason: '',
};
