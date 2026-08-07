import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChangeSetService,
  NodeService,
  RelationService,
  ReleaseService,
  SourceService,
  userAuthor,
  type DatabaseContext,
  type Clock,
  type ServiceContext,
} from '@treediagram/core';
import type { ProjectRecord } from '@treediagram/core';
import type {
  ApprovalState,
  EpistemicState,
  NodeType,
  RelationType,
  SourceKind,
} from '@treediagram/contracts';

export interface SeedNode {
  key: string;
  nodeType: NodeType;
  displayTitle: string;
  contentText: string;
  roles: string[];
  attributes: Record<string, unknown>;
  approvalState: ApprovalState;
  epistemicState: EpistemicState | null;
  parent: string | null;
}

export interface SeedRelation {
  from: string;
  to: string;
  relationType: RelationType;
  rationaleText: string;
  attributes: Record<string, unknown>;
  approvalState: ApprovalState;
}

export interface SeedDesign {
  projectName: string;
  sourceTextFixture: string;
  sourceKind: SourceKind;
  sourceOriginalName: string;
  nodes: SeedNode[];
  relations: SeedRelation[];
}

export interface SeedResult {
  sourceId: string;
  nodeIdsByKey: Map<string, string>;
  releaseId: string;
  releaseVersion: number;
}

export function loadSeed(fixtureDir: string): { seed: SeedDesign; sourceText: string } {
  const seed = JSON.parse(
    readFileSync(join(fixtureDir, 'seeded-design.json'), 'utf8'),
  ) as SeedDesign;
  const sourceText = readFileSync(join(fixtureDir, seed.sourceTextFixture), 'utf8');
  return { seed, sourceText };
}

/**
 * 应用 seeded fixture：source → 候选节点/关系 → adopt → 全部复核 valid → ready → 发布 Release 1。
 * 与 tests/fixtures/seeded-design.json 配套，用于演示与集成测试。
 */
export function applySeed(
  ctx: ServiceContext & { db: DatabaseContext; clock: Clock; maxSourceBytes: number },
  project: ProjectRecord,
  seed: SeedDesign,
  sourceText: string,
): SeedResult {
  const sources = new SourceService(ctx.db, ctx.clock, ctx.maxSourceBytes);
  const nodes = new NodeService(ctx);
  const relations = new RelationService(ctx);
  const changeSets = new ChangeSetService(ctx);
  const releases = new ReleaseService(ctx);

  const source = sources.addSource(
    project.id,
    {
      kind: seed.sourceKind,
      originalName: seed.sourceOriginalName,
      mediaType: 'text/markdown',
      contentText: sourceText,
    },
    userAuthor,
  );

  const revisionByKey = new Map<string, string>();
  const nodeIdsByKey = new Map<string, string>();
  for (const seedNode of seed.nodes) {
    const detail = nodes.createCandidateNode(
      project,
      seedNode.nodeType,
      {
        displayTitle: seedNode.displayTitle,
        contentText: seedNode.contentText,
        roles: seedNode.roles,
        attributes: seedNode.attributes,
        approvalState: seedNode.approvalState,
        epistemicState: seedNode.epistemicState,
      },
      userAuthor,
    );
    revisionByKey.set(seedNode.key, detail.revision.id);
    nodeIdsByKey.set(seedNode.key, detail.node.id);
  }

  // contains 结构边
  for (const seedNode of seed.nodes) {
    if (!seedNode.parent) continue;
    const fromRevisionId = revisionByKey.get(seedNode.parent);
    const toRevisionId = revisionByKey.get(seedNode.key);
    if (!fromRevisionId || !toRevisionId) {
      throw new Error(`seed 父引用缺失: ${seedNode.key} -> ${seedNode.parent}`);
    }
    relations.createCandidateRelation(
      project,
      'contains',
      {
        fromNodeRevisionId: fromRevisionId,
        toNodeRevisionId: toRevisionId,
        rationaleText: `${seedNode.parent} 结构包含 ${seedNode.key}`,
        attributes: {},
        approvalState: 'user_confirmed',
      },
      userAuthor,
    );
  }

  for (const seedRelation of seed.relations) {
    const fromRevisionId = revisionByKey.get(seedRelation.from);
    const toRevisionId = revisionByKey.get(seedRelation.to);
    if (!fromRevisionId || !toRevisionId) {
      throw new Error(`seed 关系端点缺失: ${seedRelation.from} -> ${seedRelation.to}`);
    }
    relations.createCandidateRelation(
      project,
      seedRelation.relationType,
      {
        fromNodeRevisionId: fromRevisionId,
        toNodeRevisionId: toRevisionId,
        rationaleText: seedRelation.rationaleText,
        attributes: seedRelation.attributes,
        approvalState: seedRelation.approvalState,
      },
      userAuthor,
    );
  }

  const changeSet = changeSets.getLive(project);
  if (!changeSet) throw new Error('seed 后缺少 live ChangeSet');
  changeSets.adopt(changeSet.id, userAuthor);

  const { items } = changeSets.reviewItems(changeSet.id);
  for (const item of items) {
    if (item.status === 'pending') {
      changeSets.resolveReviewItem(item.id, 'valid', 'seed 初始内容在首个 Release 中确认有效', userAuthor);
    }
  }

  changeSets.markReady(changeSet.id);
  const release = releases.publish(
    ctx.db.repos.project.requireSingleton(),
    changeSet.id,
    'Release 1：seeded 初始设计基线',
    userAuthor,
  );

  return {
    sourceId: source.id,
    nodeIdsByKey,
    releaseId: release.id,
    releaseVersion: release.version,
  };
}
