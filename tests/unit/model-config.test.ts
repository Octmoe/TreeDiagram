import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createWorkflowRunner,
  loadModelConfigFile,
  loadServerConfig,
  parseModelConfigFile,
} from '@treediagram/server';

/**
 * 模型 JSON 配置文件（model-config.ts / config.ts）：
 * 路径解析、字段校验、合并优先级（配置文件 > 环境变量 > 默认值）。
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(withModelJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'treediagram-cfg-'));
  tmpDirs.push(dir);
  if (withModelJson !== undefined) {
    mkdirSync(join(dir, '.treediagram'), { recursive: true });
    writeFileSync(join(dir, '.treediagram', 'model.json'), withModelJson);
  }
  return dir;
}

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'treediagram-cfgfile-'));
  tmpDirs.push(dir);
  const path = join(dir, 'model.json');
  writeFileSync(path, content);
  return path;
}

const baseEnv = {} as NodeJS.ProcessEnv;

describe('模型配置文件解析', () => {
  it('完整字段解析', () => {
    const path = writeConfig(
      JSON.stringify({
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'my-model',
        timeoutMs: 60000,
      }),
    );
    expect(parseModelConfigFile(path)).toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'my-model',
      timeoutMs: 60000,
    });
  });

  it('非法 JSON / 未知字段 / 非法值 → 带路径的明确错误', () => {
    expect(() => parseModelConfigFile(writeConfig('not json'))).toThrowError(/不是合法 JSON/);
    expect(() => parseModelConfigFile(writeConfig('{"k":1}'))).toThrowError(/未知字段 k/);
    expect(() => parseModelConfigFile(writeConfig('{"baseUrl":"::"}'))).toThrowError(
      /baseUrl 必须是合法 URL/,
    );
    expect(() => parseModelConfigFile(writeConfig('{"timeoutMs":5}'))).toThrowError(/timeoutMs/);
    expect(() => parseModelConfigFile(writeConfig('{"provider":"azure"}'))).toThrowError(
      /provider 仅支持/,
    );
  });

  it('provider=fake 不得携带 apiKey/baseUrl；baseUrl 必须搭配 apiKey', () => {
    expect(() =>
      parseModelConfigFile(writeConfig('{"provider":"fake","apiKey":"sk"}')),
    ).toThrowError(/provider=fake/);
    expect(() => parseModelConfigFile(writeConfig('{"baseUrl":"https://x.com/v1"}'))).toThrowError(
      /必须同时提供 apiKey/,
    );
  });

  it('显式路径不存在 → 报错；默认路径不存在 → null', () => {
    const ws = makeWorkspace();
    expect(() =>
      loadModelConfigFile(ws, baseEnv, ['--model-config', join(ws, 'missing.json')]),
    ).toThrowError(/文件不可读/);
    expect(loadModelConfigFile(ws, baseEnv, [])).toBeNull();
  });

  it('默认路径 <workspace>/.treediagram/model.json 自动加载', () => {
    const ws = makeWorkspace('{"apiKey":"sk-default","model":"m1"}');
    expect(loadModelConfigFile(ws, baseEnv, [])).toEqual({ apiKey: 'sk-default', model: 'm1' });
  });

  it('路径优先级：--model-config > TREEDIAGRAM_MODEL_CONFIG > 默认路径', () => {
    const ws = makeWorkspace('{"model":"default-path"}');
    const envPath = writeConfig('{"model":"env-path"}');
    const argvPath = writeConfig('{"model":"argv-path"}');
    expect(loadModelConfigFile(ws, { TREEDIAGRAM_MODEL_CONFIG: envPath }, [])?.model).toBe(
      'env-path',
    );
    expect(
      loadModelConfigFile(ws, { TREEDIAGRAM_MODEL_CONFIG: envPath }, ['--model-config', argvPath])
        ?.model,
    ).toBe('argv-path');
  });
});

describe('ServerConfig 合并优先级（文件 > 环境变量 > 默认）', () => {
  it('文件覆盖 env；env 补足文件未设字段', () => {
    const ws = makeWorkspace(
      '{"apiKey":"sk-file","baseUrl":"https://gw.example.com/v1","model":"file-model"}',
    );
    const config = loadServerConfig(
      {
        TREEDIAGRAM_MODEL: 'env-model',
        OPENAI_API_KEY: 'sk-env',
        OPENAI_BASE_URL: 'https://env.example.com/v1',
      },
      ['--workspace', ws],
    );
    expect(config.model).toBe('file-model');
    expect(config.modelApiKey).toBe('sk-file');
    expect(config.modelBaseUrl).toBe('https://gw.example.com/v1');
    expect(config.modelTimeoutMs).toBe(300_000); // 默认值
    expect(config.modelProvider).toBeNull();
  });

  it('无文件时 env 生效；文件 provider=fake 优先于 env', () => {
    const ws1 = makeWorkspace();
    const envOnly = loadServerConfig({ OPENAI_API_KEY: 'sk-env', TREEDIAGRAM_MODEL: 'env-model' }, [
      '--workspace',
      ws1,
    ]);
    expect(envOnly.modelApiKey).toBe('sk-env');
    expect(envOnly.model).toBe('env-model');

    const ws2 = makeWorkspace('{"provider":"fake"}');
    const fakeWins = loadServerConfig(
      { TREEDIAGRAM_MODEL_PROVIDER: undefined, OPENAI_API_KEY: 'sk-env' },
      ['--workspace', ws2],
    );
    expect(fakeWins.modelProvider).toBe('fake');
  });

  it('apiKey + baseUrl 经 createWorkflowRunner 组装出 openai provider', () => {
    const ws = makeWorkspace(
      '{"apiKey":"sk-file","baseUrl":"https://gw.example.com/v1","model":"m"}',
    );
    const config = loadServerConfig({}, ['--workspace', ws]);
    // db 仅用于类型；selectProvider 不触库，传最小桩
    const { providerName, core } = createWorkflowRunner(
      null as never,
      null as never,
      config,
      'ws-id',
    );
    expect(providerName).toBe('openai');
    expect(core).not.toBeNull();
  });

  it('未配置时 providerName 为 null（unconfigured）', () => {
    const ws = makeWorkspace();
    const config = loadServerConfig({}, ['--workspace', ws]);
    const { providerName, core } = createWorkflowRunner(null as never, null as never, config, 'ws');
    expect(providerName).toBeNull();
    expect(core).toBeNull();
  });
});
