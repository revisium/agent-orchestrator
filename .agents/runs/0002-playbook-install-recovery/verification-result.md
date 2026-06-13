# Verification Result - Playbook Install

```yaml
verification_result:
  plan_ref: ".agents/runs/0002-playbook-install-recovery/verification-plan.md"
  role: developer
  status: passed
  source:
    repo_verification_contract_status: equivalent
    fallback_used: false
  executed:
    - id: primary-local-gate
      command: "npm run verify"
      status: passed
      evidence: >
        typecheck, lint:ci, and test:cov passed with 668 tests. The command was
        rerun with escalation because existing tests access
        ~/.revisium-orchestrator.
    - id: build
      command: "npm run build"
      status: passed
      evidence: "tsc -p tsconfig.build.json passed."
    - id: built-cli-dry-run
      command: "./bin/revo.js playbook install ../agents --dry-run"
      status: passed
      evidence: >
        Reported playbook revisium-agent-playbook 0.1.0-alpha.0 from
        local:@revisium/agent-playbook@0.1.0-alpha.0, 14 roles, 6 pipelines,
        21 operations, dry-run no rows written.
    - id: whitespace
      command: "git diff --check"
      status: passed
      evidence: "No whitespace errors."
  skipped:
    - id: live-commit-smoke
      reason: human-required
      evidence: "Would mutate local versioned control-plane data."
    - id: remote-ci
      reason: not-applicable
      evidence: "No commit, push, or PR requested."
    - id: sonar-local
      reason: missing-credential
      evidence: "Not run in this local recovery pass; requires configured Sonar token."
  static_analysis:
    - id: eslint
      provider: "eslint"
      mode: local
      status: passed
      provider_state: configured_local
      issue_level_access: not-supported
      quality_gate: passed
      categories:
        security: not-reported
        reliability: not-reported
        maintainability: passed
        duplication: not-reported
        coverage: not-reported
        dependency_risk: not-reported
      findings: []
    - id: sonar-local
      provider: "SonarCloud"
      mode: local
      status: skipped
      provider_state: configured_local
      issue_level_access: unknown
      quality_gate: unknown
      categories:
        security: unknown
        reliability: unknown
        maintainability: unknown
        duplication: unknown
        coverage: unknown
        dependency_risk: unknown
      findings: []
  remote:
    - id: remote-ci
      provider: "GitHub Actions"
      status: unavailable
      evidence: "No PR exists for this local diff."
  pr_feedback:
    target:
      pr_ref: ""
      base_ref: "master"
      head_ref: ""
      head_sha: ""
    verdict: unknown
    review_decision: unknown
    required_checks: unavailable
    unresolved_threads: 0
    provider_waiting: []
    queue: []
  blockers:
    - "Live --commit smoke remains human-gated."
  residual_risks:
    - "Live --commit path is intentionally untested."
    - "Canonical route approval evidence is unavailable for the already-completed developer stage."
    - "Remote package/GitHub source installation is explicitly unsupported in this slice."
  next_action: continue
```
