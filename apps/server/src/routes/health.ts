import type { AppInstance } from '../types.js';
import { HealthResponseSchema, type HealthResponse } from '@treediagram/contracts';
import { VERSION } from '../version.js';

export function registerHealthRoutes(app: AppInstance): void {
  app.get(
    '/api/v1/health',
    { schema: { response: { 200: HealthResponseSchema } } },
    async (): Promise<HealthResponse> => ({ ok: true, version: VERSION }),
  );
}
