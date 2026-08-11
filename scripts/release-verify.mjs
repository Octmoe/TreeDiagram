#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const npmExecPath = process.env['npm_execpath'];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['scripts/release-check.mjs', '--allow-dirty', '--allow-no-remote']);
for (const script of ['format:check', 'typecheck', 'test', 'build', 'test:e2e', 'audit:prod']) {
  if (npmExecPath && existsSync(npmExecPath)) run(process.execPath, [npmExecPath, 'run', script]);
  else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script]);
}

console.log('TreeDiagram 完整发布验证通过。');
