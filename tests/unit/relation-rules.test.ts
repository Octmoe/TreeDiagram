import { describe, expect, it } from 'vitest';
import { validateRelationEndpointTypes } from '@treediagram/core';
import type { NodeType, RelationType } from '@treediagram/contracts';

const ANY: NodeType[] = [
  'topic',
  'claim',
  'goal',
  'constraint',
  'risk',
  'question',
  'option',
  'decision',
  'evidence',
  'validation_method',
];

function expectValid(type: RelationType, from: NodeType, to: NodeType) {
  expect(validateRelationEndpointTypes(type, from, to)).toBeNull();
}

function expectInvalid(type: RelationType, from: NodeType, to: NodeType) {
  expect(validateRelationEndpointTypes(type, from, to)).not.toBeNull();
}

describe('关系端点类型矩阵（§4.4）', () => {
  it('contains/depends_on/derived_from 任意端点', () => {
    for (const type of ['contains', 'depends_on', 'derived_from'] as const) {
      for (const from of ANY) {
        for (const to of ANY) {
          expectValid(type, from, to);
        }
      }
    }
  });

  it('supports: evidence -> claim/constraint/risk', () => {
    expectValid('supports', 'evidence', 'claim');
    expectValid('supports', 'evidence', 'constraint');
    expectValid('supports', 'evidence', 'risk');
    expectInvalid('supports', 'claim', 'claim');
    expectInvalid('supports', 'evidence', 'topic');
    expectInvalid('supports', 'evidence', 'evidence');
  });

  it('contradicts: 两端非 topic', () => {
    expectValid('contradicts', 'claim', 'risk');
    expectInvalid('contradicts', 'topic', 'claim');
    expectInvalid('contradicts', 'claim', 'topic');
  });

  it('constrains: constraint -> 非 evidence', () => {
    expectValid('constrains', 'constraint', 'goal');
    expectInvalid('constrains', 'claim', 'goal');
    expectInvalid('constrains', 'constraint', 'evidence');
  });

  it('addresses: option/decision/validation_method -> question', () => {
    expectValid('addresses', 'option', 'question');
    expectValid('addresses', 'decision', 'question');
    expectValid('addresses', 'validation_method', 'question');
    expectInvalid('addresses', 'claim', 'question');
    expectInvalid('addresses', 'option', 'claim');
  });

  it('selects/rejects: decision -> option', () => {
    expectValid('selects', 'decision', 'option');
    expectValid('rejects', 'decision', 'option');
    expectInvalid('selects', 'option', 'decision');
    expectInvalid('rejects', 'decision', 'claim');
  });

  it('supersedes: 同类端点', () => {
    expectValid('supersedes', 'claim', 'claim');
    expectInvalid('supersedes', 'claim', 'goal');
  });
});
