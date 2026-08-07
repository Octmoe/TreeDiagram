import { createHash } from 'node:crypto';
import type {
  ProjectId,
  SourceAsset,
  SourceAssetMeta,
  SourceKind,
} from '@treediagram/contracts';
import type { Clock } from '../clock.js';
import { DomainError } from '../errors.js';
import type { DatabaseContext } from '../db/database.js';
import { newId } from '../ids.js';
import type { SourceAssetId } from '@treediagram/contracts';
import type { Author } from './types.js';

export interface AddSourceInput {
  kind: SourceKind;
  originalName: string | null;
  mediaType: string;
  contentText: string;
}

export class SourceService {
  constructor(
    private readonly db: DatabaseContext,
    private readonly clock: Clock,
    private readonly maxSourceBytes: number,
  ) {}

  addSource(projectId: ProjectId, input: AddSourceInput, author: Author): SourceAsset {
    const bytes = Buffer.byteLength(input.contentText, 'utf8');
    if (bytes > this.maxSourceBytes) {
      throw new DomainError('VALIDATION_FAILED', 'source 超出大小上限', {
        bytes,
        maxSourceBytes: this.maxSourceBytes,
      });
    }
    const asset: SourceAsset = {
      id: newId<SourceAssetId>(),
      projectId,
      kind: input.kind,
      originalName: input.originalName,
      mediaType: input.mediaType,
      contentText: input.contentText,
      sha256: createHash('sha256').update(input.contentText, 'utf8').digest('hex'),
      authorKind: author.kind,
      authorRef: author.ref,
      createdAt: this.clock.now(),
    };
    this.db.repos.sourceAsset.insert(asset);
    return asset;
  }

  getSource(id: string): SourceAsset {
    const asset = this.db.repos.sourceAsset.getById(id);
    if (!asset) {
      throw new DomainError('NOT_FOUND', 'source 不存在', { id });
    }
    return asset;
  }

  listSources(projectId: ProjectId): SourceAssetMeta[] {
    return this.db.repos.sourceAsset.listByProject(projectId);
  }
}
