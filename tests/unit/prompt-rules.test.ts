import { describe, expect, it } from 'vitest';
import { SHARED_RULES } from '@treediagram/core';

describe('Agent 共享关系端点规则', () => {
  it('把完整端点类型矩阵提供给所有工作流', () => {
    expect(SHARED_RULES).toContain('supports：from=evidence，to=claim/constraint/risk');
    expect(SHARED_RULES).toContain(
      'addresses：from=option/decision/validation_method，to=question',
    );
    expect(SHARED_RULES).toContain('selects / rejects：from=decision，to=option');
    expect(SHARED_RULES).toContain('supersedes：两端必须是相同 nodeType');
  });
});
