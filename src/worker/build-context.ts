import type { JsonFilterDto } from '@revisium/client';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Step } from '../control-plane/steps.js';
import type { Role } from '../control-plane/definitions.js';

// TODO(adr-digest): load ADR verdict digest here once structure is established.

export async function buildContext(
  da: ControlPlaneDataAccess,
  step: Step,
  role: Role,
): Promise<string> {
  const scopeRulesSummary = role.scopeRules ? JSON.stringify(role.scopeRules) : '{}';

  const task = await da.getRow('tasks', step.taskId);
  const taskTitle = task ? String(task.data.title ?? '') : '(unknown task)';
  const taskScope = task ? String(task.data.scope ?? '') : '';
  const taskRepo = task ? String(task.data.repo_ref ?? '') : '';

  // WORKAROUND: JsonFilterDto.equals is typed as { [key: string]: unknown } but accepts scalar
  // strings at runtime; mirrors the cast pattern in claimNextStep/recoverInFlight.
  const stepAttempts = await da.listRows('attempts', {
    first: 100,
    where: { data: { path: 'step_id', equals: step.id as unknown as JsonFilterDto['equals'] } },
  });
  const priorLessons = stepAttempts
    .filter(
      (a) =>
        String(a.data.status) === 'failed' &&
        String(a.data.lesson).length > 0,
    )
    .map((a) => String(a.data.lesson));

  const inputStr = step.input !== null ? JSON.stringify(step.input) : 'null';

  const parts: string[] = [
    `## Role: ${role.name}`,
    role.systemPrompt,
    `## Scope rules: ${scopeRulesSummary}`,
    `## Task: ${taskTitle}`,
  ];

  if (taskScope) parts.push(`Scope: ${taskScope}`);
  if (taskRepo) parts.push(`Repo: ${taskRepo}`);

  if (priorLessons.length > 0) {
    parts.push('## Prior failed attempt lessons:');
    for (const lesson of priorLessons) {
      parts.push(`- ${lesson}`);
    }
  }

  parts.push('## Current step input:');
  parts.push(inputStr);

  return parts.join('\n');
}
