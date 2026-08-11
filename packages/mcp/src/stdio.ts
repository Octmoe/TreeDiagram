#!/usr/bin/env node
import { resolve } from 'node:path';
import { V2Store } from '@treediagram/storage-sqlite';
import { runStdioServer } from './server.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceDir = resolve(
  option('workspace') ?? process.env['TREEDIAGRAM_WORKSPACE'] ?? process.cwd(),
);
const store = new V2Store(workspaceDir);
const shutdown = () => {
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await runStdioServer(store);
