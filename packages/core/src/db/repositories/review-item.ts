import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import type { ReviewEntityKind, ReviewItem, ReviewItemStatus } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { parseJsonColumn, optionalRow } from '../row-mappers.js';
import { newId } from '../../ids.js';
import type { ReviewItemId } from '@treediagram/contracts';

const ResolutionSchema = Type.Record(Type.String(), Type.Unknown());

export interface ReviewItemRow {
  id: string;
  change_set_id: string;
  entity_kind: string;
  entity_revision_id: string | null;
  reason_code: string;
  status: string;
  resolution_json: string | null;
  created_at: string;
  updated_at: string;
}

export function mapReviewItemRow(row: ReviewItemRow): ReviewItem {
  const ctx = `review_item(${row.id})`;
  return {
    id: asId(row.id),
    changeSetId: asId(row.change_set_id),
    entityKind: row.entity_kind as ReviewEntityKind,
    entityRevisionId: row.entity_revision_id ? asId(row.entity_revision_id) : null,
    reasonCode: row.reason_code,
    status: row.status as ReviewItemStatus,
    resolution: row.resolution_json
      ? parseJsonColumn(ResolutionSchema, row.resolution_json, ctx)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ReviewItemRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 建立 review item。同一 (changeSet, entityKind, entityRevisionId, reasonCode) 唯一：
   * 已存在时将其重置为 pending 并清空 resolution（同一 ChangeSet 内的再次复核复用唯一行）。
   */
  ensurePending(
    changeSetId: string,
    entityKind: ReviewEntityKind,
    entityRevisionId: string | null,
    reasonCode: string,
    now: string,
  ): ReviewItem {
    const existing = optionalRow<ReviewItemRow>(
      this.db
        .prepare(
          `SELECT * FROM review_item
           WHERE change_set_id = ? AND entity_kind = ? AND COALESCE(entity_revision_id, '') = COALESCE(?, '') AND reason_code = ?`,
        )
        .get(changeSetId, entityKind, entityRevisionId, reasonCode),
    );
    if (existing) {
      if (existing.status !== 'pending') {
        this.db
          .prepare(
            "UPDATE review_item SET status = 'pending', resolution_json = NULL, updated_at = ? WHERE id = ?",
          )
          .run(now, existing.id);
      }
      return mapReviewItemRow(
        this.db.prepare('SELECT * FROM review_item WHERE id = ?').get(existing.id) as ReviewItemRow,
      );
    }
    const id = newId<ReviewItemId>();
    this.db
      .prepare(
        `INSERT INTO review_item (id, change_set_id, entity_kind, entity_revision_id, reason_code, status, resolution_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      )
      .run(id, changeSetId, entityKind, entityRevisionId, reasonCode, now, now);
    return mapReviewItemRow(
      this.db.prepare('SELECT * FROM review_item WHERE id = ?').get(id) as ReviewItemRow,
    );
  }

  getById(id: string): ReviewItem | null {
    const row = optionalRow<ReviewItemRow>(
      this.db.prepare('SELECT * FROM review_item WHERE id = ?').get(id),
    );
    return row ? mapReviewItemRow(row) : null;
  }

  listByChangeSet(changeSetId: string, statuses?: readonly ReviewItemStatus[]): ReviewItem[] {
    const rows = (
      statuses && statuses.length > 0
        ? this.db
            .prepare(
              `SELECT * FROM review_item WHERE change_set_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC`,
            )
            .all(changeSetId, ...statuses)
        : this.db
            .prepare('SELECT * FROM review_item WHERE change_set_id = ? ORDER BY created_at ASC')
            .all(changeSetId)
    ) as ReviewItemRow[];
    return rows.map(mapReviewItemRow);
  }

  countsByChangeSet(changeSetId: string): { pending: number; blocked: number; resolved: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS c FROM review_item WHERE change_set_id = ? GROUP BY status')
      .all(changeSetId) as Array<{ status: string; c: number }>;
    const counts = { pending: 0, blocked: 0, resolved: 0 };
    for (const row of rows) {
      if (row.status === 'pending') counts.pending = row.c;
      else if (row.status === 'blocked') counts.blocked = row.c;
      else if (row.status === 'resolved') counts.resolved = row.c;
    }
    return counts;
  }

  resolve(id: string, resolution: Record<string, unknown>, updatedAt: string): void {
    this.db
      .prepare("UPDATE review_item SET status = 'resolved', resolution_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(resolution), updatedAt, id);
  }

  block(id: string, resolution: Record<string, unknown>, updatedAt: string): void {
    this.db
      .prepare("UPDATE review_item SET status = 'blocked', resolution_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(resolution), updatedAt, id);
  }

  /** blocked -> pending，仅由显式 Resume/解除阻塞命令调用。 */
  unblock(id: string, updatedAt: string): void {
    this.db
      .prepare("UPDATE review_item SET status = 'pending', updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
  }
}
