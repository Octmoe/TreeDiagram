import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const hasRealModel = Boolean(process.env['OPENAI_API_KEY']);
const state = JSON.parse(
  readFileSync(fileURLToPath(new URL('./.e2e-state.json', import.meta.url)), 'utf8'),
) as { adminToken: string };

test.skip(hasRealModel, '确定性对话场景使用 FakeModelProvider 专用触发器');

test('Workflow 等待用户时显示持久化对话，回答后重跑并成功', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('admin token').fill(state.adminToken);
  await page.getByRole('button', { name: '进入' }).click();
  await page.getByText('为 AI Agent 提供可靠的程序化建模工具集', { exact: true }).first().click();

  await page.locator('.workflow-start select').selectOption('derive');
  await page.locator('.workflow-start input').fill('__fake_clarify__');
  await page.getByRole('button', { name: '启动' }).click();

  const run = page.locator('.run-list .run').first();
  await expect(run).toContainText('waiting_user', { timeout: 30_000 });
  const conversation = run.getByLabel('工作流对话');
  await expect(conversation).toContainText('请确认这个分支期望解决的具体问题');
  await conversation.getByLabel('回复 Agent').fill('只解决离线模型导入与关系校验。');
  await conversation.getByRole('button', { name: '提交并继续' }).click();

  await expect(run).toContainText('succeeded', { timeout: 30_000 });
  await expect(conversation).toContainText('只解决离线模型导入与关系校验');
});
