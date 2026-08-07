import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * M2 编辑器 e2e：token gate → 树浏览 → Inspector → 候选编辑 →
 * adopt → 复核 → 自动 ready → publish Release 2。
 */

const state = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.e2e-state.json', import.meta.url)), 'utf8'),
) as { adminToken: string };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // token gate：粘贴 admin token（仅存 sessionStorage）
  await page.getByLabel('admin token').fill(state.adminToken);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();
});

test('token gate 加载静态 UI 并进入编辑器', async ({ page }) => {
  await expect(page.getByText('为 AI Agent 提供可靠的程序化建模工具集').first()).toBeVisible();
  await expect(page.locator('.status-bar')).toContainText('consistent');
});

test('树选择节点后 Inspector 显示 Overview', async ({ page }) => {
  await page.getByText('为 AI Agent 提供可靠的程序化建模工具集').first().click();
  await expect(page.locator('.inspector h2')).toContainText(
    '为 AI Agent 提供可靠的程序化建模工具集',
  );
  await expect(page.locator('.inspector .tab.active')).toHaveText('overview');
});

test('完整编辑-发布闭环：新建候选 → adopt → 复核 → publish Release 2', async ({ page }) => {
  // 新建顶层 topic 节点
  await page.getByRole('button', { name: '新建节点' }).click();
  await page.getByLabel('标题').fill('e2e 新增主题');
  await page.getByLabel('正文').fill('e2e 创建的主题正文');
  await page.getByRole('button', { name: '创建候选节点' }).click();

  // 候选出现在树中并自动选中
  await expect(page.getByText('e2e 新增主题').first()).toBeVisible();

  // 打开 ChangeSet 抽屉并 adopt
  await page.locator('.status-bar').getByRole('button', { name: 'ChangeSet' }).click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('open');
  await drawer.getByRole('button', { name: 'Adopt and reevaluate' }).click();
  await expect(drawer).toContainText('reevaluating');

  // 全部复核项 resolve valid → 自动 ready
  const pendingButtons = drawer.locator('.review-item.status-pending button', { hasText: 'valid' });
  while ((await pendingButtons.count()) > 0) {
    await pendingButtons.first().click();
    await page.waitForTimeout(300);
  }
  await expect(drawer).toContainText('ready', { timeout: 10000 });

  // publish
  await drawer.getByLabel('Release 摘要').fill('Release 2：e2e 新增主题');
  await drawer.getByRole('button', { name: /Publish/ }).click();
  await expect(page.locator('.status-bar')).toContainText('Release v2', { timeout: 10000 });
  await expect(page.locator('.status-bar')).toContainText('consistent');
});
