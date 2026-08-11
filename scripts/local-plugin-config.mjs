import { isAbsolute, join, resolve } from 'node:path';

export function createLocalMcpManifest(pluginRoot, nodeExecutable = process.execPath) {
  const absolutePluginRoot = resolve(pluginRoot);
  const absoluteNodeExecutable = resolve(nodeExecutable);
  const launcher = join(absolutePluginRoot, 'scripts', 'mcp-server.mjs');

  if (!isAbsolute(absoluteNodeExecutable) || !isAbsolute(launcher)) {
    throw new Error('TreeDiagram 本地 MCP 启动配置必须使用绝对路径。');
  }

  return {
    mcpServers: {
      treediagram: {
        command: absoluteNodeExecutable,
        args: [launcher],
        startup_timeout_sec: 120,
        tool_timeout_sec: 120,
      },
    },
  };
}
