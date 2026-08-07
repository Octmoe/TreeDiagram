import type { createApp } from './app.js';

/**
 * 本服务的 Fastify 实例类型：从工厂返回类型推导。
 * 在 exactOptionalPropertyTypes 下，手写 FastifyInstance 泛型实参与
 * Fastify() 返回的条件类型解析结果不可互相赋值，推导可彻底规避。
 */
export type AppInstance = ReturnType<typeof createApp>;
