import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Initialize source 上传入口 e2e：多次多选追加、去重、列表查看与移除、
 * 非 initialize 类型隐藏暂存区、空列表启动的客户端拦截。
 */

const state = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.e2e-state.json', import.meta.url)), 'utf8'),
) as { adminToken: string };

const fileInput = (page: import('@playwright/test').Page) =>
  page.getByLabel('Source 文件（markdown/纯文本，可多次多选追加）');

const payload = (name: string, mimeType: string, content: string) => ({
  name,
  mimeType,
  buffer: Buffer.from(content, 'utf8'),
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('admin token').fill(state.adminToken);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();
});

test('多次多选追加 + 去重 + 列表查看与移除', async ({ page }) => {
  const staging = page.locator('.source-staging');
  // 默认选中 initialize，暂存区可见且为空
  await expect(staging).toBeVisible();
  await expect(staging).toContainText('尚未选择文件');

  // 第一次：多选两个文件
  await fileInput(page).setInputFiles([
    payload('vision.md', 'text/markdown', '# 目标\n做建模工具。'),
    payload('notes.txt', 'text/plain', '一些补充笔记'),
  ]);
  await expect(staging.locator('.staged-source-list li')).toHaveCount(2);
  await expect(staging).toContainText('vision.md');
  await expect(staging).toContainText('markdown');
  await expect(staging).toContainText('notes.txt');

  // 第二次：再追加一个 → 累计三个
  await fileInput(page).setInputFiles([payload('extra.md', 'text/markdown', '# 附录')]);
  await expect(staging.locator('.staged-source-list li')).toHaveCount(3);

  // 重复添加同一文件 → 去重仍为三个
  await fileInput(page).setInputFiles([
    payload('vision.md', 'text/markdown', '# 目标\n做建模工具。'),
  ]);
  await expect(staging.locator('.staged-source-list li')).toHaveCount(3);

  // 移除一个 → 剩两个
  await staging
    .locator('.staged-source-list li', { hasText: 'notes.txt' })
    .getByRole('button', { name: '移除' })
    .click();
  await expect(staging.locator('.staged-source-list li')).toHaveCount(2);
  await expect(staging).not.toContainText('notes.txt');
});

test('非 initialize 类型隐藏暂存区；空列表启动被客户端拦截', async ({ page }) => {
  // 切到 derive：暂存区隐藏
  await page.locator('.workflow-start select').selectOption('derive');
  await expect(page.locator('.source-staging')).toHaveCount(0);

  // 切回 initialize：空列表启动 → 客户端提示，不发请求
  await page.locator('.workflow-start select').selectOption('initialize');
  await page.getByRole('button', { name: '启动' }).click();
  await expect(page.locator('.workflow-panel .error')).toContainText('至少一个 source');
});
