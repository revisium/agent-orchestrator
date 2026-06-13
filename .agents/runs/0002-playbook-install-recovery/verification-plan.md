# Verification Plan - Playbook Install

```yaml
verification_plan:
  source_inputs:
    route_plan_ref: ".agents/runs/0002-playbook-install-recovery/RUN.md#route-plan"
    repo_verification_contract:
      path: ".agents/role-context.md#local-quality-gates"
      status: equivalent
      equivalent_path: ".agents/role-context.md"
      fallback_used: false
    repo_quality_docs:
      - ".agents/role-context.md"
      - "package.json"
    stack_references:
      - "../agents/stacks/js-ts/STACK.md"
    tooling_references:
      - "package.json scripts"
    risk_notes:
      - "Live --commit smoke requires human approval."
      - "Remote CI is unavailable until integrator publishes a PR."
  required:
    - id: primary-local-gate
      capability: primary_local_gate
      command: "npm run verify"
      source: repo-overlay
      evidence_required: command_output_summary
    - id: build
      capability: build_or_package
      command: "npm run build"
      source: package-script
      evidence_required: command_output_summary
    - id: built-cli-dry-run
      capability: architecture_or_structure
      command: "./bin/revo.js playbook install ../agents --dry-run"
      source: plan-0009
      evidence_required: command_output_summary
    - id: whitespace
      capability: structure_checks
      command: "git diff --check"
      source: git
      evidence_required: command_output_summary
  conditional:
    - id: live-commit-smoke
      capability: architecture_or_structure
      applies_when:
        - "human explicitly approves mutation of local versioned control-plane data"
      command: "./bin/revo.js playbook install ../agents --commit"
      source: plan-0009
      evidence_required: command_output_summary
  optional_configured:
    - id: sonar-local
      provider: "SonarCloud"
      capability: static_analysis
      provider_state: configured_local
      mode: local
      scope: changed-code
      blocking: false
      command: "npm run sonar:issues:local"
      hosted_check: ""
      issue_level_access: required
      categories:
        - security
        - reliability
        - maintainability
        - duplication
        - coverage
        - dependency_risk
        - quality_gate
      skip_if_missing:
        - credential
        - provider_config
      evidence_required: issue_summary_with_gate_status
      false_positive_policy: reviewer_or_human_required
  remote_after_push:
    - id: remote-ci
      provider: "GitHub Actions"
      evidence_required: status_checks
    - id: hosted-static-analysis
      provider: "SonarCloud"
      applies_when: "integrator publishes PR"
      evidence_required: issue_summary_with_gate_status
    - id: review-threads
      provider: "GitHub"
      evidence_required: unresolved_thread_count
  documentation_followups:
    - "Consider adding an explicit VERIFICATION.md if .agents/role-context.md should stop serving as the equivalent contract."
  stop_and_escalate_if:
    - "npm run verify fails after rerun."
    - "The dry-run writes rows."
    - "A live --commit smoke is required."
    - "Remote publication or PR watcher stages are requested."
```
