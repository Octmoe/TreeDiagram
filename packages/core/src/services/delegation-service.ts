import type { DelegationMode, DelegationPolicy, DelegationResolution } from '@treediagram/contracts';
import type { DelegationPolicyId, NodeId } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from './types.js';
import { ChangeSetService } from './change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { resolveDelegation } from '../domain/delegation-resolver.js';

/**
 * 分支级 AI 托管（IMPLEMENTATION_DESIGN §10、V1_SPEC §8）。
 * 设置/撤销策略是“不可托管操作”，只能由用户执行。
 */
export class DelegationService {
  private readonly changeSets: ChangeSetService;

  constructor(private readonly ctx: ServiceContext) {
    this.changeSets = new ChangeSetService(ctx);
  }

  private get db() {
    return this.ctx.db;
  }
  private get clock() {
    return this.ctx.clock;
  }

  private assertUser(author: Author): void {
    if (author.kind !== 'user') {
      throw new DomainError('AI_SCOPE_VIOLATION', '修改托管策略必须由用户执行');
    }
  }

  private requireNode(project: ProjectRecord, nodeId: string): NodeId {
    const node = this.db.repos.node.getNodeById(nodeId);
    if (!node || node.projectId !== project.id) {
      throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
    }
    return node.id;
  }

  /** 设置显式策略：撤销同 scope 现有活动策略后插入新策略（同一事务）。 */
  setPolicy(project: ProjectRecord, nodeId: string, mode: DelegationMode, author: Author): DelegationPolicy {
    return this.db.transaction(() => {
      this.assertUser(author);
      const scopeNodeId = this.requireNode(project, nodeId);
      const now = this.clock.now();
      const existing = this.db.repos.delegation.getActiveByScope(project.id, scopeNodeId);
      if (existing) {
        this.db.repos.delegation.revoke(existing.id, now);
      }
      const policy: DelegationPolicy = {
        id: newId<DelegationPolicyId>(),
        projectId: project.id,
        scopeNodeId,
        mode,
        authorKind: 'user',
        authorRef: author.ref,
        createdAt: now,
        revokedAt: null,
      };
      this.db.repos.delegation.insert(policy);
      return policy;
    });
  }

  /** 撤销策略：只撤销，不删除历史记录；撤销不否定历史 AI 决策。 */
  revokePolicy(project: ProjectRecord, nodeId: string, author: Author): void {
    this.db.transaction(() => {
      this.assertUser(author);
      const scopeNodeId = this.requireNode(project, nodeId);
      const existing = this.db.repos.delegation.getActiveByScope(project.id, scopeNodeId);
      if (!existing) {
        throw new DomainError('NOT_FOUND', '该节点没有活动托管策略', { nodeId });
      }
      this.db.repos.delegation.revoke(existing.id, this.clock.now());
    });
  }

  /** 节点视角的托管解析（继承链 + 显式策略 + warnings）。 */
  getResolution(project: ProjectRecord, nodeId: string): DelegationResolution {
    const scopeNodeId = this.requireNode(project, nodeId);
    const live = this.changeSets.getLive(project);
    const ws = live
      ? this.changeSets.buildViews(live).working
      : this.changeSets.buildReleaseView(project);
    const activePolicies = this.db.repos.delegation.listActiveByProject(project.id);
    const result = resolveDelegation(scopeNodeId, ws, activePolicies);
    return {
      nodeId: scopeNodeId,
      mode: result.mode,
      policyId: result.policyId as DelegationResolution['policyId'],
      inheritedFromNodeId: result.inheritedFromNodeId,
      explicitPolicy: result.explicitPolicy,
      warnings: result.warnings,
    };
  }
}
