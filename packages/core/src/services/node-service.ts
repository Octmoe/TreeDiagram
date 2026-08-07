import type {
  ApprovalState,
  Authorization,
  EpistemicState,
  Node,
  NodeDetail,
  NodeRevision,
  NodeType,
} from '@treediagram/contracts';
import { checkNodeAttributes, type NodeId, type NodeRevisionId } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from './types.js';
import { ChangeSetService } from './change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { assertRevisionWriteAllowed, assertTypeAttributeRules } from '../domain/state-rules.js';
import type { ViewMode } from '@treediagram/contracts';

export interface NodeWriteFields {
  displayTitle: string;
  contentText: string;
  roles: string[];
  attributes: unknown;
  approvalState: ApprovalState;
  epistemicState: EpistemicState | null;
}

export interface NodeWriteOptions {
  authorization?: Authorization | null;
}

export class NodeService {
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

  private assertFields(nodeType: NodeType, fields: NodeWriteFields, author: Author, opts: NodeWriteOptions): void {
    if (!checkNodeAttributes(nodeType, fields.attributes)) {
      throw new DomainError('VALIDATION_FAILED', 'attributes 不符合节点类型 schema', { nodeType });
    }
    assertTypeAttributeRules(nodeType, fields.attributes, fields.contentText);
    assertRevisionWriteAllowed({
      nodeType,
      roles: fields.roles,
      approvalState: fields.approvalState,
      epistemicState: fields.epistemicState,
      authorization: opts.authorization ?? null,
      authorKind: author.kind,
      attributes: fields.attributes,
    });
  }

  /** 创建候选节点：写入当前唯一 live ChangeSet（不存在则自动创建 open）。 */
  createCandidateNode(
    project: ProjectRecord,
    nodeType: NodeType,
    fields: NodeWriteFields,
    author: Author,
    opts: NodeWriteOptions = {},
  ): NodeDetail {
    return this.db.transaction(() => {
      this.assertFields(nodeType, fields, author, opts);
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const now = this.clock.now();
      const node: Node = {
        id: newId<NodeId>(),
        projectId: project.id,
        nodeType,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: now,
      };
      const revision: NodeRevision = {
        id: newId<NodeRevisionId>(),
        nodeId: node.id,
        createdInChangeSetId: changeSet.id,
        revisionNumber: 1,
        displayTitle: fields.displayTitle,
        contentText: fields.contentText,
        roles: [...fields.roles],
        attributes: fields.attributes as NodeRevision['attributes'],
        approvalState: fields.approvalState,
        epistemicState: fields.epistemicState,
        authorization: opts.authorization ?? null,
        supersedesRevisionId: null,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: now,
      };
      this.db.repos.node.insertNode(node);
      this.db.repos.node.insertRevision(revision);
      this.db.repos.changeSet.upsertNodeHead(changeSet.id, {
        nodeId: node.id,
        nodeRevisionId: revision.id,
        action: 'upsert',
      });
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
      return { node, revision };
    });
  }

  /**
   * 修订候选节点：INSERT 新 revision 并更新 head；已确认修订永不被 UPDATE。
   * nodeType 属于逻辑节点身份，不得改变（§7.2）。
   */
  reviseCandidateNode(
    project: ProjectRecord,
    nodeId: string,
    baseRevisionId: string,
    fields: NodeWriteFields,
    author: Author,
    opts: NodeWriteOptions = {},
  ): NodeDetail {
    return this.db.transaction(() => {
      const node = this.db.repos.node.getNodeById(nodeId);
      if (!node || node.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
      }
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { working } = this.changeSets.buildViews(changeSet);
      const current = working.nodeRevisionByNodeId.get(node.id as NodeId);
      if (!current) {
        throw new DomainError('NOT_FOUND', '节点不在当前工作版本中（可能已被移除）', { nodeId });
      }
      if (current.id !== baseRevisionId) {
        throw new DomainError('STALE_BASE_REVISION', 'base revision 与当前工作修订不一致', {
          nodeId,
          baseRevisionId,
          currentRevisionId: current.id,
        });
      }
      this.assertFields(node.nodeType, fields, author, opts);
      const revision: NodeRevision = {
        id: newId<NodeRevisionId>(),
        nodeId: node.id,
        createdInChangeSetId: changeSet.id,
        revisionNumber: this.db.repos.node.maxRevisionNumber(node.id) + 1,
        displayTitle: fields.displayTitle,
        contentText: fields.contentText,
        roles: [...fields.roles],
        attributes: fields.attributes as NodeRevision['attributes'],
        approvalState: fields.approvalState,
        epistemicState: fields.epistemicState,
        authorization: opts.authorization ?? null,
        supersedesRevisionId: current.id,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: this.clock.now(),
      };
      this.db.repos.node.insertRevision(revision);
      this.db.repos.changeSet.upsertNodeHead(changeSet.id, {
        nodeId: node.id,
        nodeRevisionId: revision.id,
        action: 'upsert',
      });
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
      return { node, revision };
    });
  }

  /** 移除候选节点（归档语义）：head 标记 remove；候选期新建的节点直接清除 head。 */
  removeCandidateNode(project: ProjectRecord, nodeId: string, author: Author): void {
    this.db.transaction(() => {
      const node = this.db.repos.node.getNodeById(nodeId);
      if (!node || node.projectId !== project.id) {
        throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
      }
      const changeSet = this.changeSets.getOrCreateOpen(project, author);
      const { base } = this.changeSets.buildViews(changeSet);
      if (base.nodeRevisionByNodeId.has(node.id as NodeId)) {
        this.db.repos.changeSet.upsertNodeHead(changeSet.id, {
          nodeId: node.id,
          nodeRevisionId: null,
          action: 'remove',
        });
      } else {
        this.db.repos.changeSet.deleteNodeHead(changeSet.id, node.id);
      }
      if (changeSet.status !== 'open') {
        this.changeSets.registerCandidateImpact(changeSet.id);
      }
    });
  }

  /** 按视图读取节点当前修订。 */
  getNode(project: ProjectRecord, nodeId: string, view: ViewMode): NodeDetail {
    const node = this.db.repos.node.getNodeById(nodeId);
    if (!node || node.projectId !== project.id) {
      throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
    }
    const ws = this.resolveView(project, view);
    const revision = ws.nodeRevisionByNodeId.get(node.id as NodeId);
    if (!revision) {
      throw new DomainError('NOT_FOUND', `节点在 ${view} 视图中不可见`, { nodeId, view });
    }
    return { node, revision };
  }

  getNodeHistory(project: ProjectRecord, nodeId: string): { node: Node; revisions: NodeRevision[] } {
    const node = this.db.repos.node.getNodeById(nodeId);
    if (!node || node.projectId !== project.id) {
      throw new DomainError('NOT_FOUND', '节点不存在', { nodeId });
    }
    return { node, revisions: this.db.repos.node.listRevisionsByNode(node.id) };
  }

  resolveView(project: ProjectRecord, view: ViewMode) {
    if (view === 'working') {
      const live = this.changeSets.getLive(project);
      if (live) return this.changeSets.buildViews(live).working;
    }
    return this.changeSets.buildReleaseView(project);
  }
}
