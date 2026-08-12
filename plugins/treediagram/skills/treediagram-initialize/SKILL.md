---
name: treediagram-initialize
description: Initialize a TreeDiagram V2 workspace from a fuzzy brief or reconstruct an existing complex design into a reviewable tree. Use when a user asks to start, initialize, structure, map, organize, reverse-engineer, or recover the reasoning of an existing design. In reconstruction mode, decompose from the overall structure into details across multiple passes, distinguish source facts from inferred rationale, and record problem-producing relations. Do not use for splitting one already-modeled composite node; use treediagram-refactor.
---

# Initialize TreeDiagram

Establish a durable design tree without turning TreeDiagram into a chat or model runner. Use a small-root workflow for a new idea and a multi-pass reconstruction workflow for an existing complex design.

## Detect capabilities and bind the task

1. Call `design_workspace_get` before planning writes. Treat a successful call as the MCP capability check.
2. The plugin binds MCP and the Sidecar to the current Codex project automatically. If the tool is unavailable, report the injected TreeDiagram startup diagnostic and ask the user to trust or reinstall the local plugin; do not ask them to run a per-project npm startup command and never invent tool results.
3. In Codex, use `hostKind: "codex"`, the exposed task identifier or one task-stable opaque fallback as `hostSessionRef`, and `clientRef: "codex-agent"`. In Hermes, use `hostKind: "hermes"`, `hostSessionRef: "${HERMES_SESSION_ID}"`, and `clientRef: "hermes-agent"`. Never mix identities within a session.
4. Call `attention_get` and `design_context_get` with that identity. The read tools deliberately resolve the project's most recently updated named Agent-visible focus across task sessions; a returned `hostSessionRef` identifies the source Sidecar tab and is not a reason to discard the focus. Treat `primaryNodeId` or `primaryChangeId` as the user's explicit target and prioritize returned `selectedChanges`.

## Choose the initialization mode

- Use **new-design mode** when the user has a fuzzy goal, an empty project, or wants the first durable design state. Keep the result deliberately small.
- Use **existing-design reconstruction mode** when the user asks to organize, map, reverse-engineer, document, or recover an already implemented or substantially specified design. Source material may be project files, documents, user explanations, or an existing coarse TreeDiagram.
- Infer the mode from the request and available material. Ask only when choosing the wrong mode would materially change the result.
- If the workspace already contains nodes, preserve them. Reuse or revise matching nodes and treat pending candidates as part of the projected tree; never create a parallel duplicate tree.

## Build a new design

1. Extract the goal, hard constraints, open questions, decisions, risks, and available evidence from the user's brief. Ask only about an ambiguity that would materially change the root.
2. Call `changeset_begin` with a short purpose-oriented title. If an existing ChangeSet has a missing, expired, or previous-system-boot lease, this call safely recovers that same ChangeSet and all of its candidates for the current session. If it reports a still-active foreign lease, call `changeset_lease_handoff_request` with the initialization purpose, tell the user to click “交给此 Agent” in Sidecar, and stop writing. After confirmation, re-read and continue only when the lease is `owned`; never ask the user to edit a URL or copy a session ID.
3. Propose one tentative `goal` root with `design_change_propose`, using `roles: ["root"]` (`design-root` remains a compatible alias for existing data). A root has no `contains` parent. Then propose only the minimum useful children and relations. Prefer explicit `constraint`, `question`, `decision`, `risk`, and `evidence` nodes over generic topics.
4. Submit one semantic change per proposal and pass the latest `expectedChangeSetVersion` every time. Re-read the ChangeSet after conflicts.
5. Publish agent focus with `attention_agent_focus_set` while reading, proposing, or validating; finish with `phase: "idle"` and `complete: true`.

## Reconstruct an existing complex design

Treat reconstruction as several analytical passes over one evolving projected tree. The user explicitly asked for comprehensive organization, so continue between high-confidence passes without waiting for adoption; candidates still remain individually reviewable and parent-first approval still applies.

### Pass 0: inventory sources and epistemic status

1. Inspect the existing design material before proposing. Record its major artifacts, boundaries, vocabulary, externally observable behavior, stated conclusions, and obvious omissions.
2. Separate three classes before modeling:
   - **sourced fact**: directly present in code, documents, evidence, or the user's explicit description;
   - **stated conclusion**: an existing decision or claim whose rationale may be absent;
   - **reconstructed hypothesis**: a likely assumption, motive, alternative, or intermediate inference not directly sourced.
