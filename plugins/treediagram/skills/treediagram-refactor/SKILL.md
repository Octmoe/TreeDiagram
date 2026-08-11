---
name: treediagram-refactor
description: Restructure one overloaded TreeDiagram node or sweep the entire design tree for composite nodes, extracting atomic reviewable children while preserving intent and cross-checking the projected structure against the whole working tree. Use when a node contains several implicit claims, decisions, constraints, questions, risks, or implementation steps; when the user asks to split, decompose, normalize, clean up, or refactor a node, branch, or the whole tree; or when rapid early exploration has produced coarse nodes that now need durable structure. Do not use for ordinary expansion; use treediagram-derive. Do not use for a findings-only audit; use treediagram-check.
---

# Refactor TreeDiagram

Normalize structure without changing settled intent. Allow coarse nodes during rapid exploration; split them only when their internal parts need independent review, evidence, relations, or change histories.

## Choose the refactor scope

- Use **focused mode** for an explicitly selected node or candidate. Refactor only that source.
- Use **whole-tree sweep mode** only when the user explicitly asks to split, normalize, or refactor every composite node or invokes the whole-tree shortcut. Treat the current Attention as context, not a scope boundary, and continue across all high-confidence sources without waiting between source batches.

## Read the whole tree before editing

1. Verify `design_workspace_get`. In Codex use `hostKind: "codex"`, `clientRef: "codex-agent"`, and the exposed task identifier or one task-stable fallback. In Hermes use `hostKind: "hermes"`, `clientRef: "hermes-agent"`, and `hostSessionRef: "${HERMES_SESSION_ID}"`.
2. Read `attention_get` and `design_context_get`. In focused mode, prefer an explicitly focused candidate, then a focused Working node, and require exactly one source. In whole-tree sweep mode, do not require an anchor and do not limit the scan to the focused branch.
3. Read `design_tree_get` for the complete Working tree and `design_relations_get` for all relations, not only the focused context package. Read `design_changeset_get` with the current `hostSessionRef`, then call `design_impact_get` for Working source nodes and affected endpoints.
4. Publish agent focus as `reading` while inspecting and `proposing` only while writing candidates.

## Decide whether the source is overloaded

Split only when at least two internal parts can independently change, be accepted, receive evidence, carry constraints, or participate in different relations. Strong signals include:

- one node mixing decisions with their constraints, risks, questions, evidence, or validation;
- enumerated requirements that have different dependencies or owners;
- several assertions hidden in prose but connected through one coarse title;
- incoming or outgoing relations that apply to different fragments of the node;
- repeated qualifications that should carry distinct epistemic or review states.

Do not split merely because content is long. Keep a cohesive explanation, tightly coupled invariant, or compact rationale together. Avoid premature normalization while the idea is still moving quickly.

## Inventory a whole-tree sweep

In whole-tree sweep mode:

1. Evaluate every Working node and proposed node candidate against the overload criteria. Include candidate structure in the projected tree so an already proposed split is not proposed again.
2. Record each high-confidence source, the independent units hidden inside it, affected relations, projected depth, and any ambiguity that prevents a safe split.
3. Order source batches by projected `contains` ancestry, parents before descendants, so the candidate tree and approval sequence stay understandable. Preserve the existing stable order for unrelated branches.
4. Re-evaluate the remaining inventory after every source batch against the updated projected tree. A newly extracted child may expose or eliminate another apparent composite node.
5. Continue until no high-confidence composite source remains. Report ambiguous sources separately; do not turn uncertainty into invented structure.

## Build the projected split

1. Keep the source node as a stable umbrella and revise it to a concise scope statement. Never delete or replace a root merely to obtain a cleaner shape.
2. Extract one semantic unit per child and choose its most specific type: `claim`, `decision`, `constraint`, `question`, `risk`, `evidence`, or `validation_method`. Preserve fact versus assumption and approval state accurately.
3. Propose one `contains` relation from the source to each new child. The Sidecar bundles that relation with child approval.
4. Keep a semantic relation on the source when it applies to every child. When it belongs to one child, propose removal of the old relation and creation of the correctly attached relation; do not pretend `revise_relation` can change endpoints.
5. Reuse an existing equivalent node instead of creating a duplicate. Because a node can have only one `contains` parent, use an appropriate cross-branch semantic relation unless the user explicitly intends to move it.
6. Revise a matching pending candidate with `design_change_revise` instead of stacking another candidate for the same idea.

## Cross-check the projected whole tree

Before proposing, compare every extracted child and relation change against all Working nodes, relations, and pending candidates. Check for:

- duplicates, near-duplicates, and competing terminology;
- contradictions and mutually exclusive decisions;
- missing or reversed dependencies, constraints, support, and evidence;
- relations still attached to the umbrella even though they apply to only one child;
- cross-branch effects, unique-parent violations, or projected `contains` cycles;
- decisions without alternatives, claims without support, and risks without validation;
- conflicts between the projected split and already proposed candidates.

Treat this as a projected-tree review until the user adopts the candidates. Propose only high-confidence relation repairs required for the split; report uncertain cross-tree findings instead of flooding the ChangeSet.

## Propose one reviewable refactor batch

1. Use an `owned` ChangeSet or recover one explicitly marked `reclaimable` with `changeset_begin`. For `foreign_active`, call `changeset_lease_handoff_request` with the refactor purpose, tell the user to click “交给此 Agent” in Sidecar, and stop writing; after confirmation, re-read and proceed only when `owned`. Never ask the user to edit a URL or copy a session ID.
2. In focused mode, refactor one overloaded source and normally propose at most one source revision and three new child nodes, plus their bundled `contains` relations and only essential semantic rewires.
3. In whole-tree sweep mode, keep the same one-source batch boundary but proceed automatically through the complete inventory without waiting for adoption between sources. Extract every high-confidence independent unit needed to make each source cohesive; there is no workspace-wide candidate count cap after the user explicitly chooses this mode.
4. Submit one semantic change per `design_change_propose` call and carry forward the latest ChangeSet version. When the source is itself a candidate, revise that candidate instead of creating a parallel replacement; propose its children and bundled `contains` relations so parent-first approval remains enforceable.
5. After every source batch, cross-check all Working nodes, relations, and pending candidates again before processing the next source.
6. Summarize the source content retained, each unit extracted, every relation moved or retained, and the whole-tree conflicts checked. In whole-tree sweep mode, also report processed source count, remaining ambiguous sources, and whether the high-confidence inventory is exhausted.
7. Let the user review and adopt the candidates. After adoption, re-read the complete tree and impact closure before validation or later semantic work.
8. Finish agent focus as `idle` with `complete: true`.

Never adopt, publish, confirm root, expand delegation, or take an active lease from chat approval. Never manufacture or request an ApprovalGrant. Refactoring changes structure, not product intent; expose any semantic change as a separate candidate rather than hiding it inside cleanup.
