import { describe, expect, it } from 'vitest';
import { checkConsistency } from '@treediagram/core';
import { asId, type DelegationPolicy } from '@treediagram/contracts';
import { randomUUID } from 'node:crypto';
import { issueCodes, makeNode, makeRelation, wsOf } from '../helpers/workspace.js';

function run(
  ws: ReturnType<typeof wsOf>,
  reviewCounts = { pending: 0, blocked: 0 },
  policies: DelegationPolicy[] = [],
) {
  return checkConsistency({ workingSet: ws, reviewCounts, policies });
}

function policy(
  scopeNodeId: string,
  mode: 'human_final' | 'ai_managed' = 'ai_managed',
): DelegationPolicy {
  return {
    id: asId(randomUUID()),
    projectId: asId(randomUUID()),
    scopeNodeId: asId(scopeNodeId),
    mode,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  };
}

describe('一致性检查器 blocking codes（§8.2）', () => {
  it('ROOT_MISSING', () => {
    const a = makeNode('claim');
    const issues = run(wsOf([a], []));
    expect(issueCodes(issues)).toContain('ROOT_MISSING');
  });

  it('ROOT_INVALID_TYPE', () => {
    const a = makeNode('topic', { roles: ['root'] });
    const issues = run(wsOf([a], []));
    expect(issueCodes(issues)).toContain('ROOT_INVALID_TYPE');
  });

  it('ROOT_NOT_USER_CONFIRMED', () => {
    const a = makeNode('claim', { roles: ['root'], approvalState: 'tentative' });
    const issues = run(wsOf([a], []));
    expect(issueCodes(issues)).toContain('ROOT_NOT_USER_CONFIRMED');
  });

  it('ROOT_AI_CONFIRMED', () => {
    const a = makeNode('claim', { roles: ['root'], approvalState: 'ai_confirmed' });
    const issues = run(wsOf([a], []));
    expect(issueCodes(issues)).toContain('ROOT_AI_CONFIRMED');
    expect(issueCodes(issues)).not.toContain('ROOT_NOT_USER_CONFIRMED');
  });

  it('REVIEW_PENDING / REVIEW_BLOCKED', () => {
    const a = makeNode('claim', { roles: ['root'] });
    expect(issueCodes(run(wsOf([a], []), { pending: 2, blocked: 0 }))).toContain('REVIEW_PENDING');
    expect(issueCodes(run(wsOf([a], []), { pending: 0, blocked: 1 }))).toContain('REVIEW_BLOCKED');
  });

  it('CONTAINS_MULTIPLE_PARENTS', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const p1 = makeNode('topic');
    const p2 = makeNode('topic');
    const child = makeNode('claim');
    const r1 = makeRelation('contains', p1.revision, child.revision);
    const r2 = makeRelation('contains', p2.revision, child.revision);
    const issues = run(wsOf([root, p1, p2, child], [r1, r2]));
    expect(issueCodes(issues)).toContain('CONTAINS_MULTIPLE_PARENTS');
  });

  it('CONTAINS_CYCLE 返回完整环路修订列表', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('topic');
    const b = makeNode('topic');
    const r1 = makeRelation('contains', a.revision, b.revision);
    const r2 = makeRelation('contains', b.revision, a.revision);
    const issues = run(wsOf([root, a, b], [r1, r2]));
    const cycle = issues.find((i) => i.code === 'CONTAINS_CYCLE');
    expect(cycle).toBeDefined();
    expect(cycle?.relatedRevisionIds.length).toBeGreaterThanOrEqual(2);
    expect(cycle?.relatedRevisionIds).toContain(a.revision.id);
    expect(cycle?.relatedRevisionIds).toContain(b.revision.id);
  });

  it('RELATION_ENDPOINT_MISSING：端点不是工作版本活动修订', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim');
    const b = makeNode('claim');
    const ghost = makeNode('claim');
    const rel = makeRelation('depends_on', a.revision, ghost.revision);
    const issues = run(wsOf([root, a, b], [rel]));
    const issue = issues.find((i) => i.code === 'RELATION_ENDPOINT_MISSING');
    expect(issue).toBeDefined();
    expect(issue?.entityKind).toBe('relation_revision');
  });

  it('RELATION_ENDPOINT_TYPE_INVALID', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim');
    const b = makeNode('claim');
    const rel = makeRelation('supports', a.revision, b.revision);
    const issues = run(wsOf([root, a, b], [rel]));
    expect(issueCodes(issues)).toContain('RELATION_ENDPOINT_TYPE_INVALID');
  });

  it('SUPPORTED_WITHOUT_EVIDENCE', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim', { epistemicState: 'supported' });
    expect(issueCodes(run(wsOf([root, a], [])))).toContain('SUPPORTED_WITHOUT_EVIDENCE');

    const ev = makeNode('evidence');
    const sup = makeRelation('supports', ev.revision, a.revision);
    expect(issueCodes(run(wsOf([root, a, ev], [sup])))).not.toContain('SUPPORTED_WITHOUT_EVIDENCE');
  });

  it('IMPORTANT_DECISION_MISSING_QUESTION', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const dec = makeNode('decision', {
      attributes: {
        importance: 'important',
        noAlternativeFound: false,
        alternativeSearchNote: null,
      },
      contentText: '理由',
    });
    expect(issueCodes(run(wsOf([root, dec], [])))).toContain('IMPORTANT_DECISION_MISSING_QUESTION');
  });

  it('IMPORTANT_DECISION_MISSING_OPTIONS', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const q = makeNode('question');
    const dec = makeNode('decision', {
      attributes: {
        importance: 'important',
        noAlternativeFound: false,
        alternativeSearchNote: null,
      },
      contentText: '理由',
    });
    const addr = makeRelation('addresses', dec.revision, q.revision);
    const issues = run(wsOf([root, q, dec], [addr]));
    expect(issueCodes(issues)).toContain('IMPORTANT_DECISION_MISSING_OPTIONS');
    expect(issueCodes(issues)).not.toContain('IMPORTANT_DECISION_MISSING_QUESTION');
  });

  it('IMPORTANT_DECISION_MISSING_SEARCH_NOTE', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const q = makeNode('question');
    const dec = makeNode('decision', {
      attributes: {
        importance: 'important',
        noAlternativeFound: true,
        alternativeSearchNote: null,
      },
      contentText: '理由',
    });
    const addr = makeRelation('addresses', dec.revision, q.revision);
    expect(issueCodes(run(wsOf([root, q, dec], [addr])))).toContain(
      'IMPORTANT_DECISION_MISSING_SEARCH_NOTE',
    );
  });

  it('DECISION_DEPENDS_ON_REFUTED', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const refuted = makeNode('claim', { epistemicState: 'refuted' });
    const dec = makeNode('decision', { contentText: '理由' });
    const dep = makeRelation('depends_on', dec.revision, refuted.revision);
    expect(issueCodes(run(wsOf([root, refuted, dec], [dep])))).toContain(
      'DECISION_DEPENDS_ON_REFUTED',
    );
  });

  it('BLOCKING_QUESTION', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const q = makeNode('question', { attributes: { blocking: true } });
    expect(issueCodes(run(wsOf([root, q], [])))).toContain('BLOCKING_QUESTION');

    const opt = makeNode('option');
    const addr = makeRelation('addresses', opt.revision, q.revision);
    expect(issueCodes(run(wsOf([root, q, opt], [addr])))).not.toContain('BLOCKING_QUESTION');
  });

  it('BLOCKING_CONTRADICTION', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim');
    const b = makeNode('claim');
    const rel = makeRelation('contradicts', a.revision, b.revision, { blocking: true });
    expect(issueCodes(run(wsOf([root, a, b], [rel])))).toContain('BLOCKING_CONTRADICTION');
  });

  it('AI_CONFIRMATION_OUT_OF_SCOPE：无授权或策略不覆盖', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim', {
      approvalState: 'ai_confirmed',
      authorization: null,
    });
    expect(issueCodes(run(wsOf([root, a], [])))).toContain('AI_CONFIRMATION_OUT_OF_SCOPE');

    // 有授权且策略作用域覆盖（root 上挂 policy，a 在 root 子树内）
    const pol = policy(root.node.id);
    const b = makeNode('claim', {
      approvalState: 'ai_confirmed',
      authorization: { workflowRunId: asId(randomUUID()), policyId: pol.id },
    });
    const contains = makeRelation('contains', root.revision, b.revision);
    expect(
      issueCodes(run(wsOf([root, b], [contains]), { pending: 0, blocked: 0 }, [pol])),
    ).not.toContain('AI_CONFIRMATION_OUT_OF_SCOPE');
  });
});

