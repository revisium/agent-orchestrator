import type { JsonFilterDto } from '@revisium/client';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Step } from '../control-plane/steps.js';
import { toStr } from '../control-plane/steps.js';
import type { Role } from '../control-plane/definitions.js';

// ADR digest not yet included — deferred to a later plan once structure is established.

export async function buildContext(
  da: ControlPlaneDataAccess,
  step: Step,
  role: Role,
): Promise<string> {
  const scopeRulesSummary = role.scopeRules ? JSON.stringify(role.scopeRules) : '{}';

  const task = await da.getRow('tasks', step.taskId);
  const taskTitle = task ? toStr(task.data.title) : '(unknown task)';
  const taskScope = task ? toStr(task.data.scope) : '';
  const taskRepo = task ? toStr(task.data.repo_ref) : '';

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

  const inputStr = step.input === null ? 'null' : JSON.stringify(step.input);

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

  parts.push('## Current step input:', inputStr);

  return parts.join('\n');
}
