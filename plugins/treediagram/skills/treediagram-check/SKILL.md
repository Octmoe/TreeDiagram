---
name: treediagram-check
description: Audit the focused TreeDiagram node or candidate for unsupported assumptions, contradictions, missing evidence, weak decisions, conflicting constraints, and unhandled risks. Use when the user asks for a check, audit, critique, review, red-team, or findings report without an interactive interview. Do not use for "grill me" or requests to clarify a plan through questions; use treediagram-grill instead.
---

# Check TreeDiagram

Audit the design constructively without manufacturing evidence or silently changing accepted state.

## Inspect the focus

1. Confirm `design_workspace_get` works. In Codex use `hostKind: "codex"`, `clientRef: "codex-agent"`, and the exposed task identifier or one task-stable fallback. In Hermes use `hostKind: "hermes"`, `clientRef: "hermes-agent"`, and `hostSessionRef: "${HERMES_SESSION_ID}"`. Accept the latest project-visible focus returned across task sessions even when its source `hostSessionRef` differs.
2. Read `attention_get` and `design_context_get`. Treat `primaryChangeId` and `selectedChangeIds` as explicit user-marked, Agent-visible candidate focus and check those `selectedChanges` before broader context. If both node and candidate focus are empty after project-level resolution, require an explicit target rather than auditing the entire workspace.
3. Call `design_impact_get` for the focused nodes and inspect incoming support, contradiction, constraint, dependency, and decision relations.
4. Publish agent focus as `reading` while inspecting and `idle` when finished.

## Run the check

Check separately for:

- premises recorded as facts without evidence;
- supported claims whose evidence is missing, circular, or no longer relevant;
- options rejected without criteria and decisions without alternatives;
- constraints that conflict or have no measurable consequence;
- failure modes, boundary conditions, and stakeholders not represented;
- questions whose answer blocks validation or release.

If the user asked only for findings, report them and do not write. If they asked to record the findings, use the active owned ChangeSet or begin one, then propose only durable `question`, `risk`, `constraint`, `validation_method`, or `contradicts`/`depends_on` changes. Keep facts and hypotheses visibly distinct and submit one semantic change per call.

Never adopt or publish findings yourself. A chat response is not a grant, and an approval token must never be fabricated or requested. On lease or permission errors, direct the user to the Sidecar for the exact explicit action.