describe('一致性检查器 warning codes（§8.2）', () => {
  it('ORPHAN_TOP_LEVEL_NODE', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const orphan = makeNode('claim');
    const issues = run(wsOf([root, orphan], []));
    const warning = issues.find((i) => i.code === 'ORPHAN_TOP_LEVEL_NODE');
    expect(warning?.severity).toBe('warning');
  });

  it('ASSUMPTION_WITHOUT_VALIDATION_METHOD', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const a = makeNode('claim', { epistemicState: 'assumed' });
    expect(issueCodes(run(wsOf([root, a], [])))).toContain('ASSUMPTION_WITHOUT_VALIDATION_METHOD');

    const vm = makeNode('validation_method');
    const link = makeRelation('derived_from', vm.revision, a.revision);
    expect(issueCodes(run(wsOf([root, a, vm], [link])))).not.toContain(
      'ASSUMPTION_WITHOUT_VALIDATION_METHOD',
    );
  });

  it('EVIDENCE_LIMITATIONS_EMPTY', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const ev = makeNode('evidence', {
      attributes: {
        evidenceKind: 'external_source',
        sourceAssetId: null,
        method: '',
        premises: [],
        limitations: [],
      },
    });
    expect(issueCodes(run(wsOf([root, ev], [])))).toContain('EVIDENCE_LIMITATIONS_EMPTY');
  });

  it('SIMPLE_DECISION_HAS_WIDE_IMPACT', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const dec = makeNode('decision', { contentText: '理由' });
    const dependents = [makeNode('claim'), makeNode('claim'), makeNode('claim'), makeNode('claim')];
    const deps = dependents.map((d) => makeRelation('depends_on', d.revision, dec.revision));
    expect(issueCodes(run(wsOf([root, dec, ...dependents], deps)))).toContain(
      'SIMPLE_DECISION_HAS_WIDE_IMPACT',
    );
  });

  it('UNRESOLVED_NON_BLOCKING_QUESTION', () => {
    const root = makeNode('claim', { roles: ['root'] });
    const q = makeNode('question', { attributes: { blocking: false } });
    const issues = run(wsOf([root, q], []));
    const warning = issues.find((i) => i.code === 'UNRESOLVED_NON_BLOCKING_QUESTION');
    expect(warning?.severity).toBe('warning');
  });
});

describe('检查器去重（最小阻塞集合语义）', () => {
  it('同一实体同一 code 不重复', () => {
    const a = makeNode('claim', { epistemicState: 'supported' });
    const issues = run(wsOf([a], []));
    const matches = issues.filter(
      (i) => i.code === 'SUPPORTED_WITHOUT_EVIDENCE' && i.entityRevisionId === a.revision.id,
    );
    expect(matches.length).toBe(1);
  });
});
