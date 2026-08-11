import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { V2Store } from '@treediagram/storage-sqlite';
import { ToolService } from './tool-service.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './tools.js';

type JsonSchema = Record<string, unknown>;

function schemaToZod(schema: JsonSchema): z.ZodType {
  let value: z.ZodType;
  if (Array.isArray(schema['anyOf'])) {
    const options = (schema['anyOf'] as JsonSchema[]).map(schemaToZod);
    value = z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  } else if (Array.isArray(schema['enum'])) {
    value = z.enum(schema['enum'] as [string, ...string[]]);
  } else {
    const type = schema['type'];
    if (Array.isArray(type)) {
      const nonNull = type.find((item) => item !== 'null');
      value = schemaToZod({ ...schema, type: nonNull }).nullable();
    } else if (type === 'null') {
      value = z.null();
    } else if (type === 'string') {
      let text = z.string();
      if (typeof schema['minLength'] === 'number') text = text.min(schema['minLength']);
      if (typeof schema['maxLength'] === 'number') text = text.max(schema['maxLength']);
      value = text;
    } else if (type === 'integer') {
      let number = z.number().int();
      if (typeof schema['minimum'] === 'number') number = number.min(schema['minimum']);
      if (typeof schema['maximum'] === 'number') number = number.max(schema['maximum']);
      value = number;
    } else if (type === 'number') {
      value = z.number();
    } else if (type === 'boolean') {
      value = z.boolean();
    } else if (type === 'array') {
      let array = z.array(schemaToZod((schema['items'] as JsonSchema | undefined) ?? {}));
      if (typeof schema['minItems'] === 'number') array = array.min(schema['minItems']);
      if (typeof schema['maxItems'] === 'number') array = array.max(schema['maxItems']);
      value = array;
    } else if (type === 'object') {
      const properties = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {};
      const required = new Set((schema['required'] as string[] | undefined) ?? []);
      const shape: Record<string, z.ZodType> = {};
      for (const [key, child] of Object.entries(properties)) {
        const childSchema = schemaToZod(child);
        shape[key] = required.has(key) ? childSchema : childSchema.optional();
      }
      const object = z.object(shape);
      const additionalProperties = schema['additionalProperties'];
      value =
        additionalProperties === false
          ? object.strict()
          : additionalProperties && typeof additionalProperties === 'object'
            ? object.catchall(schemaToZod(additionalProperties as JsonSchema))
            : object.passthrough();
    } else {
      value = z.unknown();
    }
  }
  return typeof schema['description'] === 'string' ? value.describe(schema['description']) : value;
}

export function createMcpServer(toolService: ToolService): McpServer {
  const server = new McpServer(
    { name: 'treediagram', version: '2.0.0' },
    { capabilities: { logging: {} } },
  );
  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.name,
        description: definition.description,
        inputSchema: schemaToZod(definition.inputSchema),
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint:
            definition.name.includes('discard') || definition.name.includes('remove'),
          idempotentHint: definition.readOnly || definition.name === 'attention_set',
          openWorldHint: false,
        },
      },
      async (args) => {
        const result = await toolService.call(definition.name, args);
        const summary = result.ok
          ? result.summary
          : `${result.error.category}: ${result.error.message}`;
        return {
          content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result, null, 2)}` }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      },
    );
  }
  server.registerResource(
    'workspace',
    'treediagram://workspace',
    {
      title: 'TreeDiagram workspace',
      description: '当前 V2 workspace 的稳定摘要。',
      mimeType: 'application/json',
    },
    async () => {
      const summary = toolService.store.getWorkspaceSummary();
      return {
        contents: [
          {
            uri: 'treediagram://workspace',
            mimeType: 'application/json',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
  return server;
}

export async function runStdioServer(store: V2Store): Promise<void> {
  const server = createMcpServer(new ToolService(store));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function handleStreamableHttp(
  request: IncomingMessage & { body?: unknown },
  response: ServerResponse,
  body: unknown,
  toolService: ToolService,
): Promise<void> {
  const server = createMcpServer(toolService);
  const transport = new StreamableHTTPServerTransport();
  try {
    // SDK 1.30 的声明未在 exactOptionalPropertyTypes 下归一化 onclose；运行时实现满足 Transport。
    await server.connect(transport as unknown as Parameters<McpServer['connect']>[0]);
    await transport.handleRequest(request, response, body);
  } finally {
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
  }
}

export type { ToolDefinition };
