import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const RUNTIME_CONFIG = 'runtime.local.json';
const STATE_DIR = '.treediagram';
const META_FILE = 'workspace.json';
const SIDECAR_FILE = 'sidecar.json';
const LOCK_FILE = 'runtime.lock';
const SIDECAR_FORMAT = 'treediagram-sidecar-v1';
const START_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 5 * 60_000;
const PORT_BASE = 43_000;
const PORT_SPAN = 10_000;

export const pluginRoot = resolve(import.meta.dirname, '..');

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isTreeDiagramRuntime(path) {
  const manifest = readJson(join(path, 'package.json'));
  return manifest?.name === 'treediagram';
}

function pluginGeneration(root = pluginRoot) {
  return (
    readJson(join(root, '.codex-plugin', 'plugin.json'))?.version ??
    readJson(join(root, 'package.json'))?.version ??
    'development'
  );
}

const RUNTIME_GENERATION_DIRECTORIES = [
  ['packages', 'contracts', 'dist'],
  ['packages', 'domain', 'dist'],
  ['packages', 'storage-sqlite', 'dist'],
  ['packages', 'attention', 'dist'],
  ['packages', 'mcp', 'dist'],
  ['apps', 'sidecar', 'dist', 'server'],
  ['apps', 'sidecar', 'dist-web'],
];

function runtimeFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function computeRuntimeGeneration(root = pluginRoot, runtimeRoot) {
  const digest = createHash('sha256');
  const files = RUNTIME_GENERATION_DIRECTORIES.flatMap((segments) =>
    runtimeFiles(join(runtimeRoot, ...segments)),
  ).sort((left, right) => left.localeCompare(right));
  for (const path of files) {
    digest.update(path.slice(runtimeRoot.length).replaceAll('\\', '/'));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return `${pluginGeneration(root)}#${digest.digest('hex').slice(0, 16)}`;
}

function runtimeCandidates(root) {
  const candidates = [
    process.env['TREEDIAGRAM_RUNTIME_ROOT'],
    readJson(join(root, RUNTIME_CONFIG))?.runtimeRoot,
    process.env['PLUGIN_DATA']
      ? readJson(join(process.env['PLUGIN_DATA'], RUNTIME_CONFIG))?.runtimeRoot
      : undefined,
    resolve(root, '..', '..'),
  ];
  return [...new Set(candidates.filter((value) => typeof value === 'string' && value.length > 0))];
}

export function resolveRuntimeRoot(root = pluginRoot) {
  for (const candidate of runtimeCandidates(root)) {
    const absolute = resolve(candidate);
    if (isTreeDiagramRuntime(absolute)) return absolute;
  }
  throw new Error(
    '找不到 TreeDiagram 本地运行时。请在 TreeDiagram 源码目录执行 npm run plugin:prepare 后重新安装插件。',
  );
}

export function resolveProjectRoot(
  value = process.env['TREEDIAGRAM_PROJECT_ROOT'] ?? process.cwd(),
) {
  const absolute = resolve(value);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Codex 项目目录不存在: ${absolute}`);
  }
  return realpathSync.native(absolute);
}

function runtimeEntries(root) {
  return {
    workspaceCli: join(root, 'packages', 'storage-sqlite', 'dist', 'cli.js'),
    mcpServer: join(root, 'packages', 'mcp', 'dist', 'stdio.js'),
    sidecarServer: join(root, 'apps', 'sidecar', 'dist', 'server', 'index.js'),
    sidecarWeb: join(root, 'apps', 'sidecar', 'dist-web', 'index.html'),
  };
}

function runNpm(root, args) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 10 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} 失败${detail ? `: ${detail}` : ''}`);
  }
}

export function ensureRuntime(root) {
  const dependency = join(root, 'node_modules', 'better-sqlite3', 'package.json');
  if (!existsSync(dependency)) runNpm(root, ['ci']);
  let entries = runtimeEntries(root);
  if (Object.values(entries).some((path) => !existsSync(path))) {
    runNpm(root, ['run', 'build']);
    entries = runtimeEntries(root);
  }
  const missing = Object.values(entries).filter((path) => !existsSync(path));
  if (missing.length) throw new Error(`TreeDiagram 构建不完整: ${missing.join(', ')}`);
  return entries;
}

