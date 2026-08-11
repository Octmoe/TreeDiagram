import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLocalMcpManifest } from './local-plugin-config.mjs';

const runtimeRoot = resolve(import.meta.dirname, '..');
const pluginRoot = join(runtimeRoot, 'plugins', 'treediagram');
const required = [
  join(runtimeRoot, 'packages', 'mcp', 'dist', 'stdio.js'),
  join(runtimeRoot, 'apps', 'sidecar', 'dist', 'server', 'index.js'),
  join(runtimeRoot, 'apps', 'sidecar', 'dist-web', 'index.html'),
];
const missing = required.filter((path) => !existsSync(path));
if (missing.length) throw new Error(`请先构建 TreeDiagram: ${missing.join(', ')}`);

const manifest = JSON.parse(
  await import('node:fs/promises').then(({ readFile }) =>
    readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  ),
);
writeFileSync(
  join(pluginRoot, '.mcp.json'),
  `${JSON.stringify(createLocalMcpManifest(pluginRoot), null, 2)}\n`,
  'utf8',
);
writeFileSync(
  join(pluginRoot, 'runtime.local.json'),
  `${JSON.stringify(
    {
      runtimeRoot,
      pluginVersion: manifest.version,
      preparedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`TreeDiagram 本地插件运行时已准备: ${runtimeRoot}`);
