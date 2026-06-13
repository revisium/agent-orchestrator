# Plan 0013 - MCP PR readiness and feedback tools

> **Status: Implemented in this PR.** Stage: D2-enabling. Adds read-only MCP
> tools for PR readiness and actionable review feedback.

## Goal

Let a coding agent ask Revo whether a pull request is actually ready to resume,
fix, triage, wait on, or hand to a human without opening GitHub manually.

## Scope

- Add read-only MCP tool `get_pr_readiness`.
- Add read-only MCP tool `list_pr_feedback`.
- Reuse the existing PR poller behavior through a shared read-only core.
- Preserve the API-layer call path:

```text
MCP tools -> McpFacadeService -> TaskControlPlaneApiService -> PR readiness service/core
```

## Contract

`get_pr_readiness` accepts:

- `repo`: GitHub repository string, for example `revisium/agent-orchestrator`.
- `prNumber`.
- `headBranch`.
- `baseBranch`, default `master`.
- `sonarProject`.
- `includeComments`, default `true`.
- `includeReviewThreads`, default `true`.

It returns normalized JSON with:

- `verdict`: `ready`, `waiting`, `needs_work`, `needs_human`, `merged`,
  `closed`, or `unknown`.
- `pr`: number, url, state, draft, base, head, headSha, mergeState.
- `checks`: terminal, pending, pass, fail, and compact list.
- `reviewDecision`.
- `reviewThreads`: unresolved count and compact unresolved items.
- `providerState`, including CodeRabbit wait/rate-limit/review state.
- `sonar`: issues, hotspots, and unavailable state when configured.
- `nextAction`: role-oriented action such as `watcher_wait`,
  `developer_fix`, `reviewer_triage`, `human_decision`, or
  `ready_for_merge_gate`.
- `evidence`: compact source evidence.

`list_pr_feedback` uses the same collection path and returns the actionable
queue:

- `developerFixes`;
- `reviewerQuestions`;
- `providerWait`;
- `humanDecisions`;
- `ignoredNoise`;
- `residualRisks`.

## Non-goals

- No raw GitHub CRUD or mutation tools.
- No PR comment posting.
- No review-thread resolution.
- No authentication or remote MCP transport.
- No raw Revisium row CRUD.
- No generic GitHub MCP server behavior.
- No `@nestjs/cqrs`.

## Acceptance

- `McpFacadeService` remains thin delegation only.
- `McpModule` still imports `TaskControlPlaneModule`, not core modules.
- Existing PR poller behavior is preserved while sharing read-only readiness
  classification.
- If a GitHub status context says CodeRabbit is successful but the top-level
  CodeRabbit comment says review did not start due to a provider or rate limit,
  the normalized result is `waiting` with provider reason `provider_limit`.
- Local verification passes: focused tests, build, typecheck, lint, verify,
  audit, and MCP stdio smoke.
