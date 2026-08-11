import { expect, test } from '@playwright/test';

test('Sidecar completes focus, recovery, proposal, approval and validation flows', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/?host=codex&session=e2e-main');
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();
  await expect(page.getByText('Workflow', { exact: true })).toHaveCount(0);

  const rootTitle = '让复杂设计在 Agent 协作中保持可见与可控';
  const constraintTitle = '节点选择不自动触发模型或修改设计';
  await page.locator('.tree-title', { hasText: rootTitle }).click();
  await expect(page.locator('.focus-main strong')).toHaveText(rootTitle);
  await expect(page.locator('.focus-main')).toContainText('AGENT 可见');
  await expect(page.locator('.focus-main')).toContainText(
    '节点焦点 · Agent 可通过 attention_get 读取',
  );
  const deriveAction = page.getByRole('button', { name: /Derive 推导/ });
  const grillAction = page.getByRole('button', { name: /Grill 追问/ });
  const checkAction = page.getByRole('button', { name: /Check 审查/ });
  const reevaluateAction = page.getByRole('button', { name: /Reevaluate 影响/ });
  await expect(deriveAction).toHaveAttribute('title', '沿当前焦点继续形成小而可审阅的候选');
  await expect(grillAction).toHaveAttribute('title', '分轮追问隐藏决定，在达成共识前不改设计');
  await expect(checkAction).toHaveAttribute('title', '一次性审查假设、矛盾、证据缺口与风险');
  await expect(reevaluateAction).toHaveAttribute('title', '在变更后重新检查影响范围并提出定向修复');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await grillAction.click();
  await expect(page.getByText('已复制宿主聊天提示')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('$treediagram-grill');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('在我确认达成共识前不要写入候选或实施');
  await checkAction.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('$treediagram-check');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('不要修改设计');
  const workingAttentionResponse = await request.post('/api/v2/tools/attention_get', {
    data: {
      hostKind: 'codex',
      hostSessionRef: 'e2e-main',
      clientRef: 'codex-agent',
    },
  });
  const workingAttention = await workingAttentionResponse.json();
  expect(workingAttention.data.primaryNodeId).toBeTruthy();
  expect(workingAttention.data.selectedNodeIds).toHaveLength(1);
  await expect(page.getByRole('heading', { name: rootTitle })).toBeVisible();

  await page.getByRole('button', { name: '固定节点' }).first().click();
  await page.locator('.tree-title', { hasText: constraintTitle }).click({ modifiers: ['Control'] });
  await expect(page.locator('.focus-stat').nth(0).locator('strong')).toHaveText('2');
  await expect(page.locator('.focus-stat').nth(1).locator('strong')).toHaveText('1');
  await expect(page.getByLabel('范围')).toHaveValue('comparison');

  const fresh = await context.newPage();
  await fresh.goto('/?host=codex&session=e2e-fresh');
  await expect(fresh.getByText('发现上一次会话的焦点')).toBeVisible();
  await expect(fresh.locator('.focus-stat').nth(0).locator('strong')).toHaveText('0');
  await fresh.getByRole('button', { name: '恢复焦点' }).click();
  await expect(fresh.locator('.focus-stat').nth(0).locator('strong')).toHaveText('2');
  await fresh.close();

  await page.getByRole('button', { name: '开始设计迭代' }).click();
  await expect(page.getByText('当前会话持有写入权')).toBeVisible();
  const bootstrap = await request.get(
    '/api/v2/bootstrap?hostKind=codex&hostSessionRef=e2e-main&clientRef=e2e-api',
  );
  const state = await bootstrap.json();
  const proposed = await request.post('/api/v2/tools/design_change_propose', {
    data: {
      hostSessionRef: 'e2e-main',
      changeSetId: state.changeSet.id,
      expectedChangeSetVersion: state.changeSet.version,
      operation: 'create_node',
      summary: 'Add a visible e2e risk',
      payload: {
        nodeType: 'risk',
        displayTitle: 'Cross-session focus drift',
        contentText: 'New sessions require explicit focus recovery.',
        roles: ['finding'],
        attributes: { impactNote: 'Prevent silent inheritance.' },
        approvalState: 'tentative',
        epistemicState: 'assumed',
        reviewState: 'clean',
      },
    },
  });
  expect(proposed.ok()).toBeTruthy();
  const proposedState = await proposed.json();
  const rootNode = state.nodes.find(
    (node: { revision: { displayTitle: string } }) => node.revision.displayTitle === rootTitle,
  );
  if (!rootNode) throw new Error('E2E fixture root node is missing.');
  const relation = await request.post('/api/v2/tools/design_change_propose', {
    data: {
      hostSessionRef: 'e2e-main',
      changeSetId: state.changeSet.id,
      expectedChangeSetVersion: proposedState.data.changeSet.version,
      operation: 'create_relation',
      summary: 'Place e2e risk under root',
      payload: {
        relationType: 'contains',
        sourceNodeId: rootNode.node.id,
        targetNodeId: proposedState.data.change.entityId,
        rationale: 'The root design contains this risk.',
        reviewState: 'clean',
      },
    },
  });
  expect(relation.ok()).toBeTruthy();
  const relationState = await relation.json();

  await expect(page.getByRole('heading', { name: 'Cross-session focus drift' })).toBeVisible({
    timeout: 5000,
  });
  const candidateTreeNode = page
    .locator('.tree-node.candidate-node')
    .filter({ hasText: 'Cross-session focus drift' });
  await expect(candidateTreeNode).toBeVisible();
  await expect(candidateTreeNode.getByText('候选', { exact: true })).toBeVisible();
  expect(
    await candidateTreeNode.evaluate((element) =>
      (element as HTMLElement).style.getPropertyValue('--depth'),
    ),
  ).toBe('1');
  await candidateTreeNode.click();
  await expect(candidateTreeNode.getByText('Agent 可见', { exact: true })).toBeVisible();
  await expect(page.locator('.focus-main strong')).toHaveText('Cross-session focus drift');
  await expect(page.locator('.focus-main')).toContainText(
    '候选焦点 · Agent 可通过 attention_get 读取',
  );
  const candidateAttentionResponse = await request.post('/api/v2/tools/attention_get', {
    data: {
      hostKind: 'codex',
      hostSessionRef: 'e2e-agent-from-another-task',
      clientRef: 'codex-agent',
    },
  });
  const candidateAttention = await candidateAttentionResponse.json();
  expect(candidateAttention.data.primaryNodeId).toBeNull();
  expect(candidateAttention.data.primaryChangeId).toBe(proposedState.data.change.id);
  expect(candidateAttention.data.selectedChangeIds).toEqual([proposedState.data.change.id]);
  expect(candidateAttention.data.hostSessionRef).toBe('e2e-main');
  expect(candidateAttention.summary).toContain('来自当前项目最近操作的 Sidecar 会话');
  const candidateContextResponse = await request.post('/api/v2/tools/design_context_get', {
    data: {
      hostKind: 'codex',
      hostSessionRef: 'e2e-agent-from-another-task',
      clientRef: 'codex-agent',
      maxTokens: 4000,
    },
  });
  const candidateContext = await candidateContextResponse.json();
  expect(candidateContext.data.selectedChanges).toEqual([
    expect.objectContaining({ id: proposedState.data.change.id }),
  ]);
  expect(candidateContext.summary).toContain('来自最近操作的 Sidecar 会话');
  const nodeCard = page.locator('.change-card').filter({ hasText: 'Add a visible e2e risk' });
  const relationCard = page
    .locator('.change-card')
    .filter({ hasText: 'Place e2e risk under root' });
  await expect(page.getByText('Add a visible e2e risk', { exact: true })).toBeVisible();
  await expect(page.getByText('自上而下批准规则', { exact: true })).toBeVisible();
  await expect(relationCard).toHaveCount(0);
  await expect(nodeCard.getByText('批准时自动挂载', { exact: true })).toBeVisible();
  await expect(nodeCard.getByText('● Agent 可见焦点', { exact: true })).toBeVisible();
  await expect(nodeCard).toContainText(rootTitle);
  await expect(nodeCard.getByRole('button', { name: '批准并挂载' })).toBeEnabled();
  await expect(nodeCard.getByText('查看完整信息', { exact: true })).toBeVisible();
  await expect(nodeCard.locator('pre')).toBeHidden();
  await nodeCard.getByText('查看完整信息', { exact: true }).click();
  await expect(
    page.getByText('New sessions require explicit focus recovery.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Prevent silent inheritance.', { exact: true })).toBeVisible();
  await expect(page.getByText('后台按项目常驻 · 自动复用')).toBeVisible();
  expect(
    await page
      .locator('.change-card h3')
      .first()
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(14);
  await nodeCard.getByText('技术详情与原始 JSON').click();
  await expect(nodeCard.locator('pre')).toBeVisible();
  await nodeCard.getByRole('button', { name: '批准并挂载' }).click();
  await expect(page.locator('.tree-title', { hasText: 'Cross-session focus drift' })).toBeVisible();
  await expect(page.getByText('候选队列已清空')).toBeVisible();
  await expect(
    page.locator('.tree-node.position-candidate').filter({ hasText: 'Cross-session focus drift' }),
  ).toHaveCount(0);
  const adoptedStateResponse = await request.get(
    '/api/v2/bootstrap?hostKind=codex&hostSessionRef=e2e-main&clientRef=e2e-api-after-adopt',
  );
  const adoptedState = await adoptedStateResponse.json();
  const atomicChanges = adoptedState.changeSet.changes.filter(
    (change: { id: string }) =>
      change.id === proposedState.data.change.id || change.id === relationState.data.change.id,
  );
  expect(atomicChanges).toHaveLength(2);
  expect(atomicChanges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: proposedState.data.change.id, status: 'adopted' }),
      expect.objectContaining({ id: relationState.data.change.id, status: 'adopted' }),
    ]),
  );

  const revisedRootTitle = '让复杂设计在 Agent 协作中保持可见、可控且可追踪';
  const revisionResponse = await request.post('/api/v2/tools/design_change_propose', {
    data: {
      hostSessionRef: 'e2e-main',
      changeSetId: adoptedState.changeSet.id,
      expectedChangeSetVersion: adoptedState.changeSet.version,
      operation: 'revise_node',
      entityId: rootNode.node.id,
      baseRevisionId: rootNode.revision.id,
      summary: 'Revise root for tree navigation',
      payload: {
        displayTitle: revisedRootTitle,
        contentText: rootNode.revision.contentText,
        roles: rootNode.revision.roles,
        attributes: rootNode.revision.attributes,
        approvalState: 'tentative',
        epistemicState: rootNode.revision.epistemicState,
        reviewState: rootNode.revision.reviewState,
      },
    },
  });
  const revisionState = await revisionResponse.json();
  expect(revisionResponse.ok(), JSON.stringify(revisionState)).toBeTruthy();
  const revisionTreeNode = page
    .locator('.tree-node.revision-candidate')
    .filter({ hasText: revisedRootTitle });
  await expect(revisionTreeNode).toBeVisible();
  await revisionTreeNode.click();
  const revisionCard = page.locator('.change-card').filter({ hasText: revisedRootTitle });
  await expect(revisionCard).toHaveClass(/active/);
  await expect(revisionCard.getByText('● Agent 可见焦点', { exact: true })).toBeVisible();
  await expect(revisionCard).toBeInViewport();
  await revisionCard.getByRole('button', { name: '丢弃' }).click();
  await expect(revisionTreeNode).toHaveCount(0);
  expect(revisionState.data.change.operation).toBe('revise_node');

  await page.getByRole('button', { name: '运行一致性检查' }).click();
  await expect(page.getByRole('button', { name: /发布 Release/ })).toBeEnabled();
});

test('Sidecar preserves usable hierarchy at the compact breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 1000 });
  await page.goto('/?host=codex&session=e2e-compact');
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();
  const treeBox = await page.locator('.tree-panel').boundingBox();
  const inspectorBox = await page.locator('.inspector').boundingBox();
  expect(treeBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(inspectorBox!.y).toBeGreaterThan(treeBox!.y + treeBox!.height - 4);
  await page.locator('.tree-title').first().click();
  await expect(page.locator('.inspector h1')).toBeVisible();
});

test('Sidecar supports a persistent light theme', async ({ page }) => {
  await page.goto('/?host=codex&session=e2e-light-theme');
  const themeToggle = page.getByRole('button', { name: '切换到亮色主题' });
  await expect(themeToggle).toBeVisible();

  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: '切换到深色主题' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    await page
      .locator('.panel-surface')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toContain('rgb(255, 255, 255)');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: '切换到深色主题' })).toBeVisible();
});
