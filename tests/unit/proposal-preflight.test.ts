import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asId } from '@treediagram/contracts';
import { emptyWorkingSet, preflightProposal } from '@treediagram/core';

function nodeAction(
  proposalRef: string,
  nodeType: 'claim' | 'goal' | 'topic' | 'question',
  overrides: { roles?: string[]; attributes?: unknown; epistemicState?: string | null } = {},
) {
  return {
    proposalRef,
    operation: 'create',
    logicalNodeId: null,
    baseRevisionId: null,
    nodeType,
    displayTitle: `节点 ${proposalRef}`,
    contentText: `内容 ${proposalRef}`,
    roles: overrides.roles ?? [],
    attributes:
      overrides.attributes ??
      (nodeType === 'goal'
        ? { priorityNote: null }
        : nodeType === 'question'
          ? { blocking: false }
          : null),
    approvalSuggestion: 'tentative',
    epistemicState: overrides.epistemicState ?? (nodeType === 'claim' ? 'assumed' : null),
    rationale: '测试',
  };
}

function contains(proposalRef: string, from: string, to: string) {
  return {
    proposalRef,
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from: { refKind: 'proposal', ref: from },
    to: { refKind: 'proposal', ref: to },
    rationale: '层级关系',
    attributes: null,
    approvalSuggestion: 'tentative',
  };
}

function proposal(nodeActions: unknown[], relationActions: unknown[]) {
  return {
    schemaVersion: 1,
    workflowType: 'initialize',
    summary: '初始化投影',
    nodeActions,
    relationActions,
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
  };
}

function preflight(value: unknown) {
  return preflightProposal({
    projectId: asId(randomUUID()),
    workingSet: emptyWorkingSet(),
    proposal: value,
    reviewCounts: { pending: 0, blocked: 0 },
    policies: [],
  });
}

describe('ProposalPreflight', () => {
  it('把 root tentative 分类为审批门，而不是结构错误', () => {
    const result = preflight(proposal([nodeAction('root', 'goal', { roles: ['root'] })], []));

    expect(result.approvalIssues.map((issue) => issue.code)).toEqual(['ROOT_NOT_USER_CONFIRMED']);
    expect(result.hardBlockingIssues).toEqual([]);
    expect(result.interactionRequests).toEqual([]);
  });

  it('复现真实异常：多父节点是自动修复项，blocking Question 转为执行期 Issue', () => {
    const result = preflight(
      proposal(
        [
          nodeAction('root', 'goal', { roles: ['root'] }),
          nodeAction('topic', 'topic'),
          nodeAction('goal', 'goal'),
          nodeAction('question', 'question', { attributes: { blocking: true } }),
        ],
        [
          contains('root-topic', 'root', 'topic'),
          contains('root-goal', 'root', 'goal'),
          contains('topic-goal', 'topic', 'goal'),
          contains('goal-question', 'goal', 'question'),
        ],
      ),
    );

    expect(result.hardBlockingIssues.map((issue) => issue.code)).toContain(
      'CONTAINS_MULTIPLE_PARENTS',
    );
    expect(result.interactionRequests).toEqual([
      expect.objectContaining({
        issueKey: 'preflight-blocking_question-question',
        questionText: '节点 question',
        relatedRefs: ['question'],
      }),
    ]);
    expect(result.approvalIssues.map((issue) => issue.code)).toContain('ROOT_NOT_USER_CONFIRMED');
  });

  it('没有 root 的 initialize 提案在写库前被识别为硬错误', () => {
    const result = preflight(proposal([nodeAction('claim', 'claim')], []));
    expect(result.hardBlockingIssues.map((issue) => issue.code)).toContain('ROOT_MISSING');
  });
});