function workspacePaths(projectRoot) {
  const stateDir = join(projectRoot, STATE_DIR);
  return {
    stateDir,
    metaPath: join(stateDir, META_FILE),
    sidecarPath: join(stateDir, SIDECAR_FILE),
    lockPath: join(stateDir, LOCK_FILE),
    logPath: join(stateDir, 'sidecar.log'),
  };
}

function initializeWorkspace(projectRoot, runtimeRoot, entries) {
  const result = spawnSync(
    process.execPath,
    [
      entries.workspaceCli,
      'init',
      '--workspace',
      projectRoot,
      '--name',
      basename(projectRoot) || 'TreeDiagram V2',
    ],
    { cwd: runtimeRoot, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    throw new Error(`初始化项目设计树失败${detail ? `: ${detail}` : ''}`);
  }
  const meta = readJson(workspacePaths(projectRoot).metaPath);
  if (!meta?.workspaceId) throw new Error('初始化完成后仍无法读取 workspaceId。');
  return meta;
}

async function health(port, expectedWorkspaceId, expectedRuntimeGeneration) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v2/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.ok &&
      value?.workspaceId === expectedWorkspaceId &&
      (!expectedRuntimeGeneration || value?.runtimeGeneration === expectedRuntimeGeneration)
      ? value
      : null;
  } catch {
    return null;
  }
}

function readSidecar(projectRoot) {
  const value = readJson(workspacePaths(projectRoot).sidecarPath);
  if (
    value?.format !== SIDECAR_FORMAT ||
    typeof value.port !== 'number' ||
    typeof value.workspaceId !== 'string'
  ) {
    return null;
  }
  return value;
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    rmSync(path, { force: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function preferredPort(projectRoot) {
  const digest = createHash('sha256').update(projectRoot.toLowerCase()).digest();
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = openSync(lockPath, 'wx');
      writeFileSync(
        handle,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      closeSync(handle);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(150);
    }
  }
  throw new Error(`等待 TreeDiagram 项目启动锁超时: ${lockPath}`);
}

async function startSidecar(projectRoot, runtimeRoot, entries, meta, runtimeGeneration) {
  const paths = workspacePaths(projectRoot);
  const previous = readSidecar(projectRoot);
  if (previous && (await health(previous.port, meta.workspaceId, runtimeGeneration))) {
    return { ...previous, reused: true };
  }

  const firstPort = preferredPort(projectRoot);
  for (let offset = 0; offset < 64; offset += 1) {
    const port = PORT_BASE + ((firstPort - PORT_BASE + offset) % PORT_SPAN);
    if (await health(port, meta.workspaceId, runtimeGeneration)) {
      const recovered = {
        format: SIDECAR_FORMAT,
        workspaceId: meta.workspaceId,
        projectRoot,
        port,
        url: `http://127.0.0.1:${port}/`,
        pid: null,
        startedAt: new Date().toISOString(),
        runtimeGeneration,
      };
      atomicWriteJson(paths.sidecarPath, recovered);
      return { ...recovered, reused: true };
    }

    const logHandle = openSync(paths.logPath, 'a');
    const child = spawn(
      process.execPath,
      [entries.sidecarServer, '--workspace', projectRoot, '--port', String(port)],
      {
        cwd: runtimeRoot,
        detached: true,
        windowsHide: true,
        env: { ...process.env, TREEDIAGRAM_RUNTIME_GENERATION: runtimeGeneration },
        stdio: ['ignore', logHandle, logHandle],
      },
    );
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
    closeSync(logHandle);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await health(port, meta.workspaceId, runtimeGeneration)) {
        const current = {
          format: SIDECAR_FORMAT,
          workspaceId: meta.workspaceId,
          projectRoot,
          port,
          url: `http://127.0.0.1:${port}/`,
          pid: child.pid ?? null,
          startedAt: new Date().toISOString(),
          runtimeGeneration,
        };
        atomicWriteJson(paths.sidecarPath, current);
        return { ...current, reused: false };
      }
      if (spawnError) break;
      if (child.exitCode !== null) break;
      await sleep(120);
    }
  }
  throw new Error(`无法为项目启动 TreeDiagram Sidecar；日志: ${paths.logPath}`);
}

