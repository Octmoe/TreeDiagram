import { describe, expect, it } from 'vitest';
import { DomainError } from '@treediagram/core';
import { classifyProviderError, extractProviderMessage } from '@treediagram/core';

/**
 * classifyProviderError / extractProviderMessage（openai-provider.ts）：
 * 4xx/5xx 错误必须把服务端返回的原始原因带入 DomainError.message 与
 * details.providerMessage（截断到 500 字符）；401/403 不回显服务端报文。
 */

function apiErrorLike(status: number, serverMessage: string): unknown {
  // 模拟 OpenAI SDK APIError：status + 解析后的 error 体 + 拼接的 message
  return {
    name: 'APIError',
    status,
    error: { message: serverMessage, type: 'invalid_request_error', code: null },
    message: `${status} {"error":{"message":"${serverMessage}"}}`,
  };
}

describe('extractProviderMessage', () => {
  it('优先取解析后的 error.message', () => {
    expect(extractProviderMessage(apiErrorLike(400, 'Model Not Exist') as never)).toBe(
      'Model Not Exist',
    );
  });

  it('error 为字符串时直接使用', () => {
    expect(extractProviderMessage({ error: 'bad request' })).toBe('bad request');
  });

  it('无 error 体时回退到 message', () => {
    expect(extractProviderMessage({ message: 'connection reset' })).toBe('connection reset');
  });

  it('空/缺失时返回 null', () => {
    expect(extractProviderMessage({})).toBeNull();
    expect(extractProviderMessage({ error: { message: '   ' } })).toBeNull();
  });

  it('超长报文截断到 500 字符并加省略号', () => {
    const long = 'x'.repeat(600);
    const result = extractProviderMessage({ error: { message: long } });
    expect(result).toHaveLength(501);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('classifyProviderError', () => {
  it('DomainError 原样透传', () => {
    const err = new DomainError('MODEL_REFUSED', '已分类', {});
    expect(classifyProviderError(err)).toBe(err);
  });

  it('400 携带服务端原因，retryable=false', () => {
    const err = classifyProviderError(apiErrorLike(400, 'Model Not Exist'));
    expect(err.code).toBe('MODEL_PROVIDER_FAILED');
    expect(err.message).toBe('provider 客户端错误（HTTP 400）: Model Not Exist');
    expect(err.details['retryable']).toBe(false);
    expect(err.details['status']).toBe(400);
    expect(err.details['providerMessage']).toBe('Model Not Exist');
  });

  it('400 且报文含 content_filter 时归为 MODEL_REFUSED', () => {
    const err = classifyProviderError(apiErrorLike(400, 'content_filter triggered'));
    expect(err.code).toBe('MODEL_REFUSED');
    expect(err.message).toContain('content_filter triggered');
  });

  it('401/403 归为 MODEL_NOT_CONFIGURED 且不回显服务端报文', () => {
    for (const status of [401, 403]) {
      const err = classifyProviderError(apiErrorLike(status, 'sk-secret-key-leak'));
      expect(err.code).toBe('MODEL_NOT_CONFIGURED');
      expect(err.message).not.toContain('sk-secret-key-leak');
      expect(err.details['providerMessage']).toBeUndefined();
    }
  });

  it('429/5xx 可重试并携带服务端原因', () => {
    for (const status of [429, 500, 503]) {
      const err = classifyProviderError(apiErrorLike(status, 'upstream overloaded'));
      expect(err.code).toBe('MODEL_PROVIDER_FAILED');
      expect(err.details['retryable']).toBe(true);
      expect(err.message).toContain('upstream overloaded');
    }
  });

  it('无 status 的网络错误视为可重试故障', () => {
    const err = classifyProviderError(new Error('fetch failed'));
    expect(err.code).toBe('MODEL_PROVIDER_FAILED');
    expect(err.message).toBe('provider 调用失败: fetch failed');
    expect(err.details['retryable']).toBe(true);
  });
});
