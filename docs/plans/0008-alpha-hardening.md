# Plan 0008 — Alpha hardening

> **Status: Landed (retrospective record).** Authored after execution to keep the roadmap linkable; the work
> shipped in [PR #37](https://github.com/revisium/agent-orchestrator/pull/37) plus the follow-up
> fix making the per-attempt observability write non-fatal. Not a pre-execution work-order.
> **Depends on:** [0007](./0007-publishable-alpha.md).
> **Realizes:** the alpha survives real (`--live`) use — failures are loud, spend is bounded and observable.

## Scope (as shipped)

- **gh-account pinning:** the integrator fails loud on an unresolved pinned GitHub identity instead of
  publishing under whatever account happens to be active.
- **Failure surfacing:** a terminal step failure marks the Revisium run-row `failed` and writes a `run_failed`
  event before re-throwing — DBOS keeps progress truth, the run-row stops lying.
- **Shutdown detach:** host shutdown no longer drags down the standalone daemon.
- **Per-attempt observability:** `revo run log` — per-attempt verdict, model, tokens, cost, duration; the
  attempts row is written non-fatally (schema drift must never fail a successful step).
- **Params-as-data:** review-iteration caps and run-level cost/token budgets load from `routing_policy`
  (with safe defaults), replacing hardcoded constants; the budget guard runs after every step.
- `run events --verbose` for payload inspection.

## Verify (as run)

- `npm run verify` — 637 tests green; `npm run smoke:mvp` — PASS; DBOS seal intact.
- One adversarial codex review pass applied.
- Live `--live` dogfood acceptance and `npm publish` remained human-gated follow-ups.