export async function ensureProject(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const runtimeRoot = options.runtimeRoot
    ? resolve(options.runtimeRoot)
    : resolveRuntimeRoot(options.pluginRoot ?? pluginRoot);
  const entries = ensureRuntime(runtimeRoot);
  const runtimeGeneration =
    options.runtimeGeneration ??
    computeRuntimeGeneration(options.pluginRoot ?? pluginRoot, runtimeRoot);
  const paths = workspacePaths(projectRoot);
  mkdirSync(paths.stateDir, { recursive: true });

  const existingMeta = readJson(paths.metaPath);
  const existingSidecar = existingMeta?.workspaceId ? readSidecar(projectRoot) : null;
  if (
    existingMeta?.workspaceId &&
    existingSidecar &&
    (await health(existingSidecar.port, existingMeta.workspaceId, runtimeGeneration))
  ) {
    return {
      projectRoot,
      runtimeRoot,
      workspace: existingMeta,
      sidecar: { ...existingSidecar, reused: true },
    };
  }

  await acquireLock(paths.lockPath);
  try {
    const currentSidecar = existingMeta?.workspaceId ? readSidecar(projectRoot) : null;
    if (
      currentSidecar &&
      (await health(currentSidecar.port, existingMeta.workspaceId)) &&
      !(await health(currentSidecar.port, existingMeta.workspaceId, runtimeGeneration))
    ) {
      await stopSidecar(projectRoot);
    }
    const workspace = initializeWorkspace(projectRoot, runtimeRoot, entries);
    const sidecar = await startSidecar(
      projectRoot,
      runtimeRoot,
      entries,
      workspace,
      runtimeGeneration,
    );
    return { projectRoot, runtimeRoot, workspace, sidecar };
  } finally {
    rmSync(paths.lockPath, { force: true });
  }
}

export function hasWorkspace(value) {
  const projectRoot = resolveProjectRoot(value);
  const workspace = readJson(workspacePaths(projectRoot).metaPath);
  return Boolean(workspace?.workspaceId);
}

export async function openExternalUrl(url, options = {}) {
  if (options.openBrowser === false || process.env['TREEDIAGRAM_NO_BROWSER'] === '1') {
    return { opened: false, reason: 'disabled' };
  }

  const launch =
    process.platform === 'win32'
      ? { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
      : process.platform === 'darwin'
        ? { command: 'open', args: [url] }
        : { command: 'xdg-open', args: [url] };

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', rejectPromise);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
  return { opened: true };
}

export async function openExistingProject(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  if (!hasWorkspace(projectRoot)) {
    throw new Error(
      `未找到已有 TreeDiagram 设计树: ${projectRoot}。请先在项目中完成一次初始化；打开命令不会隐式创建 workspace。`,
    );
  }

  const result = await ensureProject({
    projectRoot,
    runtimeRoot: options.runtimeRoot,
    pluginRoot: options.pluginRoot,
  });
  const url = sidecarSessionUrl(result.sidecar, options.sessionId);
  const browser = await openExternalUrl(url, options);
  return { ...result, url, browser };
}

export async function sidecarStatus(value) {
  const projectRoot = resolveProjectRoot(value);
  const meta = readJson(workspacePaths(projectRoot).metaPath);
  const sidecar = meta?.workspaceId ? readSidecar(projectRoot) : null;
  const running = Boolean(sidecar && (await health(sidecar.port, meta.workspaceId)));
  return { projectRoot, workspace: meta, sidecar, running };
}

export async function stopSidecar(value) {
  const projectRoot = resolveProjectRoot(value);
  const paths = workspacePaths(projectRoot);
  const sidecar = readSidecar(projectRoot);
  if (!sidecar) return { projectRoot, stopped: false };
  if (Number.isInteger(sidecar.pid) && sidecar.pid > 0) {
    try {
      process.kill(sidecar.pid, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await health(sidecar.port, sidecar.workspaceId))) {
    await sleep(100);
  }
  rmSync(paths.sidecarPath, { force: true });
  return { projectRoot, stopped: true, port: sidecar.port };
}

export function sidecarSessionUrl(sidecar, sessionId) {
  const url = new URL(sidecar.url);
  url.searchParams.set('host', 'codex');
  if (sessionId) url.searchParams.set('session', sessionId);
  return url.toString();
}
