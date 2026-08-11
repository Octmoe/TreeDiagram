#!/usr/bin/env node
import {
  ensureProject,
  openExistingProject,
  sidecarSessionUrl,
  sidecarStatus,
  stopSidecar,
} from './runtime.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printStarted(result) {
  console.log(`TreeDiagram workspace: ${result.projectRoot}`);
  console.log(`workspaceId: ${result.workspace.workspaceId}`);
  console.log(`Sidecar: ${result.url ?? sidecarSessionUrl(result.sidecar, option('session'))}`);
  console.log(result.sidecar.reused ? '已复用当前项目的后台进程。' : '已启动当前项目的后台进程。');
}

const command = process.argv[2] ?? 'start';
const projectRoot = option('workspace') ?? process.cwd();

if (command === 'start') {
  const result = await ensureProject({ projectRoot });
  printStarted(result);
} else if (command === 'open') {
  const result = await openExistingProject({
    projectRoot,
    sessionId: option('session'),
    openBrowser: !hasFlag('no-browser'),
  });
  printStarted(result);
  console.log(result.browser.opened ? '已在浏览器中打开设计树。' : '已跳过浏览器打开。');
} else if (command === 'status') {
  console.log(JSON.stringify(await sidecarStatus(projectRoot), null, 2));
} else if (command === 'stop') {
  console.log(JSON.stringify(await stopSidecar(projectRoot), null, 2));
} else {
  throw new Error(`未知命令: ${command}；可用命令为 start、open、status、stop。`);
}
