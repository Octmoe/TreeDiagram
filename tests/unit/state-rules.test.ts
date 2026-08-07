import { describe, expect, it } from 'vitest';
import {
  asId,
  checkNodeAttributes,
  type DelegationPolicyId,
  type WorkflowRunId,
} from '@treediagram/contracts';

const AUTH = {
  workflowRunId: asId<WorkflowRunId>('w'.padEnd(36, '0')),
  policyId: asId<DelegationPolicyId>('p'.padEnd(36, '0')),
};
import {
  DomainError,
  assertChangeSetTransition,
  assertDecisionAttributesValid,
  assertEvidenceAttributesValid,
  assertRevisionWriteAllowed,
  assertWorkflowRunTransition,
  nextProjectState,
} from '@treediagram/core';

describe('节点属性 schema（§4.2）', () => {
  it('各类型封闭 attributes 校验', () => {
    expect(checkNodeAttributes('topic', {})).toBe(true);
    expect(checkNodeAttributes('topic', { extra: 1 })).toBe(false);
    expect(checkNodeAttributes('goal', { priorityNote: null })).toBe(true);
    expect(checkNodeAttributes('constraint', { strength: 'hard' })).toBe(true);
    expect(checkNodeAttributes('constraint', { strength: 'bogus' })).toBe(false);
    expect(checkNodeAttributes('question', { blocking: true })).toBe(true);
    expect(
      checkNodeAttributes('decision', {
        importance: 'important',
        noAlternativeFound: false,
        alternativeSearchNote: null,
      }),
    ).toBe(true);
    expect(
      checkNodeAttributes('evidence', {
        evidenceKind: 'imported_material',
        sourceAssetId: null,
        method: '',
        premises: [],
        limitations: [],
      }),
    ).toBe(true);
  });
});

describe('root 规则（§4.3）', () => {
  const base = {
    roles: ['root'],
    approvalState: 'user_confirmed' as const,
    epistemicState: null,
    authorization: null,
    authorKind: 'user' as const,
    attributes: {},
  };

  it('root 只能挂在 claim/goal/constraint', () => {
    expect(() => assertRevisionWriteAllowed({ ...base, nodeType: 'topic' })).toThrow(DomainError);
    expect(() => assertRevisionWriteAllowed({ ...base, nodeType: 'claim' })).not.toThrow();
    expect(() => assertRevisionWriteAllowed({ ...base, nodeType: 'goal' })).not.toThrow();
    expect(() => assertRevisionWriteAllowed({ ...base, nodeType: 'constraint' })).not.toThrow();
  });

  it('root 不能 ai_confirmed', () => {
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        nodeType: 'claim',
        approvalState: 'ai_confirmed',
        authorKind: 'agent',
        authorization: AUTH,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ROOT_REQUIRES_USER_CONFIRMATION' }));
  });
});

describe('治理写入规则', () => {
  const base = {
    nodeType: 'claim' as const,
    roles: [],
    epistemicState: null,
    attributes: {},
  };

  it('ai_confirmed 必须携带授权且只能由 agent 写入', () => {
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        approvalState: 'ai_confirmed',
        authorization: null,
        authorKind: 'agent',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AI_SCOPE_VIOLATION' }));
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        approvalState: 'ai_confirmed',
        authorization: AUTH,
        authorKind: 'user',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AI_SCOPE_VIOLATION' }));
  });

  it('非 ai_confirmed 不得携带 authorization', () => {
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        approvalState: 'tentative',
        authorization: AUTH,
        authorKind: 'user',
      }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('Agent 永远不能创建 user_confirmed', () => {
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        approvalState: 'user_confirmed',
        authorization: null,
        authorKind: 'agent',
      }),
    ).toThrowError(expect.objectContaining({ code: 'AI_SCOPE_VIOLATION' }));
  });

  it('epistemic 仅适用于 claim/constraint/risk', () => {
    expect(() =>
      assertRevisionWriteAllowed({
        ...base,
        nodeType: 'topic',
        approvalState: 'draft',
        epistemicState: 'assumed',
        authorization: null,
        authorKind: 'user',
      }),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('Evidence 规则（§4.2）', () => {
  it('imported_material 必须有 sourceAssetId', () => {
    expect(() =>
      assertEvidenceAttributesValid({
        evidenceKind: 'imported_material',
        sourceAssetId: null,
        method: '',
        premises: [],
        limitations: [],
      }),
    ).toThrow(DomainError);
  });

  it('agent_argument/thought_experiment 必须有 method、premise、limitation', () => {
    const valid = {
      evidenceKind: 'thought_experiment' as const,
      sourceAssetId: null,
      method: 'm',
      premises: ['p'],
      limitations: ['l'],
    };
    expect(() => assertEvidenceAttributesValid(valid)).not.toThrow();
    expect(() => assertEvidenceAttributesValid({ ...valid, method: ' ' })).toThrow(DomainError);
    expect(() => assertEvidenceAttributesValid({ ...valid, premises: [] })).toThrow(DomainError);
    expect(() => assertEvidenceAttributesValid({ ...valid, limitations: [] })).toThrow(DomainError);
  });
});

describe('重要决策写入规则（§4.5）', () => {
  it('noAlternativeFound=true 必须有 search note', () => {
    expect(() =>
      assertDecisionAttributesValid(
        { importance: 'important', noAlternativeFound: true, alternativeSearchNote: ' ' },
        '理由',
      ),
    ).toThrow(DomainError);
  });

  it('重要决策 contentText 不允许空白', () => {
    expect(() =>
      assertDecisionAttributesValid(
        { importance: 'important', noAlternativeFound: false, alternativeSearchNote: null },
        '   ',
      ),
    ).toThrow(DomainError);
  });
});

describe('状态机迁移表（§4.6）', () => {
  it('project 迁移', () => {
    expect(nextProjectState('initializing', 'adopt_first')).toBe('reevaluating');
    expect(nextProjectState('initializing', 'publish_first')).toBe('consistent');
    expect(nextProjectState('consistent', 'adopt')).toBe('reevaluating');
    expect(nextProjectState('reevaluating', 'block')).toBe('blocked');
    expect(nextProjectState('blocked', 'resume')).toBe('reevaluating');
    expect(nextProjectState('reevaluating', 'publish')).toBe('consistent');
    expect(nextProjectState('blocked', 'abandon_with_base')).toBe('consistent');
    expect(() => nextProjectState('consistent', 'publish')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('changeSet 迁移', () => {
    expect(() => assertChangeSetTransition('open', 'reevaluating')).not.toThrow();
    expect(() => assertChangeSetTransition('reevaluating', 'ready')).not.toThrow();
    expect(() => assertChangeSetTransition('ready', 'published')).not.toThrow();
    expect(() => assertChangeSetTransition('ready', 'reevaluating')).not.toThrow();
    expect(() => assertChangeSetTransition('published', 'open')).toThrow(DomainError);
    expect(() => assertChangeSetTransition('abandoned', 'open')).toThrow(DomainError);
  });

  it('workflowRun 迁移', () => {
    expect(() => assertWorkflowRunTransition('queued', 'running')).not.toThrow();
    expect(() => assertWorkflowRunTransition('running', 'waiting_user')).not.toThrow();
    expect(() => assertWorkflowRunTransition('waiting_user', 'running')).not.toThrow();
    expect(() => assertWorkflowRunTransition('succeeded', 'running')).toThrow(DomainError);
    expect(() => assertWorkflowRunTransition('cancelled', 'running')).toThrow(DomainError);
  });
});
