import { basename, resolve } from 'node:path';
import { initializeWorkspace } from './workspace.js';
import { V2Store } from './store.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function seed(workspaceDir: string): Promise<void> {
  const store = new V2Store(workspaceDir);
  const host = 'seed-demo';
  try {
    let changeSet = store.beginChangeSet(
      host,
      '建立 TreeDiagram V2 演示设计',
      '展示焦点、候选、授权与发布闭环',
    ).changeSet;
    const rootProposal = store.proposeChange({
      hostSessionRef: host,
      changeSetId: changeSet.id,
      expectedChangeSetVersion: changeSet.version,
      operation: 'create_node',
      payload: {
        nodeType: 'goal',
        displayTitle: '让复杂设计在 Agent 协作中保持可见与可控',
        contentText: '聊天承载讨论，设计树承载长期共识；每一次高影响变更都保持可审查。',
        roles: ['root'],
        attributes: { priorityNote: 'V2 演示根目标' },
        approvalState: 'tentative',
        epistemicState: null,
        reviewState: 'clean',
      },
      summary: '创建 V2 演示根目标',
    });
    changeSet = rootProposal.changeSet;
    const rootGrant = store.issueApprovalGrant('adopt', rootProposal.change.id, host);
    changeSet = store.adoptChange(host, rootProposal.change.id, rootGrant.token).changeSet;
    const confirmGrant = store.issueApprovalGrant(
      'confirm_root',
      rootProposal.change.entityId,
      host,
    );
    changeSet = store.confirmRoot(host, rootProposal.change.entityId, confirmGrant.token).changeSet;

    const constraintProposal = store.proposeChange({
      hostSessionRef: host,
      changeSetId: changeSet.id,
      expectedChangeSetVersion: changeSet.version,
      operation: 'create_node',
      payload: {
        nodeType: 'constraint',
        displayTitle: '节点选择不自动触发模型或修改设计',
        contentText: '选择只更新 Attention Context；自然语言发言或明确动作才进入 Agent 工具循环。',
        roles: ['principle'],
        attributes: { strength: 'hard' },
        approvalState: 'tentative',
        epistemicState: 'supported',
        reviewState: 'clean',
      },
      summary: '增加注意力与设计事实分离约束',
    });
    changeSet = constraintProposal.changeSet;
    const constraintContains = store.proposeChange({
      hostSessionRef: host,
      changeSetId: changeSet.id,
      expectedChangeSetVersion: changeSet.version,
      operation: 'create_relation',
      payload: {
        relationType: 'contains',
        sourceNodeId: rootProposal.change.entityId,
        targetNodeId: constraintProposal.change.entityId,
        rationale: '核心目标包含该交互约束',
        reviewState: 'clean',
      },
      summary: '挂载注意力约束',
    });
    changeSet = constraintContains.changeSet;
    const constraintGrant = store.issueApprovalGrant('adopt', constraintProposal.change.id, host);
    changeSet = store.adoptChange(
      host,
      constraintProposal.change.id,
      constraintGrant.token,
    ).changeSet;

    const evidenceProposal = store.proposeChange({
      hostSessionRef: host,
      changeSetId: changeSet.id,
      expectedChangeSetVersion: changeSet.version,
      operation: 'create_node',
      payload: {
        nodeType: 'evidence',
        displayTitle: 'Attention 与 Working State 使用独立事务表',
        contentText: '代码与契约确保 selection 更新不会触碰设计修订或 ChangeSet。',
        roles: ['finding'],
        attributes: { evidenceKind: 'agent_argument' },
        approvalState: 'tentative',
        epistemicState: null,
        reviewState: 'clean',
      },
      summary: '增加支持原则的实现证据',
    });
    changeSet = evidenceProposal.changeSet;
    const evidenceContains = store.proposeChange({
      hostSessionRef: host,
      changeSetId: changeSet.id,
      expectedChangeSetVersion: changeSet.version,
      operation: 'create_relation',
      payload: {
        relationType: 'contains',
        sourceNodeId: rootProposal.change.entityId,
        targetNodeId: evidenceProposal.change.entityId,
        rationale: '证据属于目标设计空间',
        reviewState: 'clean',
      },
      summary: '挂载实现证据',
    });
    changeSet = evidenceContains.changeSet;
    const evidenceGrant = store.issueApprovalGrant('adopt', evidenceProposal.change.id, host);
    changeSet = store.adoptChange(host, evidenceProposal.change.id, evidenceGrant.token).changeSet;

    for (const relation of [
      {
        relationType: 'supports',
        sourceNodeId: evidenceProposal.change.entityId,
        targetNodeId: constraintProposal.change.entityId,
        rationale: '实现隔离支持该约束',
      },
    ] as const) {
      const proposal = store.proposeChange({
        hostSessionRef: host,
        changeSetId: changeSet.id,
        expectedChangeSetVersion: changeSet.version,
        operation: 'create_relation',
        payload: { ...relation, reviewState: 'clean' },
        summary: `建立 ${relation.relationType} 关系`,
      });
      changeSet = proposal.changeSet;
      const grant = store.issueApprovalGrant('adopt', proposal.change.id, host);
      changeSet = store.adoptChange(host, proposal.change.id, grant.token).changeSet;
    }

    const checked = store.validateChangeSet(host, changeSet.id, changeSet.version);
    if (!checked.validation.valid)
      throw new Error(`演示设计未通过校验: ${JSON.stringify(checked.validation.issues)}`);
    const publishGrant = store.issueApprovalGrant('publish', checked.changeSet.id, host);
    store.publishRelease(host, checked.changeSet.id, publishGrant.token, 'TreeDiagram V2 演示基线');
  } finally {
    store.close();
  }
}

const command = process.argv[2] === 'seed' ? 'seed' : 'init';
const workspaceDir = resolve(
  option('workspace') ?? process.env['TREEDIAGRAM_WORKSPACE'] ?? process.cwd(),
);
const name = option('name') ?? (basename(workspaceDir) || 'TreeDiagram V2');
const meta = initializeWorkspace(workspaceDir, name);
if (command === 'seed') await seed(workspaceDir);
console.log(`TreeDiagram V2 workspace: ${workspaceDir}`);
console.log(`workspaceId: ${meta.workspaceId}`);
console.log(command === 'seed' ? '演示设计已创建并发布。' : '初始化完成。');
