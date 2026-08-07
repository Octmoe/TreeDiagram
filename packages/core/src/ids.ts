import { randomUUID } from 'node:crypto';
import type { Brand } from '@treediagram/contracts';

/** ID 生成：crypto.randomUUID() + 品牌类型（IMPLEMENTATION_DESIGN §3.2）。 */
export function newId<T extends Brand<string, string>>(): T {
  return randomUUID() as T;
}

export function newUuid(): string {
  return randomUUID();
}
