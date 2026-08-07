import type { Database as SqliteDatabase } from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import type { EventRecord, EventType, ProjectId } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import { parseJsonColumn } from '../row-mappers.js';

const PayloadSchema = Type.Record(Type.String(), Type.Unknown());

export interface EventRow {
  cursor: number;
  project_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export function mapEventRow(row: EventRow): EventRecord {
  return {
    cursor: row.cursor,
    projectId: asId(row.project_id),
    eventType: row.event_type as EventType,
    payload: parseJsonColumn(PayloadSchema, row.payload_json, `event(${row.cursor})`),
    createdAt: row.created_at,
  };
}

export class EventRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(
    projectId: ProjectId,
    eventType: EventType,
    payload: Record<string, unknown>,
    createdAt: string,
  ): EventRecord {
    const result = this.db
      .prepare(
        'INSERT INTO event_outbox (project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(projectId, eventType, JSON.stringify(payload), createdAt);
    const cursor = Number(result.lastInsertRowid);
    return { cursor, projectId, eventType, payload, createdAt };
  }

  list(projectId: ProjectId, after: number, limit: number): EventRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM event_outbox WHERE project_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?',
      )
      .all(projectId, after, limit) as EventRow[];
    return rows.map(mapEventRow);
  }

  maxCursor(projectId: ProjectId): number {
    const row = this.db
      .prepare('SELECT MAX(cursor) AS c FROM event_outbox WHERE project_id = ?')
      .get(projectId) as { c: number | null };
    return row.c ?? 0;
  }
}
