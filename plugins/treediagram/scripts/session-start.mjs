#!/usr/bin/env node
import { ensureProject, sidecarSessionUrl } from './runtime.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks);
  const looksUtf16 = input.length > 1 && input[1] === 0;
  const text = input.toString(looksUtf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const input = await readInput();
const sessionId =
  typeof input.session_id === 'string'
    ? input.session_id
    : typeof input.sessionId === 'string'
      ? input.sessionId
      : undefined;

try {
  const result = await ensureProject({ projectRoot: input.cwd });
  const action = result.sidecar.reused ? '复用' : '启动';
  console.log(
    [
      '[TreeDiagram V2 已就绪]',
      `当前 Codex 项目已绑定到独立 workspace: ${result.projectRoot}`,
      `workspaceId: ${result.workspace.workspaceId}`,
      `Sidecar 已${action}: ${sidecarSessionUrl(result.sidecar, sessionId)}`,
      sessionId ? `本任务的 hostSessionRef 使用: ${sessionId}` : '',
      'MCP 与 Sidecar 已自动初始化；不要再要求用户手动运行 npm 或复用其他项目的设计树。',
    ]
      .filter(Boolean)
      .join('\n'),
  );
} catch (error) {
  console.log(
    `[TreeDiagram V2 自动启动失败] ${error instanceof Error ? error.message : String(error)}`,
  );
}
