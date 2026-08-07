import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainError, verifyToken, type ProjectRecord } from '@treediagram/core';

export type AuthScope = 'admin' | 'consumer';

declare module 'fastify' {
  interface FastifyRequest {
    /** 鉴权结果；/health 等公开路由为 null。 */
    authScope: AuthScope | null;
    requestId: string;
  }
}

/**
 * Bearer token 鉴权（API_CONTRACT §2）：常数时间比较，admin / consumer 两种 scope。
 * 不接受 URL query token。
 */
export function authenticate(request: FastifyRequest, project: ProjectRecord): AuthScope {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new DomainError('AUTH_REQUIRED', '缺少 Bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    throw new DomainError('AUTH_REQUIRED', '缺少 Bearer token');
  }
  if (verifyToken(token, project.adminTokenSha256)) return 'admin';
  if (verifyToken(token, project.consumerTokenSha256)) return 'consumer';
  throw new DomainError('AUTH_REQUIRED', 'token 无效');
}

export function requireAdmin(request: FastifyRequest): void {
  if (request.authScope !== 'admin') {
    throw new DomainError('FORBIDDEN', '该操作需要 admin scope');
  }
}

/**
 * consumer 下游读取闸门（API_CONTRACT §3.3）：
 * initializing → 423 DESIGN_NOT_INITIALIZED；reevaluating/blocked → 423 DESIGN_NOT_CONSISTENT。
 * admin 不受限。
 */
export function assertReleaseReadGate(request: FastifyRequest, project: ProjectRecord): void {
  if (request.authScope !== 'consumer') return;
  if (project.status === 'consistent') return;
  if (project.status === 'initializing') {
    throw new DomainError('DESIGN_NOT_INITIALIZED', '设计尚未初始化完成');
  }
  throw new DomainError(
    'DESIGN_NOT_CONSISTENT',
    `设计当前状态为 ${project.status}，下游读取被锁定`,
  );
}

/** consumer 只允许 release 视图；working view / history 一律 403。 */
export function assertViewAllowed(request: FastifyRequest, view: string): void {
  if (request.authScope === 'consumer' && view !== 'release') {
    throw new DomainError('FORBIDDEN', 'consumer scope 只能读取 release 视图');
  }
}

export function sendNoContent(reply: FastifyReply): FastifyReply {
  return reply.code(204).send();
}
