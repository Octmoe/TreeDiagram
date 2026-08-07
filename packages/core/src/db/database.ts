import Database from 'better-sqlite3';
import { Type } from '@sinclair/typebox';
import type { Clock } from '../clock.js';
import { runMigrations } from './migrate.js';
import { parseJsonColumn } from './row-mappers.js';
import { ProjectRepository } from './repositories/project.js';
import { SourceAssetRepository } from './repositories/source-asset.js';
import { NodeRepository } from './repositories/node.js';
import { RelationRepository } from './repositories/relation.js';
import { ChangeSetRepository } from './repositories/change-set.js';
import { ReleaseRepository } from './repositories/release.js';
import { DelegationRepository } from './repositories/delegation.js';
import { WorkflowRunRepository } from './repositories/workflow-run.js';
import { ReviewItemRepository } from './repositories/review-item.js';
import { EventRepository } from './repositories/event.js';

export interface Repositories {
  project: ProjectRepository;
  sourceAsset: SourceAssetRepository;
  node: NodeRepository;
  relation: RelationRepository;
  changeSet: ChangeSetRepository;
  release: ReleaseRepository;
  delegation: DelegationRepository;
  workflowRun: WorkflowRunRepository;
  reviewItem: ReviewItemRepository;
  event: EventRepository;
}

const IdArraySchema = Type.Array(Type.String());

/**
 * DatabaseContext：唯一持有 better-sqlite3 实例的位置（IMPLEMENTATION_DESIGN §6.1）。
 * service 只能通过 repositories 与 transaction 访问数据库。
 */
export class DatabaseContext {
  private readonly db: Database.Database;
  readonly repos: Repositories;

  constructor(dbPath: string, clock: Clock) {
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    runMigrations(this.db, clock.now());

    const parseIds = (raw: string, ctx: string) => parseJsonColumn(IdArraySchema, raw, ctx);
    this.repos = {
      project: new ProjectRepository(this.db),
      sourceAsset: new SourceAssetRepository(this.db),
      node: new NodeRepository(this.db),
      relation: new RelationRepository(this.db),
      changeSet: new ChangeSetRepository(this.db),
      release: new ReleaseRepository(this.db, parseIds),
      delegation: new DelegationRepository(this.db),
      workflowRun: new WorkflowRunRepository(this.db),
      reviewItem: new ReviewItemRepository(this.db),
      event: new EventRepository(this.db),
    };
  }

  /** 当前已应用的最高 schema 版本。 */
  schemaVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
      v: number | null;
    };
    return row.v ?? 0;
  }

  /** 单事务执行；任何抛错整体回滚。 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
