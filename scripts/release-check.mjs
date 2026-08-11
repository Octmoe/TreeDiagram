#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const allowDirty = process.argv.includes('--allow-dirty');
const allowNoRemote = process.argv.includes('--allow-no-remote');
const failures = [];
const releaseVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  failures.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

const requiredFiles = [
  'LICENSE',
  'NOTICE',
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'MANUAL.md',
  'README.md',
  'docs/RELEASING.md',
  '.github/workflows/ci.yml',
  '.github/release.yml',
  '.agents/plugins/marketplace.json',
  'plugins/treediagram/.codex-plugin/plugin.json',
];
for (const relativePath of requiredFiles) {
  if (!existsSync(join(root, relativePath))) fail(`缺少发布文件：${relativePath}`);
}

const archivedRuntimePaths = [
  'apps/server',
  'apps/web',
  'packages/core',
  'packages/contracts/src/schemas',
  'tests/e2e',
  'tests/integration',
  'tests/model-smoke',
  'tests/unit',
  'DESIGN.md',
  'IMPLEMENTATION_DESIGN.md',
  'IMPLEMENTATION_PLAN.md',
  'V1_SPEC.md',
  'docs/API_CONTRACT.md',
];
for (const relativePath of archivedRuntimePaths) {
  if (existsSync(join(root, relativePath))) {
    fail(`活跃 V2 源码树重新包含已归档路径：${relativePath}`);
  }
}

const rootManifest = readJson(join(root, 'package.json'));
const version = rootManifest.version;
if (!releaseVersionPattern.test(version)) {
  fail(`根版本不是干净的 release SemVer：${version}`);
}
if (rootManifest.private !== true) fail('根 package.json 必须保持 private: true，防止误发 npm。');
if (rootManifest.license !== 'Apache-2.0') fail('根 package.json license 必须为 Apache-2.0。');

const workspacePaths = rootManifest.workspaces.map((workspace) => `${workspace}/package.json`);
for (const relativePath of workspacePaths) {
  const manifest = readJson(join(root, relativePath));
  if (manifest.version !== version) {
    fail(`${relativePath} 版本 ${manifest.version} 与根版本 ${version} 不一致。`);
  }
  if (manifest.private !== true) fail(`${relativePath} 必须保持 private: true。`);
  if (manifest.license !== 'Apache-2.0') fail(`${relativePath} 缺少 Apache-2.0 license。`);
}

const pluginManifest = readJson(
  join(root, 'plugins', 'treediagram', '.codex-plugin', 'plugin.json'),
);
if (pluginManifest.version !== version) {
  fail(`插件版本 ${pluginManifest.version} 与根版本 ${version} 不一致或仍含本地 cachebuster。`);
}
if (pluginManifest.license !== 'Apache-2.0') fail('插件 manifest 缺少 Apache-2.0 license。');
if ((pluginManifest.interface?.defaultPrompt?.length ?? 0) > 3) {
  fail('插件 defaultPrompt 最多保留 3 条。');
}

const lock = readJson(join(root, 'package-lock.json'));
if (lock.version !== version || lock.packages?.['']?.version !== version) {
  fail('package-lock.json 根版本与 package.json 不一致。');
}
for (const workspace of rootManifest.workspaces) {
  if (lock.packages?.[workspace]?.version !== version) {
    fail(`package-lock.json 中 ${workspace} 的版本不一致。`);
  }
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${version}]`)) fail(`CHANGELOG.md 缺少 ${version} 条目。`);
if (/OWNER\/REPOSITORY|\[TODO[:\]]/i.test(changelog)) {
  fail('CHANGELOG.md 仍含发布占位符。');
}

const generatedFiles = ['plugins/treediagram/.mcp.json', 'plugins/treediagram/runtime.local.json'];
for (const relativePath of generatedFiles) {
  const ignored = git(['check-ignore', '-q', '--', relativePath]);
  if (ignored.status !== 0) fail(`${relativePath} 必须被 .gitignore 排除。`);
  const tracked = git(['ls-files', '--error-unmatch', '--', relativePath]);
  if (tracked.status === 0) fail(`${relativePath} 是机器相关文件，不能进入 Git。`);
}

const diffCheck = git(['diff', '--check']);
if (diffCheck.status !== 0) fail(`git diff --check 失败：${diffCheck.stdout || diffCheck.stderr}`);

if (!allowDirty) {
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.status !== 0) fail('无法读取 Git 工作区状态。');
  else if (status.stdout.trim()) fail('Git 工作区不干净；提交预期变更后再创建 release tag。');
}

if (!allowNoRemote) {
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote.status !== 0 || !remote.stdout.trim()) {
    fail('尚未配置 origin；源码发布前必须绑定目标 Git 仓库。');
  }
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 24) fail(`需要 Node.js 24+；当前为 ${process.versions.node}。`);

if (failures.length) {
  console.error('TreeDiagram release check 未通过：');
  for (const message of failures) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`TreeDiagram ${version} release metadata 检查通过。`);
}
