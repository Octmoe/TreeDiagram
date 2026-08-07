import { randomUUID } from 'node:crypto';
import type {
  ApprovalState,
  ChangeSet,
  EpistemicState,
  Node,
  NodeDetail,
  NodeId,
  NodeRevision,
  NodeRevisionId,
  NodeType,
  Relation,
  RelationId,
  RelationRevision,
  RelationRevisionId,
  RelationType,
} from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import {
  ChangeSetService,
  DatabaseContext,
  DelegationService,
  NodeService,
  QueryService,
  RelationService,
  ReleaseService,
  SourceService,
  createManualClock,
  newId,
  userAuthor,
  type ProjectRecord,
  type ServiceContext,
} from '@treediagram/core';
import type { WorkingSet } from '@treediagram/core';

// ---- 内存工作区 ----

export interface TestWorkspace {
  db: DatabaseContext;
  ctx: ServiceContext;
  project: ProjectRecord;
  clock: ReturnType<typeof createManualClock>;
  services: {
    nodes: NodeService;
    relations: RelationService;
    changeSets: ChangeSetService;
    releases: ReleaseService;
    queries: QueryService;
    delegations: DelegationService;
    sources: SourceService;
  };
}

export function makeTestWorkspace(name = 'test-project'): TestWorkspace {
  const clock = createManualClock('2026-01-01T00:00:00.000Z');
  const db = new DatabaseContext(':memory:', clock);
  const project: ProjectRecord = {
    id: newId(),
    name,
    status: 'initializing',
    currentReleaseId: null,
    adminTokenSha256: 'admin-hash',
    consumerTokenSha256: 'consumer-hash',
    blockedReason: null,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  db.repos.project.insert(project);
  const ctx: ServiceContext = { db, clock };
  return {
    db,
    ctx,
    project,
    clock,
    services: {
      nodes: new NodeService(ctx),
      relations: new RelationService(ctx),
      changeSets: new ChangeSetService(ctx),
      releases: new ReleaseService(ctx),
      queries: new QueryService(ctx),
      delegations: new DelegationService(ctx),
      sources: new SourceService(db, clock, 2 * 1024 * 1024),
    },
  };
}

export function freshProject(ws: TestWorkspace): ProjectRecord {
  return ws.db.repos.project.requireSingleton();
}

// ---- 类型默认 attributes ----

export function defaultAttributes(nodeType: NodeType): Record<string, unknown> {
  switch (nodeType) {
    case 'goal':
      return { priorityNote: null };
    case 'constraint':
      return { strength: 'hard' };
    case 'risk':
      return { impactNote: null };
    case 'question':
      return { blocking: false };
    case 'decision':
      return { importance: 'simple', noAlternativeFound: false, alternativeSearchNote: null };
    case 'evidence':
      return {
        evidenceKind: 'external_source',
        sourceAssetId: null,
        method: '',
        premises: [],
        limitations: [],
      };
    case 'validation_method':
      return {
        method: 'm',
        expectedSignal: 's',
        successInterpretation: 'ok',
        failureInterpretation: 'bad',
      };
    default:
      return {};
  }
}

export interface QuickNodeOptions {
  nodeType?: NodeType;
  roles?: string[];
  approvalState?: ApprovalState;
  epistemicState?: EpistemicState | null;
  attributes?: Record<string, unknown>;
  title?: string;
  content?: string;
}

export function quickNode(
  ws: TestWorkspace,
  options: QuickNodeOptions = {},
  parent?: NodeDetail,
): NodeDetail {
  const nodeType = options.nodeType ?? 'claim';
  const detail = ws.services.nodes.createCandidateNode(
    freshProject(ws),
    nodeType,
    {
      displayTitle: options.title ?? `node-${randomUUID().slice(0, 8)}`,
      contentText: options.content ?? 'content',
      roles: options.roles ?? [],
      attributes: options.attributes ?? defaultAttributes(nodeType),
      approvalState: options.approvalState ?? 'user_confirmed',
      epistemicState: options.epistemicState ?? null,
    },
    userAuthor,
  );
  if (parent) {
    ws.services.relations.createCandidateRelation(
      freshProject(ws),
      'contains',
      {
        fromNodeRevisionId: parent.revision.id,
        toNodeRevisionId: detail.revision.id,
        rationaleText: '结构包含',
        attributes: {},
        approvalState: 'user_confirmed',
      },
      userAuthor,
    );
  }
  return detail;
}

// ---- 手工构造 WorkingSet（checker / impact / delegation 纯函数测试） ----

let revisionSeq = 0;

export function makeNode(
  nodeType: NodeType,
  overrides: Partial<{
    roles: string[];
    approvalState: ApprovalState;
    epistemicState: EpistemicState | null;
    attributes: Record<string, unknown>;
    contentText: string;
    authorization: NodeRevision['authorization'];
  }> = {},
): NodeDetail {
  revisionSeq += 1;
  const node: Node = {
    id: asId<NodeId>(randomUUID()),
    projectId: asId(randomUUID()),
    nodeType,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const revision: NodeRevision = {
    id: asId<NodeRevisionId>(randomUUID()),
    nodeId: node.id,
    createdInChangeSetId: asId(randomUUID()),
    revisionNumber: 1,
    displayTitle: `n${revisionSeq}`,
    contentText: overrides.contentText ?? 'content',
    roles: overrides.roles ?? [],
    attributes: (overrides.attributes ?? defaultAttributes(nodeType)) as NodeRevision['attributes'],
    approvalState: overrides.approvalState ?? 'user_confirmed',
    epistemicState: overrides.epistemicState ?? null,
    authorization: overrides.authorization ?? null,
    supersedesRevisionId: null,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  return { node, revision };
}

export function makeRelation(
  relationType: RelationType,
  from: NodeRevision,
  to: NodeRevision,
  attributes: Record<string, unknown> = {},
  approvalState: ApprovalState = 'user_confirmed',
): { relation: Relation; revision: RelationRevision } {
  const relation: Relation = {
    id: asId<RelationId>(randomUUID()),
    projectId: asId(randomUUID()),
    relationType,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const revision: RelationRevision = {
    id: asId<RelationRevisionId>(randomUUID()),
    relationId: relation.id,
    createdInChangeSetId: asId(randomUUID()),
    revisionNumber: 1,
    fromNodeRevisionId: from.id,
    toNodeRevisionId: to.id,
    rationaleText: 'rationale',
    attributes: attributes as RelationRevision['attributes'],
    approvalState,
    authorization: null,
    supersedesRelationRevisionId: null,
    authorKind: 'user',
    authorRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  return { relation, revision };
}

export function wsOf(
  details: NodeDetail[],
  relations: Array<{ relation: Relation; revision: RelationRevision }>,
): WorkingSet {
  return {
    baseReleaseId: null,
    nodeById: new Map(details.map((d) => [d.node.id, d.node])),
    relationById: new Map(relations.map((r) => [r.relation.id, r.relation])),
    nodeRevisionByNodeId: new Map(details.map((d) => [d.node.id, d.revision])),
    relationRevisionByRelationId: new Map(relations.map((r) => [r.relation.id, r.revision])),
    removedNodeIds: new Set(),
    removedRelationIds: new Set(),
  };
}

export function issueCodes(issues: Array<{ code: string }>): Set<string> {
  return new Set(issues.map((i) => i.code));
}

export function fakeChangeSet(projectId: string, status: ChangeSet['status'] = 'open'): ChangeSet {
  return {
    id: asId(randomUUID()),
    projectId: asId(projectId),
    baseReleaseId: null,
    status,
    title: '',
    description: '',
    adoptedAt: null,
    publishedReleaseId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
