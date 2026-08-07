import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ProjectId } from '@treediagram/contracts';
import { asId } from '@treediagram/contracts';
import type { Clock } from '../clock.js';
import { DomainError } from '../errors.js';
import { DatabaseContext } from '../db/database.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { newId } from '../ids.js';

export const WORKSPACE_DIR_NAME = '.treediagram';
export const SCHEMA_VERSION = 1;

export interface WorkspaceMeta {
  workspaceId: string;
  displayName: string;
  createdAt: string;
  schemaVersion: number;
}

export interface OpenWorkspace {
  dir: string;
  meta: WorkspaceMeta;
  db: DatabaseContext;
  project: ProjectRecord;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

/** timing-safe token 比较（§19）。 */
export function verifyToken(token: string, expectedSha256: string): boolean {
  const actual = Buffer.from(sha256Hex(token), 'utf8');
  const expected = Buffer.from(expectedSha256, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export class WorkspaceService {
  constructor(private readonly clock: Clock) {}

  /** 初始化工作区：目录、token、workspace.json、数据库与 singleton project（§7.1）。拒绝覆盖。 */
  initWorkspace(
    dir: string,
    displayName: string,
  ): { meta: WorkspaceMeta; adminToken: string; consumerToken: string } {
    const absDir = resolve(dir);
    const tdDir = join(absDir, WORKSPACE_DIR_NAME);
    if (existsSync(tdDir)) {
      throw new DomainError('INVALID_STATE_TRANSITION', '工作区已存在，拒绝覆盖', { dir: absDir });
    }
    mkdirSync(tdDir, { recursive: true });

    const adminToken = randomBytes(32).toString('base64url');
    const consumerToken = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const meta: WorkspaceMeta = {
      workspaceId: newId(),
      displayName,
      createdAt: now,
      schemaVersion: SCHEMA_VERSION,
    };

    writeFileSync(join(tdDir, 'admin-token'), adminToken + '\n', { mode: 0o600 });
    writeFileSync(join(tdDir, 'consumer-token'), consumerToken + '\n', { mode: 0o600 });
    writeFileSync(join(tdDir, 'workspace.json'), JSON.stringify(meta, null, 2) + '\n');

    const db = new DatabaseContext(join(tdDir, 'state.sqlite'), this.clock);
    try {
      const projectId = newId<ProjectId>();
      db.repos.project.insert({
        id: projectId,
        name: displayName,
        status: 'initializing',
        currentReleaseId: null,
        adminTokenSha256: hashToken(adminToken),
        consumerTokenSha256: hashToken(consumerToken),
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      db.close();
    }
    return { meta, adminToken, consumerToken };
  }

  /** 打开工作区：验证 token 文件与数据库中的 hash 一致、schema version 匹配。 */
  openWorkspace(dir: string): OpenWorkspace {
    const absDir = resolve(dir);
    const tdDir = join(absDir, WORKSPACE_DIR_NAME);
    if (!existsSync(tdDir)) {
      throw new DomainError('NOT_FOUND', '指定目录不是 TreeDiagram 工作区（缺少 .treediagram）', {
        dir: absDir,
      });
    }
    const metaRaw = readFileSync(join(tdDir, 'workspace.json'), 'utf8');
    const meta = JSON.parse(metaRaw) as WorkspaceMeta;
    if (meta.schemaVersion > SCHEMA_VERSION) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', 'workspace.json 版本高于程序支持版本', {
        schemaVersion: meta.schemaVersion,
      });
    }

    const db = new DatabaseContext(join(tdDir, 'state.sqlite'), this.clock);
    const project = db.repos.project.requireSingleton();

    const adminTokenFile = readFileSync(join(tdDir, 'admin-token'), 'utf8').trim();
    const consumerTokenFile = readFileSync(join(tdDir, 'consumer-token'), 'utf8').trim();
    if (!verifyToken(adminTokenFile, project.adminTokenSha256)) {
      db.close();
      throw new DomainError('CORRUPT_PERSISTED_DATA', 'admin-token 与数据库记录不匹配');
    }
    if (!verifyToken(consumerTokenFile, project.consumerTokenSha256)) {
      db.close();
      throw new DomainError('CORRUPT_PERSISTED_DATA', 'consumer-token 与数据库记录不匹配');
    }

    return { dir: absDir, meta, db, project };
  }
}

export function projectSummaryOf(project: ProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    currentReleaseId: project.currentReleaseId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function asProjectId(id: string): ProjectId {
  return asId<ProjectId>(id);
}
