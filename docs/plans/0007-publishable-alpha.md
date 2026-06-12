# Plan 0007 — Publishable alpha

> **Status: Landed (retrospective record).** Authored after execution to keep the roadmap linkable; the work
> shipped in [PR #35](https://github.com/revisium/agent-orchestrator/pull/35). Not a pre-execution work-order.
> **Depends on:** [0006](./0006-end-to-end-mvp.md).
> **Realizes:** the package is installable from npm as `@revisium/orchestrator@alpha`.

## Scope (as shipped)

- `package.json`: renamed to `@revisium/orchestrator`, bumped to `0.1.0-alpha.0`, removed `private: true`,
  added `files` / `publishConfig` / `prepack` so only `dist/` and `bin/` ship (tests excluded); build uses
  `tsconfig.build.json`.
- `tsconfig.build.json` (new): extends the base config, excludes `**/*.test.ts` and test fixtures so
  `npm pack` / `prepack` builds are test-free.
- `package-lock.json`: regenerated; `@revisium/standalone` moved to production `dependencies` (runtime dep).
- `src/control-plane/bootstrap-seed.test.ts` (new): seed test — the fixed roles
  (`architect`/`developer`/`reviewer`/`integrator`) and `model_profiles` (`deep`/`standard`/`cheap`) resolve via
  `loadRole` / `loadModelProfile` over an in-memory transport, with referential-integrity and uniqueness checks.
- `docs/getting-started.md`: rewritten for install-from-npm (`npm i -g @revisium/orchestrator@alpha`),
  Node 24.11.x requirement, `bootstrap --commit` seed detail.

## Verify (as run)

- `npm run verify` — 593 pass / 0 fail.
- `npm run smoke:mvp` — PASS.
- `npm publish` was a deliberate human follow-up, not part of the slice.
