import type {
  Authorization,
  DelegationPolicy,
  DesignProposal,
  ProposalNodeAction,
  ProposalRelationAction,
  WorkflowRun,
} from '@treediagram/contracts';
import { DesignProposalSchema } from '@treediagram/contracts';
import { Value } from '@sinclair/typebox/value';
import { DomainError } from '../errors.js';
import type { ServiceContext, Author } from '../services/types.js';
import { NodeService } from '../services/node-service.js';
import { RelationService } from '../services/relation-service.js';
import { ChangeSetService } from '../services/change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';

/**
 * ProposalApplier（IMPLEMENTATION_DESIGN §12.4）：
 * schema 校验 → temp ref 解析 → 类型/端点校验 → 托管权限降级 → 原子事务写入。
 * 同一 proposalRef 不得重复；revise 的类型必须与逻辑实体原类型一致；
 * human_final 分支中的 ai_confirmed 自动降级为 tentative。
 */

export interface ApplyResult {
  appliedNodeRevisionIds: string[];
  appliedRelationRevisionIds: string[];
  nodeCount: number;
  relationCount: number;
  downgradedCount: number;
}

export interface ApplyOptions {
  /** 本 run 生效的托管策略（ai_managed 时由 runner 解析；否则 null）。 */
  effectivePolicy: DelegationPolicy | null;
  /**
   * 跳过 §4.6 候选影响登记。仅 reevaluate 工作流透传 true：
   * 迁移/替代修订本身是复核决议（§9.3），不得再重建复核项。
   */
  skipImpactRegistration?: boolean | undefined;
}

function assertProposal(proposal: unknown): asserts proposal is DesignProposal {
  if (!Value.Check(DesignProposalSchema, proposal)) {
    const first = [...Value.Errors(DesignProposalSchema, proposal)][0];
    throw new DomainError('MODEL_OUTPUT_INVALID', 'proposal 未通过 schema 校验', {
      path: first?.path,
      message: first?.message,
    });
  }
}

export class ProposalApplier {
  private readonly nodes: NodeService;
  private readonly relations: RelationService;
  private readonly changeSets: ChangeSetService;

  constructor(private readonly ctx: ServiceContext) {
    this.nodes = new NodeService(ctx);
    this.relations = new RelationService(ctx);
    this.changeSets = new ChangeSetService(ctx);
  }

  private get db() {
    return this.ctx.db;
  }

  /** 审批状态终值：ai_confirmed 仅在 ai_managed 策略下保留并绑定授权；其余降级 tentative。 */
  private resolveApproval(
    suggestion: 'draft' | 'tentative' | 'ai_confirmed',
    opts: ApplyOptions,
    run: WorkflowRun,
    downgraded: { count: number },
  ): {
    approvalState: 'draft' | 'tentative' | 'ai_confirmed';
    authorization: Authorization | null;
  } {
    if (suggestion === 'ai_confirmed') {
      if (opts.effectivePolicy) {
        return {
          approvalState: 'ai_confirmed',
          authorization: { workflowRunId: run.id, policyId: opts.effectivePolicy.id },
        };
      }
      downgraded.count += 1;
      return { approvalState: 'tentative', authorization: null };
    }
    return { approvalState: suggestion, authorization: null };
  }

