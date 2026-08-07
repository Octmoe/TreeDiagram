import type { AuthorKind } from '@treediagram/contracts';
import type { Clock } from '../clock.js';
import type { DatabaseContext } from '../db/database.js';

export interface Author {
  kind: AuthorKind;
  ref: string | null;
}

export const userAuthor: Author = { kind: 'user', ref: null };

export interface ServiceContext {
  db: DatabaseContext;
  clock: Clock;
}
