import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface RuntimeResult {
  projectRoot: string;
  workspace: { workspaceId: string };
  sidecar: { pid: number | null; port: number; url: string; reused: boolean };
}

interface PluginRuntime {
  ensureProject(options: { projectRoot: string; runtimeRoot: string }): Promise<RuntimeResult>;
  hasWorkspace(projectRoot: string): boolean;
  openExistingProject(options: {
    projectRoot: string;
    runtimeRoot: string;
    openBrowser: boolean;
  }): Promise<RuntimeResult & { url: string; browser: { opened: boolean } }>;
  sidecarStatus(projectRoot: string): Promise<{ running: boolean }>;
  stopSidecar(projectRoot: string): Promise<{ stopped: boolean }>;
}

const repoRoot = resolve(import.meta.dirname, '../../..');
// @ts-expect-error The plugin runtime is intentionally distributed as plain ESM JavaScript.
const runtime = (await import('../../../plugins/treediagram/scripts/runtime.mjs')) as PluginRuntime;
// @ts-expect-error The local plugin config builder is intentionally plain ESM JavaScript.
const { createLocalMcpManifest } = (await import('../../../scripts/local-plugin-config.mjs')) as {
  createLocalMcpManifest(
    pluginRoot: string,
    nodeExecutable?: string,
  ): {
    mcpServers: {
      treediagram: {
        command: string;
        args: string[];
        startup_timeout_sec: number;
        tool_timeout_sec: number;
      };
    };
  };
};
const projectRoots: string[] = [];

afterEach(async () => {
  for (const projectRoot of projectRoots) {
    try {
      await runtime.stopSidecar(projectRoot);
    } catch {
      /* The assertion failure may have happened before a Sidecar was created. */
    }
    rmSync(projectRoot, { recursive: true, force: true });
  }
  projectRoots.length = 0;
});

