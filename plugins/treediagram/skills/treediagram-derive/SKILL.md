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
2. Reuse the active ChangeSet when the task fits its purpose and the current session owns the lease. Otherwise call `changeset_begin`. If another session owns the lease, request an explicit Sidecar takeover.
3. Propose a small coherent batch, normally no more than five changes before user review. Use one semantic change per `design_change_propose` call.
4. For revisions, pass the current entity and base revision. For new nodes, choose the most specific node type and connect it with an explicit rationale.
5. Carry forward the latest ChangeSet version. Correct `agent_recoverable` field errors; re-read on `state_conflict`.
6. Summarize what each candidate changes and what remains uncertain. Set agent focus to `idle` with `complete: true`.

Never adopt, publish, confirm root, expand delegation, or take a lease from conversational approval. Never manufacture or request approval tokens. The user performs those actions in the Sidecar or in a detected host UI that issues a real user-gesture grant.
