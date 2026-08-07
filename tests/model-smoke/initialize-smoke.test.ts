import { describe, expect, it } from 'vitest';
import { CoreWorkflowRunner, OpenAIProvider, userAuthor } from '@treediagram/core';
import { freshProject, makeTestWorkspace } from '../helpers/workspace.js';

/**
 * 真实 OpenAI 冒烟测试（IMPLEMENTATION_DESIGN §16.4）：
 * 仅在设置 OPENAI_API_KEY 时运行（CI/本地手动：`npm run test:model-smoke`）。
 * 验证 Responses API strict json_schema 链路真实可用，而非仅 fake 编排。
 */

const apiKey = process.env['OPENAI_API_KEY'];
const model = process.env['TREEDIAGRAM_MODEL'] ?? 'gpt-5.6-terra';

describe.skipIf(!apiKey)('OpenAI 真实调用冒烟（§16.4）', () => {
  it('initialize：最小 source 产生合法提案并落库', async () => {
    const ws = makeTestWorkspace('model-smoke');
    const source = ws.services.sources.addSource(
      ws.project.id,
      {
        kind: 'markdown',
        originalName: 'smoke.md',
        mediaType: 'text/markdown',
        contentText: '# 目标\n做一个本地优先的决策建模工具。\n\n# 约束\n数据不出本机；单人使用。',
      },
      userAuthor,
    );
    const provider = new OpenAIProvider(apiKey!, 120_000);
    const runner = new CoreWorkflowRunner(ws.ctx, {
      provider,
      model,
      safetyIdentifier: 'b'.repeat(32),
    });
    const run = runner.start(freshProject(ws), {
      workflowType: 'initialize',
      targetNodeId: null,
      sourceAssetIds: [source.id],
      focusInstruction: null,
    });
    const final = await runner.waitForCompletion(run.id, 180_000);

    // 真实模型输出不可预测内容，但必须通过完整状态机
    expect(['succeeded', 'waiting_user']).toContain(final.status);
    expect(final.error).toBeNull();
    expect(final.providerResponseId).toBeTruthy();
    const nodes = ws.db.repos.node.listNodesByProject(ws.project.id);
    expect(nodes.length).toBeGreaterThan(0);
    // 每个候选修订的 approvalState 必须是合法枚举（降级规则生效）
    for (const node of nodes) {
      const revisions = ws.db.repos.node.listRevisionsByNode(node.id);
      for (const revision of revisions) {
        expect(['draft', 'tentative', 'ai_confirmed', 'user_confirmed']).toContain(
          revision.approvalState,
        );
      }
    }
  }, 240_000);
});
