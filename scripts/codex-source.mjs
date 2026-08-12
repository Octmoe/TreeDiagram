#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pluginRoot = join(root, 'plugins', 'treediagram');
const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const marketplaceName = 'treediagram-local';
const pluginName = 'treediagram';
const codexCommand = process.platform === 'win32' ? 'codex.exe' : 'codex';
const action = process.argv[2];
const noCodex = process.argv.includes('--no-codex');

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    windowsHide: true,
  });
  if (result.error) {
    const hint = command === codexCommand ? '；请确认 Codex CLI 已安装并可从终端运行' : '';
    throw new Error(`${command} 启动失败${hint}：${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim() : '';
    throw new Error(`${command} ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`);
  }
  return result;
}

function runNpm(args) {
  const npmExecPath = process.env['npm_execpath'];
  if (npmExecPath && existsSync(npmExecPath)) return run(process.execPath, [npmExecPath, ...args]);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npmCommand, args);
}

function cachebusterVersion(version) {
  const base = version.split('+')[0];
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  return `${base}+codex.${stamp}`;
}

function dependenciesMatchLock() {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath) || !existsSync(join(root, 'node_modules'))) return false;

  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const [relativePath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!relativePath.startsWith('node_modules/') || metadata.link === true) continue;
    const packageManifestPath = join(root, ...relativePath.split('/'), 'package.json');
    if (!existsSync(packageManifestPath)) {
      if (metadata.optional === true) continue;
      return false;
    }
    const installed = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
    if (installed.version !== metadata.version) return false;
  }
  return true;
}

function sqliteRuntimeReady() {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();",
    ],
    { cwd: root, stdio: 'ignore', windowsHide: true },
  );
  return probe.status === 0;
}

function prepareAndInstall() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 24)
    throw new Error(`TreeDiagram 需要 Node.js 24+；当前为 ${process.versions.node}。`);

  if (dependenciesMatchLock()) {
    console.log('现有 node_modules 与 package-lock.json 一致，跳过重复 npm ci。');
  } else {
    try {
      runNpm(['ci']);
    } catch (error) {
      throw new Error(
        `依赖需要重新安装，但 npm ci 失败。请先关闭使用此源码运行时的 Codex 任务和 TreeDiagram Sidecar，再重试。\n${error.message}`,
      );
    }
  }
  if (!sqliteRuntimeReady()) {
    console.log('正在恢复 better-sqlite3 本机绑定。');
    try {
      runNpm(['rebuild', 'better-sqlite3']);
    } catch (error) {
      throw new Error(
        `better-sqlite3 本机绑定不可用。请先关闭使用此源码运行时的 Codex 任务和 TreeDiagram Sidecar，再重试。\n${error.message}`,
      );
    }
    if (!sqliteRuntimeReady()) throw new Error('better-sqlite3 重建完成后仍无法加载。');
  }
  runNpm(['run', 'build']);

  const original = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original);
  manifest.version = cachebusterVersion(manifest.version);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  try {
    run(process.execPath, ['scripts/prepare-local-plugin.mjs']);
    if (noCodex) {
      console.log('已完成本机运行时准备；--no-codex 跳过了 Codex 注册。');
      return;
    }

    const marketplace = run(codexCommand, ['plugin', 'marketplace', 'add', root], {
      capture: true,
      allowFailure: true,
    });
    if (marketplace.stdout) process.stdout.write(marketplace.stdout);
    if (marketplace.stderr) process.stderr.write(marketplace.stderr);
    if (marketplace.status !== 0) {
      const detail = `${marketplace.stderr ?? ''}\n${marketplace.stdout ?? ''}`.toLowerCase();
      if (!/(already|exists|registered|已存在|重复)/.test(detail)) {
        throw new Error('无法注册 TreeDiagram repo marketplace。');
      }
    }

    run(codexCommand, ['plugin', 'add', `${pluginName}@${marketplaceName}`]);
    console.log('TreeDiagram 已安装。请新建 Codex 任务以加载更新后的 Skills、Hook 与 MCP。');
  } finally {
    writeFileSync(manifestPath, original, 'utf8');
  }
}

if (action === 'install' || action === 'update') {
  prepareAndInstall();
} else if (action === 'uninstall') {
  const workspace = option('workspace');
  if (workspace) {
    run(process.execPath, [
      'plugins/treediagram/scripts/project.mjs',
      'stop',
      '--workspace',
      resolve(workspace),
    ]);
  }
  console.log('请在 Codex 的 /plugins 浏览器中打开 TreeDiagram 并选择 Uninstall plugin。');
  console.log('卸载插件不会删除任何项目中的 .treediagram 设计数据。');
} else {
  throw new Error('用法：node scripts/codex-source.mjs <install|update|uninstall> [--no-codex]');
}
