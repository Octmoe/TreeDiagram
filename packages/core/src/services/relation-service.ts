import type {
  ApprovalState,
  Authorization,
  Relation,
  RelationDetail,
  RelationRevision,
  RelationType,
  ViewMode,
} from '@treediagram/contracts';
import {
  checkRelationAttributes,
  type NodeId,
  type RelationId,
  type RelationRevisionId,
} from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from './types.js';
import { ChangeSetService } from './change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { validateRelationEndpointTypes } from '../domain/relation-rules.js';
import { endpointNodeId, type WorkingSet } from '../domain/working-set.js';

export interface RelationWriteFields {
  fromNodeRevisionId: string;
  toNodeRevisionId: string;
  rationaleText: string;
  attributes: unknown;
  approvalState: ApprovalState;
}

export interface RelationWriteOptions {
  authorization?: Authorization | null;
}

export class RelationService {
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

  private assertGovernance(fields: RelationWriteFields, author: Author, opts: RelationWriteOptions): void {
    if (fields.approvalState === 'ai_confirmed') {
      if (!opts.authorization) {
        throw new DomainError('AI_SCOPE_VIOLATION', 'ai_confirmed 关系必须携带托管授权');
      }
      if (author.kind !== 'agent') {
        throw new DomainError('AI_SCOPE_VIOLATION', 'ai_confirmed 只能由 agent 主体写入');
      }
    } else if (opts.authorization) {
      throw new DomainError('VALIDATION_FAILED', '非 ai_confirmed 状态不得携带 authorization');
    }
    if (author.kind === 'agent' && fields.approvalState === 'user_confirmed') {
      throw new DomainError('AI_SCOPE_VIOLATION', 'Agent 永远不能创建 user_confirmed');
    }
  }

