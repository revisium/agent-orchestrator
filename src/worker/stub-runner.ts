import type { RunAgent, AttemptResult, NewStepSpec } from './runner.js';

// Zero-cost stub runner for integration testing and smoke verification.
// The architect → developer transition lives HERE (in the runner data), not in the loop.
// Adding a new role transition requires only a data change — the loop stays untouched.
export const stubRunAgent: RunAgent = async ({ role, step, context }) => {
  const output = {
    echo: `[stub] role=${role.name} step=${step.id} contextSize=${context.length}`,
  };

  const nextSteps: NewStepSpec[] = [];
  if (role.name === 'architect') {
    nextSteps.push({
      taskId: step.taskId,
      role: 'developer',
      kind: 'implement',
      input: { from: step.id },
      modelProfile: step.modelProfile,
    });
  }
  // developer returns no next steps; other roles are treated the same way

  const result: AttemptResult = {
    output,
    nextSteps,
    costs: [],
    needsHuman: false,
  };
  return result;
};