  apply(
    project: ProjectRecord,
    run: WorkflowRun,
    rawProposal: unknown,
    opts: ApplyOptions,
    author: Author,
  ): ApplyResult {
    assertProposal(rawProposal);
    const proposal = rawProposal;

    return this.db.transaction(() => {
      // proposalRef 全局唯一
      const refs = new Set<string>();
      for (const action of [...proposal.nodeActions, ...proposal.relationActions]) {
        if (refs.has(action.proposalRef)) {
          throw new DomainError('MODEL_OUTPUT_INVALID', 'proposalRef 重复', {
            proposalRef: action.proposalRef,
          });
        }
        refs.add(action.proposalRef);
      }

      const downgraded = { count: 0 };
      const revisionByRef = new Map<string, string>();
      const appliedNodeRevisionIds: string[] = [];
      const appliedRelationRevisionIds: string[] = [];

      for (const action of proposal.nodeActions) {
        const { approvalState, authorization } = this.resolveApproval(
          action.approvalSuggestion,
          opts,
          run,
          downgraded,
        );
        const fields = {
          displayTitle: action.displayTitle,
          contentText: action.contentText,
          roles: action.roles,
          attributes: action.attributes,
          approvalState,
          epistemicState: action.epistemicState,
        };
        let revisionId: string;
        if (action.operation === 'create') {
          const detail = this.nodes.createCandidateNode(project, action.nodeType, fields, author, {
            authorization,
            skipImpactRegistration: opts.skipImpactRegistration,
          });
          revisionId = detail.revision.id;
        } else {
          if (!action.logicalNodeId || !action.baseRevisionId) {
            throw new DomainError(
              'MODEL_OUTPUT_INVALID',
              'revise 缺少 logicalNodeId/baseRevisionId',
              {
                proposalRef: action.proposalRef,
              },
            );
          }
          const original = this.db.repos.node.getNodeById(action.logicalNodeId);
          if (!original) {
            throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 目标节点不存在', {
              proposalRef: action.proposalRef,
              logicalNodeId: action.logicalNodeId,
            });
          }
          if (original.nodeType !== action.nodeType) {
            throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 不得改变 nodeType', {
              proposalRef: action.proposalRef,
              expected: original.nodeType,
              actual: action.nodeType,
            });
          }
          const detail = this.nodes.reviseCandidateNode(
            project,
            action.logicalNodeId,
            action.baseRevisionId,
            fields,
            author,
            { authorization, skipImpactRegistration: opts.skipImpactRegistration },
          );
          revisionId = detail.revision.id;
        }
        revisionByRef.set(action.proposalRef, revisionId);
        appliedNodeRevisionIds.push(revisionId);
      }

      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { working } = this.changeSets.buildViews(changeSet);
      const activeRevisionIds = new Set(
        [...working.nodeRevisionByNodeId.values()].map((r) => r.id as string),
      );

      const resolveEndpoint = (endpoint: ProposalRelationAction['from']): string => {
        if (endpoint.refKind === 'proposal') {
          const revisionId = revisionByRef.get(endpoint.ref);
          if (!revisionId) {
            throw new DomainError('MODEL_OUTPUT_INVALID', '关系端点引用了不存在的 proposalRef', {
              ref: endpoint.ref,
            });
          }
          return revisionId;
        }
        // proposal 内新建节点的修订也算活动（先建节点后建关系）
        if (!activeRevisionIds.has(endpoint.ref) && !revisionByRef.has(endpoint.ref)) {
          throw new DomainError('MODEL_OUTPUT_INVALID', '关系端点引用了不活动的 revision', {
            ref: endpoint.ref,
          });
        }
        return revisionByRef.get(endpoint.ref) ?? endpoint.ref;
      };

      for (const action of proposal.relationActions) {
        const { approvalState, authorization } = this.resolveApproval(
          action.approvalSuggestion,
          opts,
          run,
          downgraded,
        );
        const fields = {
          fromNodeRevisionId: resolveEndpoint(action.from),
          toNodeRevisionId: resolveEndpoint(action.to),
          rationaleText: action.rationale,
          attributes: action.attributes,
          approvalState,
        };
        let revisionId: string;
        if (action.operation === 'create') {
          const detail = this.relations.createCandidateRelation(
            project,
            action.relationType,
            fields,
            author,
            { authorization, skipImpactRegistration: opts.skipImpactRegistration },
          );
          revisionId = detail.revision.id;
        } else {
          if (!action.logicalRelationId || !action.baseRelationRevisionId) {
            throw new DomainError(
              'MODEL_OUTPUT_INVALID',
              'revise 关系缺少 logicalRelationId/baseRelationRevisionId',
              { proposalRef: action.proposalRef },
            );
          }
          const original = this.db.repos.relation.getRelationById(action.logicalRelationId);
          if (!original) {
            throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 目标关系不存在', {
              proposalRef: action.proposalRef,
              logicalRelationId: action.logicalRelationId,
            });
          }
          if (original.relationType !== action.relationType) {
            throw new DomainError('MODEL_OUTPUT_INVALID', 'revise 不得改变 relationType', {
              proposalRef: action.proposalRef,
              expected: original.relationType,
              actual: action.relationType,
            });
          }
          const detail = this.relations.reviseCandidateRelation(
            project,
            action.logicalRelationId,
            action.baseRelationRevisionId,
            fields,
            author,
            { authorization, skipImpactRegistration: opts.skipImpactRegistration },
          );
          revisionId = detail.revision.id;
        }
        appliedRelationRevisionIds.push(revisionId);
      }

      return {
        appliedNodeRevisionIds,
        appliedRelationRevisionIds,
        nodeCount: appliedNodeRevisionIds.length,
        relationCount: appliedRelationRevisionIds.length,
        downgradedCount: downgraded.count,
      };
    });
  }
}
