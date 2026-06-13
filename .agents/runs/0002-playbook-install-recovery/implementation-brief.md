# Implementation Brief - Playbook Install

```yaml
implementation_brief:
  goal: >
    Add a local/package playbook import command that reads the canonical agents
    playbook catalog and maps it into agent-orchestrator's versioned Revisium
    control-plane data.
  upstream_artifacts:
    task_spec_ref: "docs/plans/0009-playbook-install.md"
    architecture_plan_ref: "docs/control-plane-schema.md"
    verification_plan_ref: ".agents/runs/0002-playbook-install-recovery/verification-plan.md"
  required_behavior:
    - "Expose revo playbook install <source> with --dry-run, --commit, --json, --name, and --version."
    - "Load playbook.json, catalog/roles.json, and catalog/pipelines.json."
    - "Reject unsupported remote sources explicitly."
    - "Map roles and pipelines into versioned control-plane rows without markdown discovery."
    - "Keep existing runtime role ids compatible."
    - "Do not write rows during dry-run."
  files_or_modules_to_inspect_first:
    - "control-plane/bootstrap.config.json"
    - "src/control-plane/definitions.ts"
    - "src/revisium/revisium.module.ts"
    - "src/cli/program.ts"
    - "docs/control-plane-schema.md"
    - "docs/getting-started.md"
  architecture_constraints:
    - "Revisium remains source of truth for meaning."
    - "DBOS/progress state is not part of this slice."
    - "Playbook import writes versioned meaning data only through the draft/commit path."
    - "Runtime draft data access remains separate from versioned meaning access."
  implementation_slices:
    - "Document Plan 0009 and update roadmap/index/getting-started docs."
    - "Add playbooks and pipelines schema plus role provenance fields."
    - "Add source resolver, manifest/catalog loader, prompt composer, mapper, installer, service, and CLI wiring."
    - "Add focused tests and update existing module/schema/CLI tests."
  acceptance_criteria:
    - "Dry-run against ../agents reports deterministic planned operations and writes no rows."
    - "Full local gate passes."
    - "Build passes."
    - "Unsupported remote sources fail explicitly."
    - "Live --commit smoke remains human-gated."
  required_tests:
    - "npm run verify"
    - "npm run build"
    - "./bin/revo.js playbook install ../agents --dry-run"
    - "git diff --check"
  out_of_scope:
    - "Remote GitHub/npm installation beyond already-resolvable packages."
    - "Workflow-as-data execution."
    - "Commit, push, PR, CI watcher, merge, deployment."
    - "Live --commit smoke without human approval."
  risks_to_watch:
    - "Dry-run accidentally writing rows."
    - "Catalog drift between agents and importer expectations."
    - "Runtime roles and versioned role provenance becoming coupled incorrectly."
    - "Consensus gap if Claude Code review is unavailable."
  stop_and_escalate_if:
    - "A required behavior needs product semantics not captured in Plan 0009."
    - "A live --commit smoke is required."
    - "Remote publication or PR watcher stages are requested."
```

## Developer Result

```yaml
developer_result:
  changed_files:
    - "control-plane/bootstrap.config.json"
    - "docs/control-plane-schema.md"
    - "docs/getting-started.md"
    - "docs/plans/0009-playbook-install.md"
    - "docs/plans/README.md"
    - "docs/roadmap.md"
    - "src/cli/commands/playbook.ts"
    - "src/cli/commands/playbook.test.ts"
    - "src/cli/program.ts"
    - "src/cli/program.test.ts"
    - "src/control-plane/bootstrap-seed.test.ts"
    - "src/control-plane/definitions.ts"
    - "src/control-plane/versioned-meaning.ts"
    - "src/control-plane/versioned-meaning.test.ts"
    - "src/playbook/*"
    - "src/revisium/playbooks.service.ts"
    - "src/revisium/revisium.module.ts"
    - "src/revisium/revisium.module.test.ts"
  behavior_changed:
    - "New playbook install CLI command."
    - "New versioned playbook/pipeline schema rows."
    - "Role provenance fields for imported playbook roles."
    - "Dry-run-safe importer with explicit unsupported-source errors."
  tests_added_or_updated:
    - "Playbook source resolver, manifest, catalog loader, prompt composer, mapper, installer, and CLI tests."
    - "Versioned meaning access test."
    - "Bootstrap schema and program/module tests updated."
  commands_run:
    - "npm run verify"
    - "npm run build"
    - "./bin/revo.js playbook install ../agents --dry-run"
    - "git diff --check"
  skipped_gates:
    - id: live-commit-smoke
      reason: "human-required; mutates local versioned control-plane data"
    - id: remote-ci
      reason: "not-applicable; no commit, push, or PR requested"
  generated_artifacts:
    - ".agents/runs/0002-playbook-install-recovery/RUN.md"
    - ".agents/runs/0002-playbook-install-recovery/implementation-brief.md"
    - ".agents/runs/0002-playbook-install-recovery/verification-plan.md"
    - ".agents/runs/0002-playbook-install-recovery/verification-result.md"
  blockers:
    - "Dual-model code review consensus still needs human decision because Claude Code review was unavailable."
  residual_risk:
    - "Live --commit path is not smoke-tested."
    - "Claude Code review may be unavailable in this session."
  next_route_action: needs_human
```
