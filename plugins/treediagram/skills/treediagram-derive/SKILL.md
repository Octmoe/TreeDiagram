---
name: treediagram-derive
description: Expand or refine the currently focused TreeDiagram branch through small, reviewable node and relation proposals. Use when a user asks to derive implications, develop a branch, add detail, or continue designing from selected nodes.
---

# Derive in TreeDiagram

Develop the user's current design focus; do not ask them to select a workflow type.

## Establish context

1. Verify `design_workspace_get` is callable. The plugin normally starts it for the current project; if it is unavailable, report the injected startup diagnostic and ask the user to trust or reinstall the plugin rather than guessing or requesting a per-project npm command.
2. In Codex, use `hostKind: "codex"`, the exposed task identifier or one task-stable opaque fallback as `hostSessionRef`, and `clientRef: "codex-agent"`. In Hermes, use `hostKind: "hermes"`, `hostSessionRef: "${HERMES_SESSION_ID}"`, and `clientRef: "hermes-agent"`. The read tools resolve the latest named Agent-visible focus across task sessions within this project, so do not reject a returned focus merely because its `hostSessionRef` records another Sidecar tab.
3. Read `attention_get`, then `design_context_get` with a deliberate token budget. Treat `primaryChangeId` and `selectedChangeIds` as explicit user-marked, Agent-visible candidate focus and prioritize `selectedChanges`; a candidate focus is valid even without a Working node focus. If both node and candidate focus are empty after project-level resolution, ask the user to select one in the Sidecar or use a target they explicitly named.
4. Set agent focus to `reading`, then to `proposing` only when writing candidates.

## Derive reviewable changes

1. Read the focused nodes, root path, pinned constraints, relevant relations, pending candidates, and deterministic impact before proposing.
2. Allow coarse nodes while the design is still moving quickly, but do not keep appending detail when the focus already hides multiple independently reviewable claims, decisions, constraints, questions, or risks. Report that structural refactoring is the next step and use `treediagram-refactor` when the user asks to split or organize it.
3. Read `design_changeset_get` with the current `hostSessionRef`. Reuse the active ChangeSet when `leaseStatus.state` is `owned`. When it is `reclaimable`, call `changeset_begin` to atomically recover the same ChangeSet and preserve every candidate. When it is `foreign_active`, call `changeset_lease_handoff_request` with a concise purpose, tell the user to click “交给此 Agent” in Sidecar, and stop writing. After the user confirms, re-read the ChangeSet and continue only when the state is `owned`; never impersonate its owner or ask the user to edit a URL.
4. Propose a small coherent batch, normally no more than five changes before user review. Use one semantic change per `design_change_propose` call.
5. For revisions, pass the current entity and base revision. For new nodes, choose the most specific node type and connect it with an explicit rationale.
6. Carry forward the latest ChangeSet version. Correct `agent_recoverable` field errors; re-read on `state_conflict`.
7. Summarize what each candidate changes and what remains uncertain. Set agent focus to `idle` with `complete: true`.

Never adopt, publish, confirm root, expand delegation, or take an active lease from conversational approval. Never manufacture or request approval tokens. Expired-lease recovery is allowed only when `leaseStatus.state` is explicitly `reclaimable`. The user performs high-privilege actions in the Sidecar or in a detected host UI that issues a real user-gesture grant.
