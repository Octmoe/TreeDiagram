import type { DomainErrorCode } from '@treediagram/contracts';

/** 统一领域错误（IMPLEMENTATION_DESIGN §15.2）。禁止抛裸字符串。 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function assertDomain(
  condition: boolean,
  code: DomainErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message, details);
  }
}
