import type { ToolError, ToolErrorCategory } from '@treediagram/contracts';

export class DomainError extends Error {
  readonly code: string;
  readonly category: ToolErrorCategory;
  readonly path?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly retryable: boolean;
  readonly suggestedAction?: string;

  constructor(error: ToolError) {
    super(error.message);
    this.name = 'DomainError';
    this.code = error.code;
    this.category = error.category;
    this.retryable = error.retryable;
    if (error.path !== undefined) this.path = error.path;
    if (error.expected !== undefined) this.expected = error.expected;
    if (error.actual !== undefined) this.actual = error.actual;
    if (error.suggestedAction !== undefined) this.suggestedAction = error.suggestedAction;
  }

  toToolError(): ToolError {
    const error: ToolError = {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.path !== undefined) error.path = this.path;
    if (this.expected !== undefined) error.expected = this.expected;
    if (this.actual !== undefined) error.actual = this.actual;
    if (this.suggestedAction !== undefined) error.suggestedAction = this.suggestedAction;
    return error;
  }
}

export const domainError = (
  code: string,
  category: ToolErrorCategory,
  message: string,
  options: Partial<
    Pick<ToolError, 'path' | 'expected' | 'actual' | 'retryable' | 'suggestedAction'>
  > = {},
): DomainError =>
  new DomainError({ code, category, message, retryable: options.retryable ?? false, ...options });

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
