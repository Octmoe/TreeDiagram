---
name: treediagram-grill
description: Interview the user in rounds to clarify a focused TreeDiagram plan, decision, or idea until reaching shared understanding. Use when the user says "grill me", asks to be questioned or interviewed, wants to stress-test their thinking interactively, wants help thinking something through, or wants hidden decisions surfaced before action. Do not use for a one-shot critique or findings report; use treediagram-check instead.
---

# Grill Me in TreeDiagram

Interview the user before acting. Treat the subject as a decision tree: every settled decision can expose decisions that depend on it.

## Establish the subject and known facts

1. Confirm `design_workspace_get` works. In Codex use `hostKind: "codex"`, `clientRef: "codex-agent"`, and the exposed task identifier or one task-stable fallback. In Hermes use `hostKind: "hermes"`, `clientRef: "hermes-agent"`, and `hostSessionRef: "${HERMES_SESSION_ID}"`.
2. Read `attention_get` and `design_context_get`. Prefer explicitly selected candidates, then focused Working nodes. If nothing is selected, use the plan, decision, or idea stated in the conversation; Grill does not require a tree selection when the user has supplied a clear subject.
3. Inspect `design_impact_get`, repository files, and available tools whenever they can answer a factual question. Finding facts is the Agent's job; ask the user only for judgments, preferences, intent, and decisions.
4. Publish agent focus as `reading` while inspecting TreeDiagram context and `idle` before asking the user.

## Work the decision frontier

Maintain a conversational decision tree without writing it into Design State. The frontier is every unresolved decision whose prerequisites are already settled. Ask the whole current frontier in one round unless the user requests one question at a time.

Format each round as numbered questions. For every question:

```text
❓ Q1 — <short decision title>: <question, context, and useful choices>
➡️ Recommended: <the Agent's recommended answer and why>
```

Recommendations are proposals, not decisions. The user owns the scope and may disagree, answer "I don't know", narrow the subject, or defer a branch.

After asking the round, wait. Do not answer on the user's behalf, implement, or write candidates in the same turn.

## Recompute after every answer

- Mark answered decisions settled and use them to expose the next frontier.
- Keep a question for a later round when it depends on another unresolved answer.
- Research newly discoverable facts instead of asking the user.
- When an answer cannot be known through discussion, identify the required prototype, experiment, or `validation_method`; do not keep rephrasing the question.
- If the subject is too large for a coherent session, propose smaller subtrees and let the user select which one to grill first.

## Finish only on shared understanding

The interview is ready to finish when the frontier is empty: every relevant branch has been visited and no important decision remains silently assumed. Summarize settled decisions, explicit assumptions, deferred branches, and required validation, then ask the user to confirm that shared understanding has been reached.

Do not implement or write TreeDiagram changes until the user confirms. Confirmation still does not authorize design writes unless the user also asked to record the outcome. When recording is explicitly requested, read `design_changeset_get` with the current `hostSessionRef`: use an `owned` ChangeSet or recover one explicitly marked `reclaimable` with `changeset_begin`. For `foreign_active`, call `changeset_lease_handoff_request` with the recording purpose, tell the user to click “交给此 Agent” in Sidecar, and stop writing; after confirmation, re-read and proceed only when `owned`. Then propose the settled decisions as small, reviewable nodes and relations, one semantic change per call. Never ask the user to edit a URL or copy a session ID.

Never adopt or publish the result yourself. Chat confirmation is not an ApprovalGrant.