describe('Codex plugin project binding', () => {
  it('generates an absolute bundled MCP launcher for the local Codex install', () => {
    const pluginRoot = join(repoRoot, 'plugins', 'treediagram');
    const config = createLocalMcpManifest(pluginRoot);

    expect(config.mcpServers.treediagram).toEqual(
      expect.objectContaining({
        command: process.execPath,
        args: [join(pluginRoot, 'scripts', 'mcp-server.mjs')],
      }),
    );
  });

  it('initializes, isolates, and reuses one Sidecar per project', async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'treediagram-plugin-a-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'treediagram-plugin-b-'));
    projectRoots.push(firstRoot, secondRoot);

    const first = await runtime.ensureProject({ projectRoot: firstRoot, runtimeRoot: repoRoot });
    const second = await runtime.ensureProject({ projectRoot: secondRoot, runtimeRoot: repoRoot });
    const reused = await runtime.ensureProject({ projectRoot: firstRoot, runtimeRoot: repoRoot });

    expect(first.workspace.workspaceId).not.toBe(second.workspace.workspaceId);
    expect(first.sidecar.port).not.toBe(second.sidecar.port);
    expect(reused.sidecar.port).toBe(first.sidecar.port);
    expect(reused.sidecar.pid).toBe(first.sidecar.pid);
    expect(reused.sidecar.reused).toBe(true);
    expect((await runtime.sidecarStatus(firstRoot)).running).toBe(true);
    expect((await runtime.sidecarStatus(secondRoot)).running).toBe(true);

    for (const projectRoot of projectRoots) {
      const stateDir = join(projectRoot, '.treediagram');
      expect(existsSync(join(stateDir, 'state-v2.sqlite'))).toBe(true);
      expect(existsSync(join(stateDir, 'sidecar.json'))).toBe(true);
      const sidecar = JSON.parse(readFileSync(join(stateDir, 'sidecar.json'), 'utf8')) as {
        projectRoot: string;
      };
      expect(sidecar.projectRoot).toBe(realpathSync.native(projectRoot));
    }
  });

  it('stops only on explicit request and preserves the workspace for a later restart', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'treediagram-plugin-lifecycle-'));
    projectRoots.push(projectRoot);

    const started = await runtime.ensureProject({ projectRoot, runtimeRoot: repoRoot });
    const stopped = await runtime.stopSidecar(projectRoot);
    const afterStop = await runtime.sidecarStatus(projectRoot);

    expect(stopped.stopped).toBe(true);
    expect(afterStop.running).toBe(false);
    expect(existsSync(join(projectRoot, '.treediagram', 'workspace.json'))).toBe(true);
    expect(existsSync(join(projectRoot, '.treediagram', 'sidecar.json'))).toBe(false);

    const restarted = await runtime.ensureProject({ projectRoot, runtimeRoot: repoRoot });
    expect(restarted.workspace.workspaceId).toBe(started.workspace.workspaceId);
    expect(restarted.sidecar.reused).toBe(false);
    expect((await runtime.sidecarStatus(projectRoot)).running).toBe(true);
  });

  it('opens an existing design tree without an Agent session and cold-starts its Sidecar', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'treediagram-human-open-'));
    projectRoots.push(projectRoot);

    await runtime.ensureProject({ projectRoot, runtimeRoot: repoRoot });
    await runtime.stopSidecar(projectRoot);

    const opened = await runtime.openExistingProject({
      projectRoot,
      runtimeRoot: repoRoot,
      openBrowser: false,
    });

    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?host=codex$/);
    expect(opened.browser.opened).toBe(false);
    expect((await runtime.sidecarStatus(projectRoot)).running).toBe(true);
  });

  it('does not create a workspace when the human launcher points at the wrong directory', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'treediagram-human-missing-'));
    projectRoots.push(projectRoot);

    expect(runtime.hasWorkspace(projectRoot)).toBe(false);
    await expect(
      runtime.openExistingProject({
        projectRoot,
        runtimeRoot: repoRoot,
        openBrowser: false,
      }),
    ).rejects.toThrow('未找到已有 TreeDiagram 设计树');
    expect(existsSync(join(projectRoot, '.treediagram'))).toBe(false);
  });

  it('binds the SessionStart cwd and exposes the task-scoped Sidecar URL', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'treediagram-hook-'));
    projectRoots.push(projectRoot);
    const hook = spawnSync(
      process.execPath,
      [join(repoRoot, 'plugins', 'treediagram', 'scripts', 'session-start.mjs')],
      {
        cwd: repoRoot,
        env: { ...process.env, TREEDIAGRAM_RUNTIME_ROOT: repoRoot },
        input: JSON.stringify({
          cwd: projectRoot,
          session_id: 'codex-test-session',
          hook_event_name: 'SessionStart',
        }),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain(`workspace: ${realpathSync.native(projectRoot)}`);
    expect(hook.stdout).toContain('session=codex-test-session');
    expect(hook.stdout).toContain('hostSessionRef 使用: codex-test-session');
    expect((await runtime.sidecarStatus(projectRoot)).running).toBe(true);
  });

  it('limits automatic project recovery to task startup and resume', () => {
    const hooks = JSON.parse(
      readFileSync(join(repoRoot, 'plugins', 'treediagram', 'hooks', 'hooks.json'), 'utf8'),
    ) as { hooks: { SessionStart: Array<{ matcher?: string }> } };
    expect(hooks.hooks.SessionStart[0]?.matcher).toBe('startup|resume');
  });

  it('separates interactive Grill questioning from one-shot Check findings', () => {
    const skillsRoot = join(repoRoot, 'plugins', 'treediagram', 'skills');
    const grill = readFileSync(join(skillsRoot, 'treediagram-grill', 'SKILL.md'), 'utf8');
    const check = readFileSync(join(skillsRoot, 'treediagram-check', 'SKILL.md'), 'utf8');

    expect(grill).toContain('Work the decision frontier');
    expect(grill).toContain('After asking the round, wait');
    expect(grill).toContain(
      'Do not implement or write TreeDiagram changes until the user confirms',
    );
    expect(check).toContain('Run the check');
    expect(check).toContain('If the user asked only for findings, report them and do not write');
    expect(check).toContain('use treediagram-grill instead');

    const manifest = JSON.parse(
      readFileSync(
        join(repoRoot, 'plugins', 'treediagram', '.codex-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as { interface: { defaultPrompt: string[] } };
    expect(manifest.interface.defaultPrompt).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Grill me with questions'),
        expect.stringContaining('Check the currently focused'),
      ]),
    );
  });

  it('launches the plugin stdio MCP against its process cwd', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'treediagram-plugin-mcp-'));
    projectRoots.push(projectRoot);
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    env['TREEDIAGRAM_RUNTIME_ROOT'] = repoRoot;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'plugins', 'treediagram', 'scripts', 'mcp-server.mjs')],
      cwd: projectRoot,
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'plugin-binding-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const workspace = await client.callTool({ name: 'design_workspace_get', arguments: {} });
      expect(workspace.isError).not.toBe(true);
      expect(workspace.structuredContent).toEqual(expect.objectContaining({ ok: true }));
      expect((await runtime.sidecarStatus(projectRoot)).running).toBe(true);
    } finally {
      await client.close();
    }
  });
});