  /** 写入前端点与结构检查（§7.3）。 */
  private assertEndpoints(
    ws: WorkingSet,
    relationType: RelationType,
    fields: RelationWriteFields,
    excludeRelationId?: string,
  ): void {
    const fromNodeId = endpointNodeId(ws, fields.fromNodeRevisionId);
    const toNodeId = endpointNodeId(ws, fields.toNodeRevisionId);
    if (!fromNodeId || !toNodeId) {
      throw new DomainError('RELATION_ENDPOINT_INVALID', '关系端点必须是当前工作版本中的活动修订', {
        fromNodeRevisionId: fields.fromNodeRevisionId,
        toNodeRevisionId: fields.toNodeRevisionId,
      });
    }
    if (fields.fromNodeRevisionId === fields.toNodeRevisionId || fromNodeId === toNodeId) {
      if (relationType === 'contains') {
        throw new DomainError('RELATION_ENDPOINT_INVALID', 'contains 不允许自环');
      }
    }
    const fromType = ws.nodeById.get(fromNodeId)?.nodeType;
    const toType = ws.nodeById.get(toNodeId)?.nodeType;
    if (!fromType || !toType) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', '端点节点类型缺失');
    }
    const typeError = validateRelationEndpointTypes(relationType, fromType, toType);
    if (typeError) {
      throw new DomainError('RELATION_ENDPOINT_INVALID', typeError, { relationType, fromType, toType });
    }
    if (relationType === 'contradicts') {
      // contradicts 视为对称：反向重复不允许（§7.3）。
      for (const [relationId, revision] of ws.relationRevisionByRelationId) {
        if (relationId === excludeRelationId) continue;
        if (ws.relationById.get(relationId)?.relationType !== 'contradicts') continue;
        const a = endpointNodeId(ws, revision.fromNodeRevisionId);
        const b = endpointNodeId(ws, revision.toNodeRevisionId);
        if (!a || !b) continue;
        const samePair = (a === fromNodeId && b === toNodeId) || (a === toNodeId && b === fromNodeId);
        if (samePair) {
          throw new DomainError('VALIDATION_FAILED', '同一对节点之间已存在 contradicts 关系', {
            existingRelationId: relationId,
          });
        }
      }
    }
  }

  createCandidateRelation(
    project: ProjectRecord,
    relationType: RelationType,
    fields: RelationWriteFields,
    author: Author,
    opts: RelationWriteOptions = {},
  ): RelationDetail {
    return this.db.transaction(() => {
      if (!checkRelationAttributes(relationType, fields.attributes)) {
        throw new DomainError('VALIDATION_FAILED', '关系 attributes 不符合 schema', { relationType });
      }
      this.assertGovernance(fields, author, opts);
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { working } = this.changeSets.buildViews(changeSet);
      this.assertEndpoints(working, relationType, fields);

      const now = this.clock.now();
      const relation: Relation = {
        id: newId<RelationId>(),
        projectId: project.id,
        relationType,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: now,
      };
      const revision: RelationRevision = {
        id: newId<RelationRevisionId>(),
        relationId: relation.id,
        createdInChangeSetId: changeSet.id,
        revisionNumber: 1,
        fromNodeRevisionId: fields.fromNodeRevisionId as RelationRevision['fromNodeRevisionId'],
        toNodeRevisionId: fields.toNodeRevisionId as RelationRevision['toNodeRevisionId'],
        rationaleText: fields.rationaleText,
        attributes: fields.attributes as RelationRevision['attributes'],
        approvalState: fields.approvalState,
        authorization: opts.authorization ?? null,
        supersedesRelationRevisionId: null,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: now,
      };
      this.db.repos.relation.insertRelation(relation);
      this.db.repos.relation.insertRevision(revision);
      this.db.repos.changeSet.upsertRelationHead(changeSet.id, {
        relationId: relation.id,
        relationRevisionId: revision.id,
        action: 'upsert',
      });
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
      return { relation, revision };
    });
  }

  /** relation_type 属于逻辑关系身份，修订时保持不变（§7.3）。 */
  reviseCandidateRelation(
    project: ProjectRecord,
    relationId: string,
    baseRelationRevisionId: string,
    fields: RelationWriteFields,
    author: Author,
    opts: RelationWriteOptions = {},
  ): RelationDetail {
    return this.db.transaction(() => {
      const relation = this.db.repos.relation.getRelationById(relationId);
      if (!relation || relation.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', '关系不存在', { relationId });
      }
      if (!checkRelationAttributes(relation.relationType, fields.attributes)) {
        throw new DomainError('VALIDATION_FAILED', '关系 attributes 不符合 schema', {
          relationType: relation.relationType,
        });
      }
      this.assertGovernance(fields, author, opts);
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { working } = this.changeSets.buildViews(changeSet);
      const current = working.relationRevisionByRelationId.get(relation.id as RelationId);
      if (!current) {
        throw new DomainError('NOT_FOUND', '关系不在当前工作版本中', { relationId });
      }
      if (current.id !== baseRelationRevisionId) {
        throw new DomainError('STALE_BASE_REVISION', 'base relation revision 与当前工作修订不一致', {
          relationId,
          baseRelationRevisionId,
          currentRevisionId: current.id,
        });
      }
      this.assertEndpoints(working, relation.relationType, fields, relation.id);

      const revision: RelationRevision = {
        id: newId<RelationRevisionId>(),
        relationId: relation.id,
        createdInChangeSetId: changeSet.id,
        revisionNumber: this.db.repos.relation.maxRevisionNumber(relation.id) + 1,
        fromNodeRevisionId: fields.fromNodeRevisionId as RelationRevision['fromNodeRevisionId'],
        toNodeRevisionId: fields.toNodeRevisionId as RelationRevision['toNodeRevisionId'],
        rationaleText: fields.rationaleText,
        attributes: fields.attributes as RelationRevision['attributes'],
        approvalState: fields.approvalState,
        authorization: opts.authorization ?? null,
        supersedesRelationRevisionId: current.id,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: this.clock.now(),
      };
      this.db.repos.relation.insertRevision(revision);
      this.db.repos.changeSet.upsertRelationHead(changeSet.id, {
        relationId: relation.id,
        relationRevisionId: revision.id,
        action: 'upsert',
      });
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
      return { relation, revision };
    });
  }

  removeCandidateRelation(project: ProjectRecord, relationId: string, author: Author): void {
    this.db.transaction(() => {
      const relation = this.db.repos.relation.getRelationById(relationId);
      if (!relation || relation.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', '关系不存在', { relationId });
      }
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { base } = this.changeSets.buildViews(changeSet);
      if (base.relationRevisionByRelationId.has(relation.id as RelationId)) {
        this.db.repos.changeSet.upsertRelationHead(changeSet.id, {
          relationId: relation.id,
          relationRevisionId: null,
          action: 'remove',
        });
      } else {
        this.db.repos.changeSet.deleteRelationHead(changeSet.id, relation.id);
      }
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
    });
  }

  /** 一跳关系查询：端点为节点当前视图修订的入边/出边。 */
  getRelations(
    project: ProjectRecord,
    nodeId: string,
    direction: 'in' | 'out' | 'both',
    view: ViewMode,
  ): { incoming: RelationDetail[]; outgoing: RelationDetail[] } {
    const node = this.db.repos.node.getNodeById(nodeId);
    if (!node || node.projectId !== project.id) {
      throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
    }
    const ws =
      view === 'working'
        ? (() => {
            const live = this.changeSets.getLive(project);
            return live
              ? this.changeSets.buildViews(live).working
              : this.changeSets.buildReleaseView(project);
          })()
        : this.changeSets.buildReleaseView(project);
    const activeRevision = ws.nodeRevisionByNodeId.get(node.id as NodeId);
    if (!activeRevision) {
      throw new DomainError('NOT_FOUND', `节点在 ${view} 视图中不可见`, { nodeId, view });
    }
    const incoming: RelationDetail[] = [];
    const outgoing: RelationDetail[] = [];
    for (const [relationId, revision] of ws.relationRevisionByRelationId) {
      const relation = ws.relationById.get(relationId);
      if (!relation) continue;
      if (direction !== 'out' && revision.toNodeRevisionId === activeRevision.id) {
        incoming.push({ relation, revision });
      }
      if (direction !== 'in' && revision.fromNodeRevisionId === activeRevision.id) {
        outgoing.push({ relation, revision });
      }
    }
    return { incoming, outgoing };
  }
}
