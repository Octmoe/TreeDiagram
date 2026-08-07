import type {
  Authorization,
  ChangeSet,
  ChangeSetCounts,
  ConsistencyIssue,
  NodeId,
  RelationId,
  ReviewItem,
  ReviewVerdict,
} from '@treediagram/contracts';
import type { ChangeSetId } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from './types.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { assertChangeSetTransition, nextProjectState } from '../domain/state-rules.js';
import { buildWorkingSet, type WorkingSet } from '../domain/working-set.js';
import { analyzeImpact, impactEscapesScope, type ImpactResult } from '../domain/impact-analyzer.js';
import { checkConsistency } from '../domain/consistency-checker.js';
import type { NodeHead, RelationHead } from '../db/repositories/change-set.js';

export const REVIEW_REASON_IMPACT = 'IMPACT_REVIEW';

export interface AdoptResult {
  changeSet: ChangeSet;
  impact: ImpactResult;
  reviewItemsCreated: number;
  projectBlocked: boolean;
}

export interface ChangeSetCurrentView {
  changeSet: ChangeSet | null;
  counts: ChangeSetCounts | null;
  rootChange: boolean;
}

/**
 * ChangeSet 两阶段激活（IMPLEMENTATION_DESIGN §7.4、§4.6）。
 */
export class ChangeSetService {
  constructor(private readonly ctx: ServiceContext) {}

  private get db() {
    return this.ctx.db;
  }
  private get clock() {
    return this.ctx.clock;
  }

