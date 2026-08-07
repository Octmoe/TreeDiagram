import Fastify from 'fastify';
import type { AppInstance } from './types.js';
import { authenticate } from './auth.js';
import { BODY_LIMIT_OVERHEAD_BYTES, type ServerConfig } from './config.js';
import { currentProject, type ServerContext } from './context.js';
import { registerEnvelope } from './envelope.js';
import { registerErrorHandler } from './error-handler.js';
import { registerChangeSetRoutes } from './routes/change-set.js';
import { registerDelegationRoutes } from './routes/delegation.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerProjectRoutes } from './routes/project.js';
import { registerRelationRoutes } from './routes/relations.js';
import { registerReleaseRoutes } from './routes/release.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerTreeRoutes } from './routes/tree.js';
import { registerWorkflowRoutes } from './routes/workflows.js';

/**
 * 组装 Fastify 服务（IMPLEMENTATION_DESIGN §11、API_CONTRACT）。
 * 鉴权 preHandler 先于 schema 校验；日志 redact Authorization，只记录 pathname。
 */
/** 创建 Fastify 实例（AppInstance 类型的推导来源）。 */
export function createApp(config: ServerConfig) {
  return Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: ['req.headers.authorization'], censor: '[redacted]' },
      serializers: {
        req(request) {
          return {
            method: request.method,
            // split()[0] 在 noUncheckedIndexedAccess 下为 string|undefined，
            // 与 pino serializer 类型不兼容会破坏 Fastify http1 重载匹配
            url: request.url.split('?')[0] ?? request.url,
            requestId: request.requestId,
          };
        },
      },
    },
    bodyLimit: config.maxSourceBytes + BODY_LIMIT_OVERHEAD_BYTES,
    trustProxy: false,
  });
}

/**
 * 组装 Fastify 服务（IMPLEMENTATION_DESIGN §11、API_CONTRACT）。
 * 鉴权 preHandler 先于 schema 校验；日志 redact Authorization，只记录 pathname。
 */
export function buildServer(ctx: ServerContext): AppInstance {
  const app = createApp(ctx.config);

  registerEnvelope(app);
  registerErrorHandler(app);

  // 鉴权：/health 公开；其余 /api/v1/* 需要 Bearer token（API_CONTRACT §2）。
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/v1/')) return;
    const pathname = request.url.split('?')[0];
    if (pathname === '/api/v1/health') return;
    request.authScope = authenticate(request, currentProject(ctx));
  });

  registerHealthRoutes(app);
  registerProjectRoutes(app, ctx);
  registerSourceRoutes(app, ctx);
  registerTreeRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerRelationRoutes(app, ctx);
  registerChangeSetRoutes(app, ctx);
  registerDelegationRoutes(app, ctx);
  registerWorkflowRoutes(app, ctx);
  registerReleaseRoutes(app, ctx);

  app.addHook('onClose', async () => {
    ctx.db.close();
  });

  return app;
}
