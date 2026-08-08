import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * 真实浏览器 + 真实 server + 真实模型的 UI 闭环。
 * 常规离线 E2E 自动 skip；显式提供 OPENAI_API_KEY 时才执行。
 */

const hasRealModel = Boolean(process.env['OPENAI_API_KEY']);
const state = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.e2e-state.json', import.meta.url)), 'utf8'),
) as { adminToken: string };

test.skip(!hasRealModel, '需要真实模型配置');

test('UI 启动 Derive → 等待真实模型 → Adopt → Review → Publish', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto('/');
  await page.getByLabel('admin token').fill(state.adminToken);
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByRole('heading', { name: '设计树' })).toBeVisible();

  await page.getByText('为 AI Agent 提供可靠的程序化建模工具集', { exact: true }).first().click();
  await page.locator('.workflow-start select').selectOption('derive');
  await page
    .getByLabel('聚焦指令（可选；target 为当前选中节点）')
    .fill('只生成一个 tentative claim，并只用 contains 挂在目标节点下；不要生成问题或其他关系。');
  await page.getByRole('button', { name: '启动' }).click();

  const latestRun = page.locator('.run-list .run').first();
  await expect(latestRun).toContainText('derive');
  await expect
    .poll(async () => (await latestRun.textContent()) ?? '', { timeout: 600_000 })
    .toMatch(/succeeded|waiting_user|failed/);
  const runText = (await latestRun.textContent()) ?? '';
  if (runText.includes('failed')) {
    await latestRun.getByRole('button', { name: '查看错误详情' }).click();
    const errorDialog = page.locator('.error-dialog');
    await expect(errorDialog).toBeVisible();
    throw new Error(`真实 Derive 失败：${await errorDialog.innerText()}`);
  }
  if (runText.includes('waiting_user')) {
    await latestRun.getByRole('button', { name: '取消（不回滚已写入提案）' }).click();
    await expect(latestRun).toContainText('cancelled');
  }
  await latestRun.getByRole('button', { name: '查看模型记录（1）' }).click();
  const modelLog = latestRun.getByLabel('模型调用记录');
  await expect(modelLog).toContainText('openai');
  await expect(modelLog).toContainText('responseId：');
  await modelLog.getByText(/模型最终结构化响应/).click();
  await expect(modelLog).toContainText('proposalRef');

  await page.locator('.status-bar').getByRole('button', { name: 'ChangeSet' }).click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('open');
  await drawer.getByRole('button', { name: 'Adopt and reevaluate' }).click();
  await expect(drawer).toContainText('reevaluating');

  const validButtons = drawer.locator('.review-item.status-pending button', { hasText: 'valid' });
  while ((await validButtons.count()) > 0) {
    await validButtons.first().click();
    await page.waitForTimeout(250);
  }
  await expect(drawer).toContainText('ready', { timeout: 30_000 });
  await drawer.getByLabel('Release 摘要').fill('真实模型 UI E2E 发布');
  await drawer.getByRole('button', { name: /Publish/ }).click();
  await expect(page.locator('.status-bar')).toContainText('consistent', { timeout: 30_000 });
});
