# Human control: the inbox & gates

> **Status: DRAFT.** The reactive `needsHuman` park is realized by Plan 0009 (`revo inbox list/resolve`);
> the proactive plan/merge gates via `routing_policy` remain deferred.
> **Depends on:** [repo-layer-contract.md](./repo-layer-contract.md) (`pushInbox` / `resolveInbox` /
> `listInbox`) · [control-plane-schema.md](./control-plane-schema.md) (`inbox`, `routing_policy`) ·
> [architecture-overview.md](./architecture-overview.md) (invariant: a human decision is a status change).
> **Realized by:** brief §11 / §11.1, built as a slice after the data-access layer
> ([Plan 0009](./plans/0009-inbox-human-approval-resolution.md)).

Everything that needs a human flows into **one** inbox (control plane): plan approval, merge approval, agent
blocker-questions, alerts (risky op / budget). Never split per project; decisions are signed (`resolved_by`)
even on the shared queue.

## Two mandatory gates

- **Plan** (before code) and **Merge** (into main). Everything else is auto-passed over time by
  `routing_policy.requires_human`.
- **Auto-recommendation + your approval:** the plan arrives filled in (breakdown + model levels + cost estimate
  + risk flags); the default is "approve as-is" in one action, editing is the exception. Record edits (later:
  feed them back into policy).

## Mechanics

`revo inbox list` shows the pending queue; `revo inbox resolve <id> --approve` revives the parked step by
flipping it back to `ready` (so `claimNextStep` re-picks it on the loop's next turn), and `--reject` marks the
step `dead`. The proactive plan/merge gates via `routing_policy` remain deferred.

- A parked step → `awaiting_approval`; its branch stops, siblings keep going. The human's `resolveInbox` answer
  revives the branch on the loop's next turn. **This slice:** the existing parked step is revived as-is (flipped
  back to `ready`); the human's answer is recorded on the inbox row + resolution event but is not yet wired into
  the revived step's context. Carrying the answer into a fresh narrow run is a follow-up.
- **Escalation is directed:** an agent's question goes **up** to the architect-agent first; **out** to the human
  only for judgment calls and missing external knowledge.
- Notification (a light "N new" ping) and resolution (commands / a session) are **different channels**. MVP can
  skip push — the inbox just shows a count.

## Reviewer comments from GitHub — routed by type (§11.1)

A sorter step classifies each comment:
- **code fix** → straight to the developer (fix autonomously, push to the PR);
- **question / doubt** → developer **answers in-thread**; a fix only if the answer implies one;
- **objection to a decision (ADR)** → **up** (architect / human inbox). The developer may not change
  architecture on its own — stated explicitly in its prompt.
- Live-human comments, when the type is unclear → lean toward escalation. Auto-posting replies to live reviewers
  is deferred; at the start the user vets an agent's reply to a human.

"A comment appeared" is caught by the orchestrator (poll / GitHub webhook); "what is it and where does it go" is
an agent step. The result is ordinary steps / inbox records — same state-driven principle.
