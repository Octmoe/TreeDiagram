---
name: treediagram-unbox
description: Reopen a TreeDiagram design that has converged too early by exposing hidden framing assumptions and proposing genuinely different options. Use when the user says the direction feels boxed-in, generic, prematurely settled, or asks to reopen the current design boundary.
---

# Unbox TreeDiagram

Widen the design space around the current focus without erasing the rationale behind the present direction.

## Find the box

1. Verify the MCP capability with `design_workspace_get`. In Codex bind calls to `hostKind: "codex"`, `clientRef: "codex-agent"`, and the task identifier or one task-stable fallback. In Hermes use `hostKind: "hermes"`, `clientRef: "hermes-agent"`, and `hostSessionRef: "${HERMES_SESSION_ID}"`. Read tools resolve the latest project-visible focus across task sessions; use a returned focus even when its source `hostSessionRef` differs.
2. Read `attention_get` and `design_context_get`. Treat `primaryChangeId` and `selectedChangeIds` as explicit user-marked, Agent-visible targets and prioritize returned `selectedChanges`; call `design_impact_get` for focused Working nodes or endpoints. Require an explicit target only when both node and candidate focus are empty.
3. Publish agent focus as `reading` and identify which assumed user, boundary, success metric, dependency, constraint, or solution form makes the alternatives look artificially similar.
4. Preserve real hard constraints. Label an unverified boundary as an assumption rather than deleting it.

## Reopen the space

Produce alternatives that change different axes, not cosmetic variants. Include the disconfirming evidence or experiment that would make each option lose. Prefer recording:

- `option` nodes for mutually distinct directions;
- `question` nodes for frame-breaking unknowns;
- `risk` and `validation_method` nodes for cheap tests;
- `derived_from`, `contradicts`, `constrains`, `selects`, or `rejects` relations with explicit rationale.

If the user wants durable changes, use the existing owned ChangeSet or begin one and propose a small batch. Never revise accepted nodes merely to hide the previous rationale. Finish by stating which assumption was opened and set agent focus to `idle` with `complete: true`.

All candidates require user review. Never translate conversational enthusiasm into adoption, root confirmation, publish, delegation, or lease takeover; only a Sidecar or detected host UI user gesture can issue the needed grant.
