#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { openExistingProject } from './runtime.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function chooseWindowsFolder() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择一个已有 TreeDiagram 设计树的项目目录'",
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    '  [Console]::Write($dialog.SelectedPath)',
    '}',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || '无法打开项目目录选择器。');
  }
  return result.stdout.trim();
}

function requestedWorkspace() {
  const explicit = option('workspace');
  if (explicit) return explicit;
  if (process.platform === 'win32') return chooseWindowsFolder();
  return process.cwd();
}

try {
  const projectRoot = requestedWorkspace();
  if (!projectRoot) process.exit(0);
  const result = await openExistingProject({
    projectRoot,
    openBrowser: !process.argv.includes('--no-browser'),
  });
  console.log(`TreeDiagram 已就绪: ${result.projectRoot}`);
  console.log(result.url);
} catch (error) {
  console.error(`[TreeDiagram 打开失败] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
