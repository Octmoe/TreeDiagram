import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/** 常规 E2E 在 fake provider 下验证管理员模型调用记录的完整 UI 链路。 */

const hasRealModel = Boolean(process.env['OPENAI_API_KEY']);
const state = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.e2e-state.json', import.meta.url)), 'utf8'),
) as { adminToken: string };

test.skip(hasRealModel, '真实模型环境由 z-real-model-workflow 覆盖，避免重复外部调用');

test('Derive 完成后可查看经过筛选的模型请求与响应记录', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('admin token').fill(state.adminToken);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();

  await page.getByText('为 AI Agent 提供可靠的程序化建模工具集', { exact: true }).first().click();
  await page.locator('.workflow-start select').selectOption('derive');
  await page.getByRole('button', { name: '启动' }).click();

  const run = page.locator('.run-list .run').first();
  await expect(run).toContainText('succeeded', { timeout: 30_000 });
  await run.getByRole('button', { name: '查看模型记录（1）' }).click();

  const log = run.getByLabel('模型调用记录');
  await expect(log).toContainText('derive');
  await expect(log).toContainText('succeeded');
  await expect(log).toContainText('不包含模型内部思维链');
  await log.getByText(/发送的上下文（已过滤）/).click();
  await expect(log).toContainText('为 AI Agent 提供可靠的程序化建模工具集');
  await log.getByText(/模型最终结构化响应/).click();
  await expect(log).toContainText('proposalRef');
});
