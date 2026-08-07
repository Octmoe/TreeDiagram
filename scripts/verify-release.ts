// 用法: node scripts/verify-release.ts --workspace <dir>
// 通过脚本读取树、关系、历史和事件（M1 交付目标）。
import {
  QueryService,
  RelationService,
  ReleaseService,
  WorkspaceService,
  systemClock,
} from '@treediagram/core';
import type { NodeId } from '@treediagram/contracts';

const workspaceArg = process.argv[process.argv.indexOf('--workspace') + 1];
if (!workspaceArg) {
  console.error('用法: node scripts/verify-release.ts --workspace <dir>');
  process.exit(1);
}

const workspace = new WorkspaceService(systemClock).openWorkspace(workspaceArg);
try {
  const ctx = { db: workspace.db, clock: systemClock };
  const queries = new QueryService(ctx);
  const relations = new RelationService(ctx);
  const releases = new ReleaseService(ctx);
  const project = workspace.db.repos.project.requireSingleton();

  console.log(`project: ${project.name} [${project.status}]`);
  const release = releases.getCurrentRelease(project);
  console.log(`current Release: v${release.version} (${release.id})`);
  console.log(
    `  roots: ${release.rootRevisionIds.length}, nodes: ${release.nodeRevisionIds.length}, relations: ${release.relationRevisionIds.length}`,
  );

  const tree = queries.getTree(project, 'release', null, 10);
  console.log('\n树（release 视图）:');
  for (const { node, revision } of tree.nodes) {
    console.log(
      `  [${node.nodeType}] ${revision.displayTitle} <${revision.approvalState}${revision.epistemicState ? '/' + revision.epistemicState : ''}>`,
    );
  }

  const firstNode = tree.nodes[0];
  if (firstNode) {
    const rel = relations.getRelations(project, firstNode.node.id, 'both', 'release');
    console.log(
      `\n节点关系（${firstNode.revision.displayTitle}）: in=${rel.incoming.length} out=${rel.outgoing.length}`,
    );
    for (const { relation } of [...rel.incoming, ...rel.outgoing]) {
      console.log(`  ${relation.relationType} (${relation.id})`);
    }
  }

  const rootNodeRevision = release.rootRevisionIds[0];
  if (rootNodeRevision) {
    const rootRevision = workspace.db.repos.node.getRevisionById(rootNodeRevision);
    if (rootRevision) {
      const history = workspace.db.repos.node.listRevisionsByNode(rootRevision.nodeId as NodeId);
      console.log(`\nroot 历史（${rootRevision.displayTitle}）: ${history.length} 个修订`);
    }
  }

  const { events } = queries.getEvents(project, 0, 1000);
  console.log('\n事件流:');
  for (const event of events) {
    console.log(`  #${event.cursor} ${event.eventType} @ ${event.createdAt}`);
  }
} finally {
  workspace.db.close();
}
