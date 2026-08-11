#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureProject, resolveProjectRoot } from './runtime.mjs';

try {
  const projectRoot = resolveProjectRoot();
  const runtime = await ensureProject({ projectRoot });
  const child = spawn(
    process.execPath,
    [join(runtime.runtimeRoot, 'packages', 'mcp', 'dist', 'stdio.js'), '--workspace', projectRoot],
    {
      cwd: runtime.runtimeRoot,
      env: { ...process.env, TREEDIAGRAM_WORKSPACE: projectRoot },
      stdio: 'inherit',
      windowsHide: true,
    },
  );

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(`[TreeDiagram MCP] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