  /** 当前唯一 live ChangeSet；不存在则创建 open（base 指向 current Release）。 */
  getOrCreateOpen(project: ProjectRecord, author: Author): ChangeSet {
    return this.db.transaction(() => {
      const existing = this.db.repos.changeSet.getLiveByProject(project.id);
      if (existing) return existing;
      const now = this.clock.now();
      const changeSet: ChangeSet = {
        id: newId<ChangeSetId>(),
        projectId: project.id,
        baseReleaseId: project.currentReleaseId,
        status: 'open',
        title: '',
        description: '',
        adoptedAt: null,
        publishedReleaseId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.db.repos.changeSet.insert(changeSet);
      void author;
      return changeSet;
    });
  }

  getLive(project: ProjectRecord): ChangeSet | null {
    return this.db.repos.changeSet.getLiveByProject(project.id);
  }

  require(changeSetId: string): ChangeSet {
    const changeSet = this.db.repos.changeSet.getById(changeSetId);
    if (!changeSet) throw new DomainError('NOT_FOUND', 'changeSet 不存在', { changeSetId });
    return changeSet;
  }

  /** 构造 base / working 两个 WorkingSet（不修改数据库）。 */
  buildViews(changeSet: ChangeSet): {
    baseRelease: import('@treediagram/contracts').Release | null;
    base: WorkingSet;
    working: WorkingSet;
    nodeHeads: readonly NodeHead[];
    relationHeads: readonly RelationHead[];
  } {
    const baseRelease = changeSet.baseReleaseId
      ? this.db.repos.release.getById(changeSet.baseReleaseId)
      : null;
    if (changeSet.baseReleaseId && !baseRelease) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', 'changeSet 的 base Release 不存在', {
        baseReleaseId: changeSet.baseReleaseId,
      });
    }
    const nodeHeads = this.db.repos.changeSet.listNodeHeads(changeSet.id);
    const relationHeads = this.db.repos.changeSet.listRelationHeads(changeSet.id);
    const base = buildWorkingSet({
      baseRelease,
      nodeHeads: [],
      relationHeads: [],
      repos: this.db.repos,
    });
    const working = buildWorkingSet({
      baseRelease,
      nodeHeads,
      relationHeads,
      repos: this.db.repos,
    });
    return { baseRelease, base, working, nodeHeads, relationHeads };
  }

  /** 无 live ChangeSet 时的 release 视图。 */
  buildReleaseView(project: ProjectRecord): WorkingSet {
    const release = project.currentReleaseId
      ? this.db.repos.release.getById(project.currentReleaseId)
      : null;
    return buildWorkingSet({
      baseRelease: release,
      nodeHeads: [],
      relationHeads: [],
      repos: this.db.repos,
    });
  }

  private detectRootChange(changeSet: ChangeSet): boolean {
    const { base, working, nodeHeads } = this.buildViews(changeSet);
    for (const head of nodeHeads) {
      const nodeId = head.nodeId as NodeId;
      const baseRevision = base.nodeRevisionByNodeId.get(nodeId);
      const newRevision = working.nodeRevisionByNodeId.get(nodeId);
      if (baseRevision?.roles.includes('root') || newRevision?.roles.includes('root')) return true;
    }
    return false;
  }

  counts(changeSet: ChangeSet): ChangeSetCounts {
    const { base, nodeHeads, relationHeads } = this.buildViews(changeSet);
    const counts: ChangeSetCounts = {
      nodesCreated: 0,
      nodesRevised: 0,
      nodesRemoved: 0,
      relationsCreated: 0,
      relationsRevised: 0,
      relationsRemoved: 0,
    };
    for (const head of nodeHeads) {
      if (head.action === 'remove') counts.nodesRemoved += 1;
      else if (base.nodeRevisionByNodeId.has(head.nodeId as NodeId)) counts.nodesRevised += 1;
      else counts.nodesCreated += 1;
    }
    for (const head of relationHeads) {
      if (head.action === 'remove') counts.relationsRemoved += 1;
      else if (base.relationRevisionByRelationId.has(head.relationId as RelationId))
        counts.relationsRevised += 1;
      else counts.relationsCreated += 1;
    }
    return counts;
  }

  getCurrentView(project: ProjectRecord): ChangeSetCurrentView {
    const changeSet = this.getLive(project);
    if (!changeSet) return { changeSet: null, counts: null, rootChange: false };
    return {
      changeSet,
      counts: this.counts(changeSet),
      rootChange: this.detectRootChange(changeSet),
    };
  }

  /** 为受影响实体建立 review items（幂等：唯一行复用并重置为 pending）。 */
  private ensureReviewItems(
    changeSet: ChangeSet,
    impact: ImpactResult,
    working: WorkingSet,
  ): number {
    const now = this.clock.now();
    let created = 0;
    for (const nodeId of impact.affectedNodeIds) {
      const revision = working.nodeRevisionByNodeId.get(nodeId);
      if (!revision) continue; // removed 节点无活动修订
      this.db.repos.reviewItem.ensurePending(
        changeSet.id,
        'node_revision',
        revision.id,
        REVIEW_REASON_IMPACT,
        now,
      );
      created += 1;
    }
    for (const relationId of impact.affectedRelationIds) {
      const revision = working.relationRevisionByRelationId.get(relationId);
      if (!revision) continue;
      this.db.repos.reviewItem.ensurePending(
        changeSet.id,
        'relation_revision',
        revision.id,
        REVIEW_REASON_IMPACT,
        now,
      );
      created += 1;
    }
    return created;
  }

  /**
   * 直接阻塞评估：忽略 REVIEW_* 类（由复核流程消化），其余 blocking issue
   * 使 project 进入 blocked 并写 reevaluation.blocked 事件。
   */
  private evaluateDirectBlockers(
    project: ProjectRecord,
    changeSet: ChangeSet,
    working: WorkingSet,
  ): ConsistencyIssue[] {
    const policies = this.db.repos.delegation.listActiveByProject(project.id);
    const allPolicies = policies; // active policies；历史追溯由 checker 使用全量表查询补充
    const issues = checkConsistency({
      workingSet: working,
      reviewCounts: { pending: 0, blocked: 0 },
      policies: allPolicies,
    });
    const blocking = issues.filter((i) => i.severity === 'blocking');
    const now = this.clock.now();
    if (blocking.length > 0 && project.status !== 'blocked') {
      const current = this.db.repos.project.requireSingleton();
      if (current.status === 'reevaluating') {
        nextProjectState(current.status, 'block');
        this.db.repos.project.updateStatus(
          current.id,
          'blocked',
          {
            reasonCode: 'DIRECT_BLOCKERS',
            message: `重评发现 ${blocking.length} 个直接阻塞项`,
            issues: blocking.map((i) => ({ ...i })),
          },
          now,
        );
        this.db.repos.event.append(
          current.id,
          'reevaluation.blocked',
          {
            changeSetId: changeSet.id,
            issues: blocking.map((i) => ({ code: i.code, entityRevisionId: i.entityRevisionId })),
          },
          now,
        );
      }
    }
    return blocking;
  }

  /** adopt 事务（§7.4）。 */
  adopt(changeSetId: string, author: Author, authorization?: Authorization): AdoptResult {
    return this.db.transaction(() => {
      const project = this.db.repos.project.requireSingleton();
      const changeSet = this.require(changeSetId);
      if (changeSet.status !== 'open') {
        throw new DomainError('INVALID_STATE_TRANSITION', '只有 open 状态的 ChangeSet 可以 adopt', {
          status: changeSet.status,
        });
      }
      if (project.status !== 'initializing' && project.status !== 'consistent') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          `project 状态 ${project.status} 不允许 adopt`,
          {
            status: project.status,
          },
        );
      }
      if (changeSet.baseReleaseId !== project.currentReleaseId) {
        throw new DomainError(
          'STALE_BASE_REVISION',
          'ChangeSet 的 base Release 与当前 Release 不一致',
          {
            changeSetBase: changeSet.baseReleaseId,
            currentReleaseId: project.currentReleaseId,
          },
        );
      }

      const { baseRelease, base, working, nodeHeads, relationHeads } = this.buildViews(changeSet);
      const impact = analyzeImpact(base, working, nodeHeads, relationHeads);

      // 权限检查（§7.4 步骤 3 / §10）
      if (author.kind === 'agent') {
        if (impact.rootChange) {
          throw new DomainError('AI_SCOPE_VIOLATION', 'root change 必须由用户 adopt');
        }
        if (!authorization) {
          throw new DomainError('AI_SCOPE_VIOLATION', 'agent adopt 必须携带托管授权');
        }
        const policy = this.db.repos.delegation.getById(authorization.policyId);
        if (!policy || policy.revokedAt !== null || policy.mode !== 'ai_managed') {
          throw new DomainError('AI_SCOPE_VIOLATION', '托管策略无效或已撤销', {
            policyId: authorization.policyId,
          });
        }
        if (impactEscapesScope(impact, working, policy.scopeNodeId)) {
          throw new DomainError('AI_SCOPE_VIOLATION', '影响闭包越出托管子树', {
            scopeNodeId: policy.scopeNodeId,
          });
        }
      }

      const reviewItemsCreated = this.ensureReviewItems(changeSet, impact, working);

      const now = this.clock.now();
      assertChangeSetTransition(changeSet.status, 'reevaluating');
      this.db.repos.changeSet.updateStatus(changeSet.id, 'reevaluating', now, { adoptedAt: now });

      const command = project.status === 'initializing' ? 'adopt_first' : 'adopt';
      const next = nextProjectState(project.status, command);
      this.db.repos.project.updateStatus(project.id, next, null, now);

      if (baseRelease) {
        this.db.repos.event.append(
          project.id,
          'design.invalidated',
          {
            changeSetId: changeSet.id,
            baseReleaseId: baseRelease.id,
            baseVersion: baseRelease.version,
            rootChange: impact.rootChange,
            affectedNodeCount: impact.affectedNodeIds.size,
            affectedRelationCount: impact.affectedRelationIds.size,
          },
          now,
        );
      }
      this.db.repos.event.append(
        project.id,
        'reevaluation.started',
        {
          changeSetId: changeSet.id,
          reviewItemCount: reviewItemsCreated,
          rootChange: impact.rootChange,
        },
        now,
      );

      const blockers = this.evaluateDirectBlockers(project, changeSet, working);

      const updated = this.require(changeSetId);
      return {
        changeSet: updated,
        impact,
        reviewItemsCreated,
        projectBlocked: blockers.length > 0,
      };
    });
  }

  /** abandon：放弃 ChangeSet；恢复 consistent（写 design.restored）或回到 initializing（§9.4）。 */
  abandon(changeSetId: string): ChangeSet {
    return this.db.transaction(() => {
      const project = this.db.repos.project.requireSingleton();
      const changeSet = this.require(changeSetId);
      assertChangeSetTransition(changeSet.status, 'abandoned');
      const wasAdopted = changeSet.status !== 'open';
      const now = this.clock.now();
      this.db.repos.changeSet.updateStatus(changeSet.id, 'abandoned', now);

      if (wasAdopted) {
        if (changeSet.baseReleaseId) {
          nextProjectState(project.status, 'abandon_with_base');
          this.db.repos.project.updateStatus(project.id, 'consistent', null, now);
          const base = this.db.repos.release.getById(changeSet.baseReleaseId);
          this.db.repos.event.append(
            project.id,
            'design.restored',
            {
              releaseId: changeSet.baseReleaseId,
              version: base?.version ?? null,
              abandonedChangeSetId: changeSet.id,
            },
            now,
          );
        } else {
          nextProjectState(project.status, 'abandon_without_base');
          this.db.repos.project.updateStatus(project.id, 'initializing', null, now);
        }
      }
      return this.require(changeSetId);
    });
  }

  /** 一致性预览：对当前工作版本运行 checker。 */
  check(changeSetId: string): {
    issues: ConsistencyIssue[];
    blockingCount: number;
    warningCount: number;
  } {
    const project = this.db.repos.project.requireSingleton();
    const changeSet = this.require(changeSetId);
    const { working } = this.buildViews(changeSet);
    const counts = this.db.repos.reviewItem.countsByChangeSet(changeSet.id);
    const policies = this.db.repos.delegation.listActiveByProject(project.id);
    const issues = checkConsistency({
      workingSet: working,
      reviewCounts: { pending: counts.pending, blocked: counts.blocked },
      policies,
    });
    return {
      issues,
      blockingCount: issues.filter((i) => i.severity === 'blocking').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
    };
  }

  /** 全部复核完成且 checker 通过后，ChangeSet 进入 ready（project 保持 reevaluating）。 */
  markReady(changeSetId: string): ChangeSet {
    return this.db.transaction(() => {
      const changeSet = this.require(changeSetId);
      if (changeSet.status !== 'reevaluating') {
        throw new DomainError('INVALID_STATE_TRANSITION', '只有 reevaluating 状态可以标记 ready', {
          status: changeSet.status,
        });
      }
      const counts = this.db.repos.reviewItem.countsByChangeSet(changeSet.id);
      if (counts.pending > 0 || counts.blocked > 0) {
        throw new DomainError('DESIGN_INCONSISTENT', '仍存在未完成的复核项', {
          pending: counts.pending,
          blocked: counts.blocked,
        });
      }
      const result = this.check(changeSetId);
      if (result.blockingCount > 0) {
        throw new DomainError('DESIGN_INCONSISTENT', '一致性检查未通过', {
          blocking: result.issues.filter((i) => i.severity === 'blocking'),
        });
      }
      const now = this.clock.now();
      assertChangeSetTransition(changeSet.status, 'ready');
      this.db.repos.changeSet.updateStatus(changeSet.id, 'ready', now);
      return this.require(changeSetId);
    });
  }

  /** 新候选在 reevaluating/ready 阶段产生：回到 reevaluating 并新增影响项（§4.6）。 */
  registerCandidateImpact(changeSetId: string): void {
    const changeSet = this.require(changeSetId);
    if (changeSet.status === 'open') return;
    if (changeSet.status !== 'reevaluating' && changeSet.status !== 'ready') {
      throw new DomainError('INVALID_STATE_TRANSITION', '当前 ChangeSet 状态不接受候选写入', {
        status: changeSet.status,
      });
    }
    const project = this.db.repos.project.requireSingleton();
    const { base, working, nodeHeads, relationHeads } = this.buildViews(changeSet);
    const impact = analyzeImpact(base, working, nodeHeads, relationHeads);
    this.ensureReviewItems(changeSet, impact, working);
    if (changeSet.status === 'ready') {
      assertChangeSetTransition(changeSet.status, 'reevaluating');
      this.db.repos.changeSet.updateStatus(changeSet.id, 'reevaluating', this.clock.now());
    }
    this.evaluateDirectBlockers(project, changeSet, working);
  }

  // ---- ReviewItem 操作 ----

  resolveReviewItem(
    id: string,
    verdict: ReviewVerdict,
    rationale: string,
    author: Author,
  ): ReviewItem {
    return this.db.transaction(() => {
      if (verdict === 'unknown') {
        throw new DomainError('VALIDATION_FAILED', 'unknown 结论请使用 block 操作');
      }
      const item = this.db.repos.reviewItem.getById(id);
      if (!item) throw new DomainError('NOT_FOUND', 'review item 不存在', { id });
      if (item.status === 'resolved') {
        throw new DomainError('INVALID_STATE_TRANSITION', 'review item 已 resolved，不可原地回退');
      }
      const now = this.clock.now();
      this.db.repos.reviewItem.resolve(
        id,
        { verdict, rationale, authorKind: author.kind, authorRef: author.ref, resolvedAt: now },
        now,
      );
      this.afterReviewProgress(item.changeSetId);
      const updated = this.db.repos.reviewItem.getById(id);
      if (!updated) throw new DomainError('CORRUPT_PERSISTED_DATA', 'review item 更新后缺失');
      return updated;
    });
  }

  blockReviewItem(id: string, rationale: string, author: Author): ReviewItem {
    return this.db.transaction(() => {
      const item = this.db.repos.reviewItem.getById(id);
      if (!item) throw new DomainError('NOT_FOUND', 'review item 不存在', { id });
      if (item.status !== 'pending') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          '只有 pending 的 review item 可以 block',
          {
            status: item.status,
          },
        );
      }
      const now = this.clock.now();
      this.db.repos.reviewItem.block(
        id,
        { rationale, authorKind: author.kind, authorRef: author.ref, blockedAt: now },
        now,
      );
      const project = this.db.repos.project.requireSingleton();
      if (project.status === 'reevaluating') {
        nextProjectState(project.status, 'block');
        this.db.repos.project.updateStatus(
          project.id,
          'blocked',
          { reasonCode: 'REVIEW_ITEM_BLOCKED', message: rationale, issues: [] },
          now,
        );
        this.db.repos.event.append(
          project.id,
          'reevaluation.blocked',
          { changeSetId: item.changeSetId, reviewItemId: id, rationale },
          now,
        );
      }
      const updated = this.db.repos.reviewItem.getById(id);
      if (!updated) throw new DomainError('CORRUPT_PERSISTED_DATA', 'review item 更新后缺失');
      return updated;
    });
  }

  /** blocked -> pending：显式 Resume/解除阻塞（§4.6）。 */
  unblockReviewItem(id: string): ReviewItem {
    return this.db.transaction(() => {
      const item = this.db.repos.reviewItem.getById(id);
      if (!item) throw new DomainError('NOT_FOUND', 'review item 不存在', { id });
      if (item.status !== 'blocked') {
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          '只有 blocked 的 review item 可以解除阻塞',
          {
            status: item.status,
          },
        );
      }
      this.db.repos.reviewItem.unblock(id, this.clock.now());
      this.afterReviewProgress(item.changeSetId);
      const updated = this.db.repos.reviewItem.getById(id);
      if (!updated) throw new DomainError('CORRUPT_PERSISTED_DATA', 'review item 更新后缺失');
      return updated;
    });
  }

  /** 复核进展：写 progress 事件；若 project blocked 且直接阻塞已清，则 resume 回 reevaluating。 */
  private afterReviewProgress(changeSetId: string): void {
    const project = this.db.repos.project.requireSingleton();
    const changeSet = this.require(changeSetId);
    const counts = this.db.repos.reviewItem.countsByChangeSet(changeSetId);
    const now = this.clock.now();
    if (project.status === 'blocked' && counts.blocked === 0) {
      const { working } = this.buildViews(changeSet);
      const policies = this.db.repos.delegation.listActiveByProject(project.id);
      const issues = checkConsistency({
        workingSet: working,
        reviewCounts: { pending: 0, blocked: 0 },
        policies,
      });
      const blocking = issues.filter((i) => i.severity === 'blocking');
      if (blocking.length === 0) {
        nextProjectState(project.status, 'resume');
        this.db.repos.project.updateStatus(project.id, 'reevaluating', null, now);
      }
    }
    this.db.repos.event.append(
      project.id,
      'reevaluation.progress',
      { changeSetId, pending: counts.pending, blocked: counts.blocked, resolved: counts.resolved },
      now,
    );
  }

  reviewItems(changeSetId: string): {
    items: ReviewItem[];
    pendingCount: number;
    blockedCount: number;
    resolvedCount: number;
  } {
    const items = this.db.repos.reviewItem.listByChangeSet(changeSetId);
    const counts = this.db.repos.reviewItem.countsByChangeSet(changeSetId);
    return {
      items,
      pendingCount: counts.pending,
      blockedCount: counts.blocked,
      resolvedCount: counts.resolved,
    };
  }
}
