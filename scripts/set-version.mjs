#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = process.argv[2];
const releaseVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (!version || !releaseVersionPattern.test(version)) {
  throw new Error(
    '请提供不含 build metadata 的 SemVer，例如：npm run version:set -- 2.0.0-alpha.1',
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const rootManifestPath = join(root, 'package.json');
const rootManifest = readJson(rootManifestPath);
const manifestPaths = [
  rootManifestPath,
  ...rootManifest.workspaces.map((workspace) => join(root, workspace, 'package.json')),
  join(root, 'plugins', 'treediagram', '.codex-plugin', 'plugin.json'),
];

for (const path of manifestPaths) {
  const manifest = readJson(path);
  manifest.version = version;
  manifest.license = 'Apache-2.0';
  writeJson(path, manifest);
}

const npmExecPath = process.env['npm_execpath'];
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm';
const npmArgs = npmExecPath
  ? [npmExecPath, 'install', '--package-lock-only', '--ignore-scripts']
  : ['install', '--package-lock-only', '--ignore-scripts'];
const lockResult = spawnSync(npmCommand, npmArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32' && !npmExecPath,
});
if (lockResult.error) throw lockResult.error;
if (lockResult.status !== 0) {
  throw new Error('版本已写入 manifest，但 package-lock.json 更新失败。');
}

console.log(`TreeDiagram 版本已统一为 ${version}。`);
