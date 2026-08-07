import type { Release } from '@treediagram/contracts';
import type { ReleaseId } from '@treediagram/contracts';
import { DomainError } from '../errors.js';
import { newId } from '../ids.js';
import type { ServiceContext, Author } from './types.js';
import { ChangeSetService } from './change-set-service.js';
import type { ProjectRecord } from '../db/repositories/project.js';
import { assertChangeSetTransition, nextProjectState } from '../domain/state-rules.js';
import { checkConsistency } from '../domain/consistency-checker.js';

/**
 * Release 发布（IMPLEMENTATION_DESIGN §7.5）：原子事务写 Release manifest、
 * project 状态、ChangeSet 状态与 release.published 事件。不物理删除候选或历史修订。
 */
export class ReleaseService {
  private readonly changeSets: ChangeSetService;

  constructor(private readonly ctx: ServiceContext) {
    this.changeSets = new ChangeSetService(ctx);
  }

  private get db() {
    return this.ctx.db;
  }
  private get clock() {
    return this.ctx.clock;
  }

  publish(project: ProjectRecord, changeSetId: string, summary: string, author: Author): Release {
    return this.db.transaction(() => {
      const changeSet = this.changeSets.require(changeSetId);
      if (changeSet.status !== 'ready') {
        throw new DomainError('INVALID_STATE_TRANSITION', '只有 ready 状态的 ChangeSet 可以发布', {
          status: changeSet.status,
        });
      }
      if (project.status !== 'reevaluating') {
        throw new DomainError('INVALID_STATE_TRANSITION', `project 状态 ${project.status} 不允许发布`, {
          status: project.status,
        });
      }
      if (summary.trim().length === 0) {
        throw new DomainError('VALIDATION_FAILED', '发布摘要不能为空');
      }

      const counts = this.db.repos.reviewItem.countsByChangeSet(changeSet.id);
      if (counts.pending > 0 || counts.blocked > 0) {
        throw new DomainError('DESIGN_INCONSISTENT', '仍存在未完成的复核项', {
          pending: counts.pending,
          blocked: counts.blocked,
        });
      }

      const { working } = this.changeSets.buildViews(changeSet);
      const policies = this.db.repos.delegation.listActiveByProject(project.id);
      const issues = checkConsistency({
        workingSet: working,
        reviewCounts: { pending: 0, blocked: 0 },
        policies,
      });
      const blocking = issues.filter((i) => i.severity === 'blocking');
      if (blocking.length > 0) {
        throw new DomainError('DESIGN_INCONSISTENT', '一致性闸门未通过，禁止发布', {
          blocking: blocking.map((i) => ({ code: i.code, entityRevisionId: i.entityRevisionId, message: i.message })),
        });
      }

      const rootRevisionIds = [...working.nodeRevisionByNodeId.values()]
        .filter((r) => r.roles.includes('root'))
        .map((r) => r.id);
      const now = this.clock.now();
      const release: Release = {
        id: newId<ReleaseId>(),
        projectId: project.id,
        version: this.db.repos.release.nextVersion(project.id),
        rootRevisionIds,
        nodeRevisionIds: [...working.nodeRevisionByNodeId.values()].map((r) => r.id),
        relationRevisionIds: [...working.relationRevisionByRelationId.values()].map((r) => r.id),
        summary,
        authorKind: author.kind,
        authorRef: author.ref,
        createdAt: now,
      };
      this.db.repos.release.insert(release);

      nextProjectState(project.status, 'publish');
      this.db.repos.project.setCurrentRelease(project.id, release.id, now);
      this.db.repos.project.updateStatus(project.id, 'consistent', null, now);

      assertChangeSetTransition(changeSet.status, 'published');
      this.db.repos.changeSet.updateStatus(changeSet.id, 'published', now, {
        publishedReleaseId: release.id,
      });

      this.db.repos.event.append(
        project.id,
        'release.published',
        { releaseId: release.id, version: release.version, changeSetId: changeSet.id, summary },
        now,
      );
      return release;
    });
  }

  getCurrentRelease(project: ProjectRecord): Release {
    if (!project.currentReleaseId) {
      throw new DomainError('DESIGN_NOT_INITIALIZED', '尚未发布任何 Release');
    }
    const release = this.db.repos.release.getById(project.currentReleaseId);
    if (!release) {
      throw new DomainError('CORRUPT_PERSISTED_DATA', 'current Release 记录缺失', {
        releaseId: project.currentReleaseId,
      });
    }
    return release;
  }
}
