import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from './types.js';

/**
 * 静态 UI shell 托管（API_CONTRACT §2.1）：loopback 下无 token 可加载；
 * SPA fallback 到 index.html。只服务 apps/web/dist 产物，防路径穿越。
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 默认 web 产物目录：apps/server/dist/* → apps/web/dist。 */
export function defaultWebDistDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '../../web/dist');
}

export interface StaticUi {
  available: boolean;
  handle(request: FastifyRequest, reply: FastifyReply): boolean;
}

export function createStaticUi(webDistDir: string = defaultWebDistDir()): StaticUi {
  const root = resolve(webDistDir);
  if (!existsSync(root)) {
    return { available: false, handle: () => false };
  }

  const serve = (pathname: string, reply: FastifyReply): boolean => {
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const abs = resolve(join(root, rel));
    if (abs !== root && !abs.startsWith(root + sep)) return false; // 防穿越
    if (!existsSync(abs) || !statSync(abs).isFile()) return false;
    const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const body = readFileSync(abs);
    // 静态资源带内容哈希缓存；html 不缓存
    if (type.startsWith('text/html')) {
      reply.header('cache-control', 'no-cache');
    } else {
      const etag = createHash('sha256').update(body).digest('hex').slice(0, 16);
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      reply.header('etag', etag);
    }
    void reply.type(type).send(body);
    return true;
  };

  return {
    available: true,
    handle(request, reply) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return false;
      const pathname = (request.raw.url ?? '/').split('?')[0] ?? '/';
      if (pathname.startsWith('/api/')) return false;
      if (pathname !== '/' && serve(pathname, reply)) return true;
      return serve('index.html', reply); // SPA fallback
    },
  };
}

/** 唯一 404 处理器：非 /api 路径先尝试静态 UI（SPA fallback），否则 JSON 404。 */
export function registerNotFound(app: AppInstance, ui: StaticUi): void {
  app.setNotFoundHandler((request, reply) => {
    if (ui.handle(request, reply)) return;
    const requestId = request.requestId ?? 'unknown';
    void reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: '路由不存在', details: {}, requestId } });
  });
}

export function registerStaticUi(app: AppInstance, webDistDir?: string): StaticUi {
  const ui = createStaticUi(webDistDir ?? defaultWebDistDir());
  registerNotFound(app, ui);
  return ui;
}