3. Never promote a reconstructed hypothesis to fact. Give it `approvalState: "tentative"`, `epistemicState: "assumed"`, `reviewState: "required"`, and attributes such as `reconstructionKind`, `sourceRef`, and `confidence` when available. Use `evidence` nodes or source attributes for traceable sourced facts.

### Pass 1: overall decomposition

1. Establish or reuse one stable root that defines the design being reconstructed.
2. Split the design into a small set of cohesive top-level concerns such as goals, user/system boundaries, subsystems, core decisions, constraints, information flows, and cross-cutting risks. Prefer 3–7 top-level children over a flat dump.
3. Add `contains` relations with the child proposals so approval follows the projected structure. Do not hide several independently reviewable concerns in one top-level node.
4. Re-read the complete Working tree, relations, active ChangeSet, and projected candidates before the next pass.

### Pass 2: detail decomposition

1. Walk the projected tree parent-first. Split a node when at least two internal parts could independently change, be approved, receive evidence, carry a constraint, or participate in different relations.
2. Process one source node per batch, normally extracting 2–5 cohesive children. After each batch, re-read the projected tree and reassess remaining composites; a new child may expose or eliminate another apparent split.
3. Continue until no high-confidence composite remains. Report genuinely ambiguous sources instead of inventing structure.
4. Reuse equivalent Working nodes and revise matching pending candidates. A node has only one `contains` parent; use semantic cross-links for other connections.

### Pass 3: recover missing reasoning

1. For each conclusion-only `decision` or `claim`, search the source material and projected tree for direct evidence, constraints, rejected options, dependencies, and consequences.
2. When support is sourced, connect it with `supports`, `constrains`, `depends_on`, `selects`, `rejects`, or `derived_from` and include a concise rationale.
3. When an intermediate premise is only plausible, propose a separate tentative `claim`, `constraint`, `question`, or `option` marked as a reconstructed hypothesis. Phrase it as “可能基于…” or another explicitly uncertain statement; never rewrite the conclusion as though the premise were confirmed.
4. Prefer a visible chain—source/evidence → assumption or constraint → option/decision → consequence—over embedding the whole explanation in one node body.

### Pass 4: mark problem formation and cross-check the whole tree

Use auxiliary semantic relations only when their direction and rationale are clear:

- `contradicts`: source and target assertions cannot both hold; treat it as symmetric in meaning.
- `violates`: source behavior or decision breaks the target constraint, invariant, or requirement.
- `causes`: source condition or decision produces the target risk, failure, or problem.
- `amplifies`: source does not create the target problem alone but makes it worse or more likely.
- `mitigates`: source reduces the likelihood or impact of the target risk or problem.
- `reveals`: source evidence, validation, or observation exposes the target latent problem.

Create a `risk`, `question`, or `constraint` node when a problem exists only inside prose and needs its own review state. Do not use problem relations as decorative labels. Cross-check every proposed relation against the whole projected tree for reversed direction, duplicate problems, conflicting constraints, unsupported conclusions, unhandled risks, and relations attached to the wrong abstraction level.

### Submit reconstruction batches

1. Acquire the ChangeSet exactly as in new-design mode. Use one semantic `design_change_propose` call per node or relation and always carry the latest `expectedChangeSetVersion`.
2. Preserve the parent-first structural order: parent node, child node, then the bundled `contains` relation and its semantic cross-links. The Sidecar will prevent adopting a child before its parent.
3. Publish `attention_agent_focus_set` throughout the passes. Re-read after conflicts and after every source batch.
4. Finish with a pass-by-pass summary: sourced structure captured, composites split, reconstructed hypotheses awaiting confirmation, problem relations added, ambiguous areas left open, and whether the high-confidence decomposition is exhausted.

## Preserve the approval boundary

- Proposals remain candidates. Never call adoption, root confirmation, delegation expansion, active lease takeover, or publish without a real user-gesture grant. Reclaiming a lease that the tool explicitly reports as `reclaimable` is expiry recovery, not takeover.
- Never fabricate an `approvalToken`, ask the user to paste one into chat, or treat conversational agreement as a grant.
- Direct the user to the project-specific Sidecar URL injected at session start. Preserve its active host kind and URL-encoded session reference. The user adopts candidates, confirms the root, and publishes there.
- Use an embedded MCP UI only after detecting that surface; the Sidecar remains the complete fallback.

Handle `agent_recoverable` errors by correcting the named field. On `state_conflict`, re-read state and versions. Stop for `user_input_required` or `permission_required` and explain the exact user action.
