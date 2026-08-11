---
name: treediagram-initialize
description: Initialize a new TreeDiagram V2 workspace and turn a fuzzy project brief into a small, reviewable root design. Use when a user asks to start, initialize, structure, or establish the first durable design state for a project.
---

# Initialize TreeDiagram

Establish the smallest useful design tree without turning TreeDiagram into a chat or model runner.

## Detect capabilities and bind the task

1. Call `design_workspace_get` before planning writes. Treat a successful call as the MCP capability check.
2. The plugin binds MCP and the Sidecar to the current Codex project automatically. If the tool is unavailable, report the injected TreeDiagram startup diagnostic and ask the user to trust or reinstall the local plugin; do not ask them to run a per-project npm startup command and never invent tool results.
3. In Codex, use `hostKind: "codex"`, the exposed task identifier or one task-stable opaque fallback as `hostSessionRef`, and `clientRef: "codex-agent"`. In Hermes, use `hostKind: "hermes"`, `hostSessionRef: "${HERMES_SESSION_ID}"`, and `clientRef: "hermes-agent"`. Never mix identities within a session.
4. Call `attention_get` and `design_context_get` with that identity. The read tools deliberately resolve the project's most recently updated named Agent-visible focus across task sessions; a returned `hostSessionRef` identifies the source Sidecar tab and is not a reason to discard the focus. Treat `primaryNodeId` or `primaryChangeId` as the user's explicit target and prioritize returned `selectedChanges`.

## Build the initial design

1. Extract the goal, hard constraints, open questions, decisions, risks, and available evidence from the user's brief. Ask only about an ambiguity that would materially change the root.
2. Call `changeset_begin` with a short purpose-oriented title.
3. Propose one tentative `goal` root with `design_change_propose`. Then propose only the minimum useful children and relations. Prefer explicit `constraint`, `question`, `decision`, `risk`, and `evidence` nodes over generic topics.
4. Submit one semantic change per proposal and pass the latest `expectedChangeSetVersion` every time. Re-read the ChangeSet after conflicts.
5. Publish agent focus with `attention_agent_focus_set` while reading, proposing, or validating; finish with `phase: "idle"` and `complete: true`.

## Preserve the approval boundary

- Proposals remain candidates. Never call adoption, root confirmation, delegation expansion, lease takeover, or publish without a real user-gesture grant.
- Never fabricate an `approvalToken`, ask the user to paste one into chat, or treat conversational agreement as a grant.
- Direct the user to the project-specific Sidecar URL injected at session start. Preserve its active host kind and URL-encoded session reference. The user adopts candidates, confirms the root, and publishes there.
- Use an embedded MCP UI only after detecting that surface; the Sidecar remains the complete fallback.

Handle `agent_recoverable` errors by correcting the named field. On `state_conflict`, re-read state and versions. Stop for `user_input_required` or `permission_required` and explain the exact user action.
