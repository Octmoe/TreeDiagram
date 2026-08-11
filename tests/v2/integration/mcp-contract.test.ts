import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initializeWorkspace, V2Store } from '@treediagram/storage-sqlite';
import { createMcpServer, TOOL_DEFINITIONS, ToolService } from '@treediagram/mcp';
import { buildSidecar } from '@treediagram/sidecar/server';

const tempDirs: string[] = [];
const createStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'treediagram-mcp-test-'));
  tempDirs.push(dir);
  initializeWorkspace(dir, 'MCP contract');
  return new V2Store(dir);
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('MCP and Sidecar transports', () => {
  it('exposes the same tool definitions through a standard MCP client', async () => {
    const store = createStore();
    const server = createMcpServer(new ToolService(store));
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(
        new Set(TOOL_DEFINITIONS.map((tool) => tool.name)),
      );
      const proposeTool = listed.tools.find((tool) => tool.name === 'design_change_propose');
      expect(proposeTool).toBeDefined();
      expect(JSON.stringify(proposeTool?.inputSchema)).toContain('displayTitle');
      expect(JSON.stringify(proposeTool?.inputSchema)).toContain('sourceNodeId');
      const result = await client.callTool({ name: 'design_workspace_get', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({ ok: true }));

      const started = await client.callTool({
        name: 'changeset_begin',
        arguments: { hostSessionRef: 'schema-test', title: 'Schema contract' },
      });
      const startedContent = started.structuredContent as {
        ok: true;
        data: { changeSet: { id: string; version: number } };
      };
      expect(startedContent.ok).toBe(true);
      const leaseState = await client.callTool({
        name: 'design_changeset_get',
        arguments: { hostSessionRef: 'schema-test' },
      });
      expect(leaseState.structuredContent).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            lease: expect.objectContaining({ expiresAt: expect.any(String) }),
            leaseStatus: expect.objectContaining({ state: 'owned', canWrite: true }),
          }),
        }),
      );
      const handoff = await client.callTool({
        name: 'changeset_lease_handoff_request',
        arguments: {
          hostSessionRef: 'requesting-agent',
          changeSetId: startedContent.data.changeSet.id,
          purpose: 'Continue the requested MCP design proposal.',
        },
      });
      expect(handoff.structuredContent).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            requesterHostSessionRef: 'requesting-agent',
            status: 'pending',
          }),
        }),
      );
      const waitingLeaseState = await client.callTool({
        name: 'design_changeset_get',
        arguments: { hostSessionRef: 'requesting-agent' },
      });
      expect(waitingLeaseState.structuredContent).toEqual(
        expect.objectContaining({
          ok: true,
          data: expect.objectContaining({
            leaseStatus: expect.objectContaining({ state: 'foreign_active' }),
            handoffRequests: [expect.objectContaining({ status: 'pending' })],
          }),
        }),
      );
      const proposed = await client.callTool({
        name: 'design_change_propose',
        arguments: {
          hostSessionRef: 'schema-test',
          changeSetId: startedContent.data.changeSet.id,
          expectedChangeSetVersion: startedContent.data.changeSet.version,
          operation: 'create_node',
          payload: {
            nodeType: 'goal',
            displayTitle: 'First durable design node',
            contentText: 'The MCP payload contract accepts the domain-required node fields.',
            roles: ['root'],
            attributes: { source: 'mcp-contract-test' },
          },
          summary: 'Create the first node through MCP',
        },
      });
      expect(proposed.isError).not.toBe(true);
      expect(proposed.structuredContent).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('serves Sidecar bootstrap and tool calls while rejecting cross-origin writes', async () => {
    const store = createStore();
    const app = buildSidecar(store);
    try {
      const health = await app.inject({ method: 'GET', url: '/api/v2/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual(
        expect.objectContaining({
          ok: true,
          version: 2,
          runtimeGeneration: expect.any(String),
        }),
      );

      const attention = await app.inject({
        method: 'POST',
        url: '/api/v2/tools/attention_set',
        payload: {
          hostKind: 'codex',
          hostSessionRef: 'session-a',
          clientRef: 'client-a',
          selectedNodeIds: [],
          expectedVersion: 0,
        },
      });
      expect(attention.statusCode).toBe(200);
      expect(attention.json()).toEqual(expect.objectContaining({ ok: true }));

      const bootstrap = await app.inject({
        method: 'GET',
        url: '/api/v2/bootstrap?hostKind=codex&hostSessionRef=session-a&clientRef=client-a',
      });
      expect(bootstrap.json()).toEqual(
        expect.objectContaining({ attention: expect.objectContaining({ version: 1 }), nodes: [] }),
      );

      const denied = await app.inject({
        method: 'POST',
        url: '/api/v2/tools/attention_clear',
        headers: { origin: 'https://attacker.example', host: '127.0.0.1:4317' },
        payload: { hostKind: 'codex', hostSessionRef: 'session-a', clientRef: 'client-a' },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
      store.close();
    }
  });

  it('requires an exact project-name confirmation before scheduling workspace archival', async () => {
    const store = createStore();
    const calls: string[] = [];
    const archivePath = join(tmpdir(), 'project', '.treediagram-archive', 'fixture');
    const app = buildSidecar(store, {
      projectRoot: join(tmpdir(), 'project'),
      archivePath,
      requestClose: () => calls.push('close'),
      requestClear: (path) => calls.push(`clear:${path}`),
    });
    try {
      const bootstrap = await app.inject({
        method: 'GET',
        url: '/api/v2/bootstrap?hostKind=codex&hostSessionRef=session-a&clientRef=client-a',
      });
      expect(bootstrap.json().lifecycle).toEqual(
        expect.objectContaining({
          available: true,
          archivePath,
          confirmationText: 'MCP contract',
        }),
      );

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v2/workspace/clear',
        payload: { confirmationText: 'wrong project' },
      });
      expect(rejected.statusCode).toBe(409);
      expect(calls).toEqual([]);

      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v2/workspace/clear',
        payload: { confirmationText: 'MCP contract' },
      });
      expect(accepted.json()).toEqual({ accepted: true, mode: 'clear', archivePath });
      expect(calls).toEqual([`clear:${archivePath}`]);

      const closed = await app.inject({ method: 'POST', url: '/api/v2/workspace/close' });
      expect(closed.json()).toEqual({ accepted: true, mode: 'close' });
      expect(calls).toEqual([`clear:${archivePath}`, 'close']);
    } finally {
      await app.close();
      store.close();
    }
  });

  it('serves the same tools over Streamable HTTP', async () => {
    const store = createStore();
    const app = buildSidecar(store);
    const client = new Client({ name: 'http-contract-test', version: '1.0.0' });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', address));
      await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
      const listed = await client.listTools();
      expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(
        new Set(TOOL_DEFINITIONS.map((tool) => tool.name)),
      );
      const result = await client.callTool({ name: 'design_workspace_get', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      await client.close();
      await app.close();
      store.close();
    }
  });
});
