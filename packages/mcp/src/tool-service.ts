import type {
  AttentionContext,
  ContextPackage,
  DesignChange,
  NodeDetail,
  ToolResult,
} from '@treediagram/contracts';
import { AttentionService, type AttentionIdentity } from '@treediagram/attention';
import { domainError, impactClosure, isDomainError } from '@treediagram/domain';
import type { V2Store } from '@treediagram/storage-sqlite';
import { TOOL_DEFINITIONS } from './tools.js';

type Args = Record<string, unknown>;
const ok = <T>(data: T, summary: string): ToolResult<T> => ({ ok: true, data, summary });

export class ToolService {
  readonly attention: AttentionService;
  constructor(readonly store: V2Store) {
    this.attention = new AttentionService(store);
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult<unknown>> {
    try {
      if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
        throw domainError('TOOL_NOT_FOUND', 'agent_recoverable', `未知 TreeDiagram 工具: ${name}`, {
          path: '/name',
          actual: name,
          retryable: true,
        });
      }
      const args = this.args(rawArgs);
      switch (name) {
        case 'design_workspace_get': {
          const data = this.store.getWorkspaceSummary();
          return ok(
            data,
            `${data.displayName}：${data.nodeCount} 个节点，${data.relationCount} 条关系，状态 ${data.consistency}。`,
          );
        }
        case 'design_tree_get': {
          const view = this.view(args);
          const nodes = this.store.listNodes(view);
          const relations = this.store.listRelations(view);
          const contains = relations.filter((item) => item.relation.relationType === 'contains');
          const childIds = new Set(contains.map((item) => item.relation.targetNodeId));
          const byParent = new Map<string, string[]>();
          for (const relation of contains) {
            const list = byParent.get(relation.relation.sourceNodeId) ?? [];
            list.push(relation.relation.targetNodeId);
            byParent.set(relation.relation.sourceNodeId, list);
          }
          const byId = new Map(nodes.map((node) => [node.node.id, node]));
          const build = (nodeId: string, path: Set<string>): unknown => {
            const node = byId.get(nodeId);
            if (!node) return null;
            if (path.has(nodeId)) return { ...node, children: [], cycle: true };
            const next = new Set(path);
            next.add(nodeId);
            return {
              ...node,
              children: (byParent.get(nodeId) ?? []).map((id) => build(id, next)).filter(Boolean),
            };
          };
          const roots = nodes
            .filter((node) => !childIds.has(node.node.id))
            .map((node) => build(node.node.id, new Set()));
          return ok(
            { view, roots, nodes, relations },
            `${view} 设计树包含 ${nodes.length} 个节点、${relations.length} 条关系。`,
          );
        }
        case 'design_node_get': {
          const nodeId = this.requiredString(args, 'nodeId');
          const view = this.view(args);
          const node = this.store.getNode(nodeId, view);
          const relations = this.store.getRelationsForNode(nodeId, view);
          return ok(
            { node, relations },
            `节点“${node.revision.displayTitle}”有 ${relations.length} 条直接关系。`,
          );
        }
        case 'design_query': {
          const query = this.requiredString(args, 'query');
          const view = this.view(args);
          const nodes = this.store.queryNodes(query, view, this.optionalInt(args, 'limit') ?? 50);
          return ok({ query, view, nodes }, `找到 ${nodes.length} 个匹配“${query}”的节点。`);
        }
        case 'design_relations_get': {
          const view = this.view(args);
          const nodeId = this.optionalString(args, 'nodeId');
          const relations = nodeId
            ? this.store.getRelationsForNode(nodeId, view)
            : this.store.listRelations(view);
          return ok(
            { view, nodeId: nodeId ?? null, relations },
            `读取 ${relations.length} 条关系。`,
          );
        }
        case 'design_context_get': {
          const data = this.buildContext(args);
          return ok(data, data.summary);
        }
        case 'design_changeset_get': {
          const changeSet = this.store.getChangeSet(this.optionalString(args, 'changeSetId'));
          const lease = this.store.getLease(changeSet.id);
          const hostSessionRef = this.optionalString(args, 'hostSessionRef');
          const leaseStatus = hostSessionRef
            ? this.store.getLeaseStatus(changeSet.id, hostSessionRef)
            : null;
          const pending =
            changeSet.changes?.filter((change) => change.status === 'proposed').length ?? 0;
          const handoffRequests = this.store.listPendingLeaseHandoffRequests(changeSet.id);
          const currentHandoff = hostSessionRef
            ? handoffRequests.find((request) => request.requesterHostSessionRef === hostSessionRef)
            : undefined;
          const leaseSummary =
            leaseStatus?.state === 'reclaimable'
              ? `旧 lease 可安全恢复（${leaseStatus.reason}）；当前会话可调用 changeset_begin 继续原 ChangeSet`
              : leaseStatus?.state === 'owned'
                ? '当前会话持有 lease'
                : currentHandoff
                  ? `lease 交接请求 ${currentHandoff.id} 正等待 Sidecar 用户确认`
                  : `lease ${lease?.ownerHostSessionRef ?? '缺失'}`;
          return ok(
            { changeSet, lease, leaseStatus, handoffRequests },
            `${changeSet.title} v${changeSet.version}：${pending} 个待确认候选，${leaseSummary}。`,
          );
        }
        case 'design_impact_get': {
          const nodeIds = this.stringArray(args, 'nodeIds', true);
          nodeIds.forEach((id) => this.store.getNode(id));
          const impactedNodeIds = impactClosure(nodeIds, this.store.listRelations());
          const nodes = impactedNodeIds.map((id) => this.store.getNode(id));
          return ok(
            { seedNodeIds: nodeIds, impactedNodeIds, nodes },
            `影响闭包包含 ${impactedNodeIds.length} 个节点。`,
          );
        }
        case 'attention_get': {
          const identity = this.identity(args);
          const context = this.attention.getAgentVisible(identity);
          const sharedSource =
            context && context.hostSessionRef !== identity.hostSessionRef
              ? `（来自当前项目最近操作的 Sidecar 会话 ${context.hostSessionRef}）`
              : '';
          return ok(
            context,
            context
              ? `项目 Agent 可见焦点${sharedSource}：节点 ${context.primaryNodeId ?? '未设置'}；候选 ${context.primaryChangeId ?? '未设置'}；scope ${context.scope}。`
              : '当前项目尚未建立 Agent 可见 Attention Context。',
          );
        }
        case 'attention_set': {
          const identity = this.identity(args);
          const context = this.attention.set({
            ...identity,
            ...(Object.hasOwn(args, 'primaryNodeId')
              ? { primaryNodeId: this.nullableString(args, 'primaryNodeId') }
              : {}),
            ...(Object.hasOwn(args, 'primaryChangeId')
              ? { primaryChangeId: this.nullableString(args, 'primaryChangeId') }
              : {}),
            ...(Object.hasOwn(args, 'selectedNodeIds')
              ? { selectedNodeIds: this.stringArray(args, 'selectedNodeIds') }
              : {}),
            ...(Object.hasOwn(args, 'selectedChangeIds')
              ? { selectedChangeIds: this.stringArray(args, 'selectedChangeIds') }
              : {}),
            ...(Object.hasOwn(args, 'pinnedNodeIds')
              ? { pinnedNodeIds: this.stringArray(args, 'pinnedNodeIds') }
              : {}),
            ...(Object.hasOwn(args, 'scope')
              ? { scope: this.requiredString(args, 'scope') as AttentionContext['scope'] }
              : {}),
            ...(Object.hasOwn(args, 'intentHint')
              ? { intentHint: this.nullableString(args, 'intentHint') }
              : {}),
            ...(Object.hasOwn(args, 'expectedVersion')
              ? { expectedVersion: this.requiredInt(args, 'expectedVersion') }
              : {}),
            updatedBy: 'user',
          });
          return ok(context, `Attention 已更新到 v${context.version}；选择不会修改设计。`);
        }
        case 'attention_pin': {
          const context = this.attention.pin(
            this.identity(args),
            this.stringArray(args, 'nodeIds', true),
            this.optionalInt(args, 'expectedVersion'),
          );
          return ok(context, `已固定 ${context.pinnedNodeIds.length} 个节点。`);
        }
        case 'attention_clear': {
          const context = this.attention.clear(
            this.identity(args),
            this.optionalInt(args, 'expectedVersion'),
          );
          return ok(context, `Attention 已清空并更新到 v${context.version}。`);
        }
        case 'attention_agent_focus_set': {
          const activity = this.attention.setAgentFocus({
            hostSessionRef: this.requiredString(args, 'hostSessionRef'),
            nodeIds: this.stringArray(args, 'nodeIds'),
            phase: this.requiredString(args, 'phase') as
              'reading' | 'proposing' | 'validating' | 'idle',
            summary: this.requiredString(args, 'summary'),
            complete: args['complete'] === true,
          });
          return ok(
            activity,
            `Agent 焦点已公开：${activity.phase}，${activity.nodeIds.length} 个节点。`,
          );
        }
        case 'changeset_begin': {
          const result = this.store.beginChangeSet(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'title'),
            this.optionalString(args, 'description') ?? '',
          );
          return ok(
            result,
            result.recoveredLease
              ? `已从${result.recoveryReason === 'previous_system_boot' ? '上次系统启动' : '过期会话'}安全恢复 ChangeSet“${result.changeSet.title}”及其全部候选，version ${result.changeSet.version}。`
              : `ChangeSet“${result.changeSet.title}”已就绪，version ${result.changeSet.version}。`,
          );
        }
        case 'changeset_lease_handoff_request': {
          const request = this.store.requestLeaseHandoff(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeSetId'),
            this.requiredString(args, 'purpose'),
          );
          return ok(
            request,
            `已向 Sidecar 发起写入权交接请求 ${request.id}；等待用户点击“交给此 Agent”后重新读取 ChangeSet。`,
          );
        }
        case 'design_change_propose': {
          const input = {
            hostSessionRef: this.requiredString(args, 'hostSessionRef'),
            changeSetId: this.requiredString(args, 'changeSetId'),
            expectedChangeSetVersion: this.requiredInt(args, 'expectedChangeSetVersion'),
            operation: this.requiredString(args, 'operation') as DesignChange['operation'],
            ...(this.optionalString(args, 'entityId')
              ? { entityId: this.optionalString(args, 'entityId')! }
              : {}),
            ...(this.optionalString(args, 'baseRevisionId')
              ? { baseRevisionId: this.optionalString(args, 'baseRevisionId')! }
              : {}),
            payload: this.record(args, 'payload'),
            summary: this.requiredString(args, 'summary'),
          };
          const result = this.store.proposeChange(input);
          return ok(result, `候选已提出：${result.change.summary}。等待用户检查，不会自动采用。`);
        }
        case 'design_change_revise': {
          const result = this.store.reviseProposedChange(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeId'),
            this.requiredInt(args, 'expectedChangeSetVersion'),
            this.record(args, 'payload'),
            this.requiredString(args, 'summary'),
          );
          return ok(result, `候选已修订：${result.change.summary}。`);
        }
        case 'design_change_discard': {
          const result = this.store.discardChange(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeId'),
            this.requiredInt(args, 'expectedChangeSetVersion'),
          );
          return ok(result, `候选已丢弃；ChangeSet 当前 version ${result.version}。`);
        }
        case 'changeset_validate': {
          const result = this.store.validateChangeSet(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeSetId'),
            this.requiredInt(args, 'expectedChangeSetVersion'),
          );
          return ok(
            result,
            result.validation.valid
              ? 'Working State 通过确定性一致性检查，可以请求发布授权。'
              : `校验发现 ${result.validation.issues.length} 个问题。`,
          );
        }
        case 'changeset_adopt': {
          const result = this.store.adoptChange(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeId'),
            this.requiredString(args, 'approvalToken'),
          );
          return ok(
            result,
            result.adoptedChanges.length > 1
              ? `子节点及其 contains 挂载已原子采用到 Working State：${result.change.summary}。`
              : `候选已采用到 Working State：${result.change.summary}。`,
          );
        }
        case 'design_release_publish': {
          const release = this.store.publishRelease(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeSetId'),
            this.requiredString(args, 'approvalToken'),
            this.optionalString(args, 'summary') ?? 'Published from TreeDiagram',
          );
          return ok(release, `Release v${release.version} 已发布。`);
        }
        case 'design_root_change_confirm': {
          const result = this.store.confirmRoot(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'nodeId'),
            this.requiredString(args, 'approvalToken'),
          );
          return ok(result, `根节点“${result.node.revision.displayTitle}”已由用户确认。`);
        }
        case 'delegation_policy_set': {
          const mode = this.requiredString(args, 'mode') as 'human_final' | 'agent_managed';
          this.store.setDelegationPolicy(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'nodeId'),
            mode,
            this.optionalString(args, 'approvalToken'),
          );
          return ok({ mode }, `托管策略已设为 ${mode}。`);
        }
        case 'changeset_lease_takeover': {
          const lease = this.store.takeLease(
            this.requiredString(args, 'hostSessionRef'),
            this.requiredString(args, 'changeSetId'),
            this.requiredString(args, 'approvalToken'),
          );
          return ok(lease, `写入 lease 已由 ${lease.ownerHostSessionRef} 接管。`);
        }
        default:
          throw domainError('TOOL_NOT_FOUND', 'agent_recoverable', `未知工具: ${name}`, {
            retryable: true,
          });
      }
    } catch (error) {
      if (isDomainError(error)) return { ok: false, error: error.toToolError() };
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          category: 'infrastructure_failure',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          suggestedAction: '稍后重试；若持续发生，请检查 Sidecar 日志。',
        },
      };
    }
  }

  private buildContext(args: Args): ContextPackage {
    let attention: AttentionContext | null = null;
    let requestedAttentionIdentity: AttentionIdentity | null = null;
    if (
      typeof args['hostKind'] === 'string' &&
      typeof args['hostSessionRef'] === 'string' &&
      typeof args['clientRef'] === 'string'
    ) {
      requestedAttentionIdentity = this.identity(args);
      attention = this.attention.getAgentVisible(requestedAttentionIdentity);
    }
    const changeSet = (() => {
      try {
        return this.store.getChangeSet();
      } catch {
        return null;
      }
    })();
    const selectedChangeIds = new Set(
      [attention?.primaryChangeId, ...(attention?.selectedChangeIds ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
    );
    const selectedChanges = (changeSet?.changes ?? []).filter((change) =>
      selectedChangeIds.has(change.id),
    );
    const explicit = Object.hasOwn(args, 'nodeIds') ? this.stringArray(args, 'nodeIds') : [];
    const focusIds = [
      ...new Set(
        explicit.length
          ? explicit
          : [attention?.primaryNodeId, ...(attention?.selectedNodeIds ?? [])].filter(
              (id): id is string => Boolean(id),
            ),
      ),
    ];
    const pinnedIds = attention?.pinnedNodeIds ?? [];
    const focus = focusIds.map((id) => this.store.getNode(id));
    const pinned = pinnedIds
      .filter((id) => !focusIds.includes(id))
      .map((id) => this.store.getNode(id));
    const relations = this.store.listRelations();
    const nodes = this.store.listNodes();
    const byId = new Map(nodes.map((node) => [node.node.id, node]));
    const parents = new Map(
      relations
        .filter((item) => item.relation.relationType === 'contains')
        .map((item) => [item.relation.targetNodeId, item.relation.sourceNodeId]),
    );
    const pathIds: string[] = [];
    for (const id of focusIds) {
      let cursor: string | undefined = id;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        pathIds.unshift(cursor);
        cursor = parents.get(cursor);
      }
    }
    const rootPath = [...new Set(pathIds)]
      .filter((id) => !focusIds.includes(id))
      .map((id) => byId.get(id))
      .filter((item): item is NodeDetail => Boolean(item));
    const relevantRelationIds = new Set([...focusIds, ...pinnedIds]);
    const related = relations.filter(
      (item) =>
        relevantRelationIds.has(item.relation.sourceNodeId) ||
        relevantRelationIds.has(item.relation.targetNodeId),
    );
    const relevantIds = new Set(
      related.flatMap((item) => [item.relation.sourceNodeId, item.relation.targetNodeId]),
    );
    const relevant = nodes.filter(
      (item) =>
        relevantIds.has(item.node.id) &&
        !focusIds.includes(item.node.id) &&
        !pinnedIds.includes(item.node.id) &&
        !rootPath.some((path) => path.node.id === item.node.id),
    );
    const pendingChanges = (changeSet?.changes ?? []).filter(
      (change) =>
        change.status === 'proposed' &&
        (selectedChangeIds.has(change.id) ||
          focusIds.includes(change.entityId) ||
          this.changeTouches(change, focusIds)),
    );
    const maxTokens = this.optionalInt(args, 'maxTokens') ?? 4000;
    let packageValue: ContextPackage = {
      attention,
      focus,
      selectedChanges,
      rootPath,
      pinned,
      related,
      relevant,
      pendingChanges,
      truncated: false,
      estimatedTokens: 0,
      summary: '',
    };
    const estimate = () => Math.ceil(JSON.stringify(packageValue).length / 4);
    while (estimate() > maxTokens && packageValue.relevant.length > 0) {
      packageValue.relevant.pop();
      packageValue.truncated = true;
    }
    while (estimate() > maxTokens && packageValue.related.length > 0) {
      packageValue.related.pop();
      packageValue.truncated = true;
    }
    packageValue.estimatedTokens = estimate();
    const focusLabels = focus.map((item) => `节点“${item.revision.displayTitle}”`);
    const changeLabels = selectedChanges.map(
      (change) =>
        `候选“${String(change.payload['displayTitle'] ?? change.summary)}” (${change.operation})`,
    );
    packageValue.summary =
      focusLabels.length || changeLabels.length
        ? `用户的项目 Agent 可见焦点${attention && requestedAttentionIdentity && attention.hostSessionRef !== requestedAttentionIdentity.hostSessionRef ? `（来自最近操作的 Sidecar 会话 ${attention.hostSessionRef}）` : ''}：${[...focusLabels, ...changeLabels].join('、')}；含 ${related.length} 条关系与 ${pendingChanges.length} 个相关候选${packageValue.truncated ? '，已按预算截断' : ''}。`
        : '当前没有 Agent 可见焦点；请让用户在 Sidecar 选择节点或候选，或显式传入 nodeIds。';
    return packageValue;
  }

  private changeTouches(change: DesignChange, nodeIds: string[]): boolean {
    const source = change.payload['sourceNodeId'];
    const target = change.payload['targetNodeId'];
    return (
      (typeof source === 'string' && nodeIds.includes(source)) ||
      (typeof target === 'string' && nodeIds.includes(target))
    );
  }

  private args(value: unknown): Args {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw domainError('INVALID_TOOL_ARGUMENTS', 'agent_recoverable', '工具参数必须是对象。', {
        path: '/',
        expected: 'object',
        actual: value,
        retryable: true,
      });
    return value as Args;
  }
  private requiredString(args: Args, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim())
      throw domainError('INVALID_TOOL_ARGUMENT', 'agent_recoverable', `${key} 必须是非空字符串。`, {
        path: `/${key}`,
        expected: 'non-empty string',
        actual: value,
        retryable: true,
      });
    return value;
  }
  private optionalString(args: Args, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.length ? value : undefined;
  }
  private nullableString(args: Args, key: string): string | null {
    const value = args[key];
    if (value === null) return null;
    return this.requiredString(args, key);
  }
  private requiredInt(args: Args, key: string): number {
    const value = args[key];
    if (!Number.isInteger(value) || Number(value) < 0)
      throw domainError('INVALID_TOOL_ARGUMENT', 'agent_recoverable', `${key} 必须是非负整数。`, {
        path: `/${key}`,
        expected: 'integer >= 0',
        actual: value,
        retryable: true,
      });
    return Number(value);
  }
  private optionalInt(args: Args, key: string): number | undefined {
    return args[key] === undefined ? undefined : this.requiredInt(args, key);
  }
  private stringArray(args: Args, key: string, required = false): string[] {
    const value = args[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
      throw domainError('INVALID_TOOL_ARGUMENT', 'agent_recoverable', `${key} 必须是字符串数组。`, {
        path: `/${key}`,
        expected: 'string[]',
        actual: value,
        retryable: true,
      });
    if (required && value.length === 0)
      throw domainError('INVALID_TOOL_ARGUMENT', 'agent_recoverable', `${key} 不能为空。`, {
        path: `/${key}`,
        expected: 'at least one item',
        actual: value,
        retryable: true,
      });
    return [...new Set(value as string[])];
  }
  private record(args: Args, key: string): Record<string, unknown> {
    const value = args[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw domainError('INVALID_TOOL_ARGUMENT', 'agent_recoverable', `${key} 必须是对象。`, {
        path: `/${key}`,
        expected: 'object',
        actual: value,
        retryable: true,
      });
    return value as Record<string, unknown>;
  }
  private identity(args: Args): AttentionIdentity {
    return {
      hostKind: this.requiredString(args, 'hostKind'),
      hostSessionRef: this.requiredString(args, 'hostSessionRef'),
      clientRef: this.requiredString(args, 'clientRef'),
    };
  }
  private view(args: Args): 'working' | 'release' {
    const value = args['view'];
    if (value === undefined || value === 'working') return 'working';
    if (value === 'release') return 'release';
    throw domainError(
      'INVALID_TOOL_ARGUMENT',
      'agent_recoverable',
      'view 必须是 working 或 release。',
      { path: '/view', expected: ['working', 'release'], actual: value, retryable: true },
    );
  }
}
