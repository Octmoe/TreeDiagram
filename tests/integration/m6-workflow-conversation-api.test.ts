import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CoreWorkflowRunner,
  FakeModelProvider,
  WorkspaceService,
  systemClock,
} from '@treediagram/core';
import { buildServer, type AppInstance } from '@treediagram/server';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    workflowType: 'initialize',
    summary: '测试提案',
    nodeActions: [],
    relationActions: [],
    questionsForUser: [],
    warnings: [],
    stopReason: 'completed',
    ...overrides,
  };
}

function nodeAction(ref: string, root = false) {
  return {
    proposalRef: ref,
    operation: 'create',
    logicalNodeId: null,
    baseRevisionId: null,
    nodeType: 'claim',
    displayTitle: ref,
    contentText: ref,
    roles: root ? ['root'] : [],
    attributes: null,
    approvalSuggestion: 'tentative',
    epistemicState: 'assumed',
    rationale: '测试',
  };
}

function containsAction() {
  return {
    proposalRef: 'root-rel1',
    operation: 'create',
    logicalRelationId: null,
    baseRelationRevisionId: null,
    relationType: 'contains',
    from: { refKind: 'proposal', ref: 'root1' },
    to: { refKind: 'proposal', ref: 'c1' },
    rationale: '测试',
    attributes: null,
    approvalSuggestion: 'tentative',
  };
}

async function waitForStatus(
  app: AppInstance,
  token: string,
  runId: string,
  expected: string,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${runId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const run = response.json().data;
    if (run.status === expected) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`WorkflowRun 未到达 ${expected}`);
}

describe('M6 Workflow 对话 HTTP API', () => {
  const directories: string[] = [];
  const apps: AppInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('问题列表、无体 resume 拒绝、respond 幂等与同阶段恢复形成闭环', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'treediagram-conversation-'));
    directories.push(directory);
    const workspaceService = new WorkspaceService(systemClock);
    const { adminToken, consumerToken } = workspaceService.initWorkspace(
      directory,
      'conversation-api',
    );
    const opened = workspaceService.openWorkspace(directory);
    const provider = FakeModelProvider.scripted([
      proposal({
        summary: '输入模糊，需要确认。',
        questionsForUser: [
          {
            question: '建模领域是什么？',
            blocking: true,
            relatedProposalRefs: [],
          },
        ],
        stopReason: 'insufficient_context',
      }),
      proposal({ nodeActions: [nodeAction('c1')] }),
      proposal({ nodeActions: [nodeAction('root1', true)], relationActions: [containsAction()] }),
    ]);
    const runner = new CoreWorkflowRunner(
      { db: opened.db, clock: systemClock },
      { provider, model: 'test-model', safetyIdentifier: 'a'.repeat(32) },
    );
    const app = buildServer({
      db: opened.db,
      clock: systemClock,
      config: {
        workspaceDir: directory,
        host: '127.0.0.1',
        port: 0,
        maxSourceBytes: 2 * 1024 * 1024,
        logLevel: 'error',
        model: 'test-model',
        modelTimeoutMs: 300_000,
        modelProvider: 'fake',
        modelApiKey: null,
        modelBaseUrl: null,
      },
      workflowRunner: runner,
    });
    apps.push(app);
    await app.ready();
    const headers = { authorization: `Bearer ${adminToken}` };

    const sourceResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: {
        kind: 'text',
        originalName: 'start.txt',
        mediaType: 'text/plain',
        contentText: '一套给 agent 使用的建模工具',
      },
    });
    const sourceId = sourceResponse.json().data.id as string;
    const startResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      headers,
      payload: {
        workflowType: 'initialize',
        targetNodeId: null,
        changeSetId: null,
        sourceAssetIds: [sourceId],
        focusInstruction: null,
      },
    });
    const runId = startResponse.json().data.id as string;
    await waitForStatus(app, adminToken, runId, 'waiting_user');

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${runId}/messages`,
      headers: { authorization: `Bearer ${consumerToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${runId}/messages`,
      headers,
    });
    expect(messagesResponse.statusCode).toBe(200);
    const conversation = messagesResponse.json().data;
    expect(conversation.messages[0].questions[0].question).toBe('建模领域是什么？');
    expect(conversation.openWait.id).toBeTruthy();

    const legacyResume = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${runId}/resume`,
      headers,
    });
    expect(legacyResume.statusCode).toBe(409);
    expect(legacyResume.json().error.code).toBe('WORKFLOW_NOT_RESUMABLE');

    const clientMessageId = crypto.randomUUID();
    const responsePayload = {
      waitId: conversation.openWait.id,
      clientMessageId,
      message: '软件架构图；通过 TypeScript API 使用。',
      answers: [],
      sourceAssetIds: [],
    };
    const responded = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${runId}/respond`,
      headers,
      payload: responsePayload,
    });
    expect(responded.statusCode).toBe(202);
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${runId}/respond`,
      headers,
      payload: responsePayload,
    });
    expect(duplicate.statusCode).toBe(202);

    await waitForStatus(app, adminToken, runId, 'succeeded');
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]!.input).toContain('软件架构图');
    const finalConversation = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${runId}/messages`,
      headers,
    });
    expect(finalConversation.json().data.messages).toHaveLength(2);
    expect(finalConversation.json().data.openWait).toBeNull();
  });
});
