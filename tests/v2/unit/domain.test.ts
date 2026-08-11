import { describe, expect, it } from 'vitest';
import type { NodeDetail, RelationDetail } from '@treediagram/contracts';
import {
  checkConsistency,
  DomainError,
  impactClosure,
  stableDigest,
  validateChangePayload,
} from '@treediagram/domain';

const node = (
  id: string,
  roles: string[] = [],
  overrides: Partial<NodeDetail['revision']> = {},
): NodeDetail => ({
  node: {
    id,
    nodeType: id === 'root-node' ? 'goal' : 'claim',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  revision: {
    id: `${id}-revision`,
    nodeId: id,
    revisionNumber: 1,
    displayTitle: id,
    contentText: '',
    roles,
    attributes: {},
    approvalState: id === 'root-node' ? 'user_confirmed' : 'tentative',
    epistemicState: null,
    reviewState: 'clean',
    supersedesRevisionId: null,
    createdInChangeSetId: 'changeset-1',
    authorKind: 'agent',
    authorRef: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  },
  view: 'working',
});

const relation = (
  id: string,
  source: string,
  target: string,
  type: RelationDetail['relation']['relationType'] = 'contains',
): RelationDetail => ({
  relation: {
    id,
    relationType: type,
    sourceNodeId: source,
    targetNodeId: target,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  revision: {
    id: `${id}-revision`,
    relationId: id,
    revisionNumber: 1,
    rationale: '',
    reviewState: 'clean',
    supersedesRevisionId: null,
    createdInChangeSetId: 'changeset-1',
    authorKind: 'agent',
    authorRef: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  view: 'working',
});

describe('V2 domain contracts', () => {
  it('returns a field-level recoverable error for malformed proposal payloads', () => {
    expect(() => validateChangePayload('create_node', { nodeType: 'goal' })).toThrow(DomainError);
    try {
      validateChangePayload('create_node', { nodeType: 'goal' });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const value = error as DomainError;
      expect(value.category).toBe('agent_recoverable');
      expect(value.path).toMatch(/^\/payload/);
      expect(value.retryable).toBe(true);
      expect(value.suggestedAction).toContain('重试');
    }
  });

  it('detects contains cycles and multiple parents deterministically', () => {
    const nodes = [node('root-node', ['root']), node('child-a'), node('child-b')];
    const result = checkConsistency(nodes, [
      relation('rel-1', 'root-node', 'child-a'),
      relation('rel-2', 'child-a', 'child-b'),
      relation('rel-3', 'child-b', 'child-a'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['CONTAINS_CYCLE', 'CONTAINS_MULTIPLE_PARENTS']),
    );
  });

  it('requires evidence for supported claims', () => {
    const result = checkConsistency(
      [node('root-node', ['root']), node('claim-a', [], { epistemicState: 'supported' })],
      [relation('rel-1', 'root-node', 'claim-a')],
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SUPPORTED_WITHOUT_EVIDENCE', entityId: 'claim-a' }),
    );
  });

  it('blocks non-root nodes that are not attached to the contains tree', () => {
    const result = checkConsistency([node('root-node', ['root']), node('orphan-node')], []);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'CONTAINS_PARENT_MISSING', entityId: 'orphan-node' }),
    );
  });

  it('computes stable digests independent of object key order', () => {
    expect(stableDigest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableDigest({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('computes the deterministic semantic impact closure', () => {
    const relations = [
      relation('r-1', 'a', 'b', 'depends_on'),
      relation('r-2', 'b', 'c', 'supports'),
      relation('r-3', 'c', 'd', 'contains'),
    ];
    expect(new Set(impactClosure(['a'], relations))).toEqual(new Set(['a', 'b', 'c']));
  });
});
