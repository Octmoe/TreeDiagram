---
name: treediagram-reevaluate
description: Reassess affected TreeDiagram nodes after adopted changes, new evidence, or changed constraints and propose targeted repairs before validation or release. Use when the user asks to reevaluate consequences, refresh stale conclusions, or review impact after a change.
---

# Re-evaluate TreeDiagram

Revisit only the impacted design surface and keep deterministic validation separate from judgment.

## Determine the affected surface

1. Verify `design_workspace_get`. In Codex bind the session with `hostKind: "codex"`, `clientRef: "codex-agent"`, and the task identifier or one task-stable fallback. In Hermes use `hostKind: "hermes"`, `clientRef: "hermes-agent"`, and `hostSessionRef: "${HERMES_SESSION_ID}"`. Read tools resolve the latest project-visible focus across task sessions; use a returned focus even when its source `hostSessionRef` differs.
2. Read `attention_get`, `design_context_get`, and the active ChangeSet. Treat `primaryChangeId` and `selectedChangeIds` as explicit user-marked, Agent-visible targets and prioritize returned `selectedChanges`; run `design_impact_get` for any focused Working nodes or endpoints.
3. Set agent focus to `reading`. Compare current revisions against changed evidence, constraints, decisions, and pending candidates; do not treat a pending proposal as adopted fact.

## Reevaluate and repair

1. Mark conclusions as stale only when a dependency, support, contradiction, constraint, or decision path explains the impact.
2. Distinguish deterministic structural failures from questions that need human judgment.
3. If repair is requested, use the active owned ChangeSet or begin one. Propose targeted revisions with the exact entity and base revision, plus any necessary relation revisions. Preserve history and submit one semantic change per call.
4. Let the user review and adopt the candidates. Only then call `changeset_validate` with the latest ChangeSet version.
5. Report blocking issues, remaining warnings, and the release decision separately. Finish agent focus as `idle` with `complete: true`.

Never adopt, confirm root, publish, expand delegation, or take a lease from chat text. Never fabricate or request an approval token. For `agent_recoverable` errors repair the named field; for `state_conflict` re-read versions; for permission or user-input errors direct the user to the Sidecar action.
