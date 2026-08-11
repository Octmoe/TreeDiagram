import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type {
  AttentionContext,
  ChangeSet,
  DesignChange,
  NodeDetail,
  RelationDetail,
} from '@treediagram/contracts';
import { getUiIdentity, SidecarApi, type BootstrapData, type UiIdentity } from './api.js';

const NODE_LABELS: Record<string, string> = {
  topic: '主题',
  claim: '主张',
  goal: '目标',
  constraint: '约束',
  risk: '风险',
  question: '问题',
  option: '选项',
  decision: '决策',
  evidence: '证据',
  validation_method: '验证',
};

const OPERATION_LABELS: Record<string, string> = {
  create_node: '新增节点',
  revise_node: '修订节点',
  remove_node: '移除节点',
  create_relation: '新增关系',
  revise_relation: '修订关系',
  remove_relation: '移除关系',
};

const RELATION_LABELS: Record<string, string> = {
  contains: '包含',
  depends_on: '依赖',
  derived_from: '派生自',
  supports: '支持',
  contradicts: '矛盾',
  violates: '违反',
  causes: '导致',
  amplifies: '加剧',
  mitigates: '缓解',
  reveals: '揭示',
  constrains: '约束',
  addresses: '回应',
  selects: '选择',
  rejects: '排除',
  supersedes: '取代',
};

const STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  tentative: '待确认',
  user_confirmed: '用户确认',
  agent_confirmed: 'Agent 确认',
  unexamined: '未检查',
  assumed: '假设',
  supported: '有支持',
  refuted: '已反驳',
  clean: '无需复核',
  required: '需要复核',
  blocked: '已阻塞',
};

const FOCUSED_SKILL_ACTIONS = [
  {
    label: 'Derive 推导',
    description: '沿当前焦点继续形成小而可审阅的候选',
    prompt: '请使用 $treediagram-derive 从当前焦点继续推导，以小而可审阅的候选节点和关系提交',
  },
  {
    label: 'Grill 追问',
    description: '分轮追问隐藏决定，在达成共识前不改设计',
    prompt:
      '请使用 $treediagram-grill 围绕当前焦点分轮追问我，澄清隐藏决定；在我确认达成共识前不要写入候选或实施',
  },
  {
    label: 'Check 审查',
    description: '一次性审查假设、矛盾、证据缺口与风险',
    prompt:
      '请使用 $treediagram-check 对当前焦点执行一次性审查，报告无依据假设、矛盾、证据缺口和未处理风险；不要修改设计',
  },
  {
    label: 'Refactor 拆分',
    description: '拆开复合节点，并对投影后的整树做交叉复核',
    prompt:
      '请使用 $treediagram-refactor 拆分当前焦点中隐含的多个独立设计点，并在提交候选前对整棵设计树执行重复、矛盾、依赖和关系归属的交叉复核',
  },
  {
    label: 'Reevaluate 影响',
    description: '在变更后重新检查影响范围并提出定向修复',
    prompt:
      '请使用 $treediagram-reevaluate 检查当前焦点的受影响范围，解释影响并提出必要的定向修复候选',
  },
] as const;

const WHOLE_TREE_REFACTOR_ACTION = {
  label: 'AI 整树拆分',
  description: '扫描整棵设计树，由 AI 拆分所有高置信复合节点并持续交叉复核',
  prompt:
    '请使用 $treediagram-refactor 对整棵 TreeDiagram 执行全量拆分：扫描全部 Working 节点与待处理候选，识别并拆分所有高置信复合节点；按父级优先的结构顺序持续提交候选，每处理一个源节点就基于更新后的投影树重新进行重复、矛盾、依赖和关系归属复核。不要受当前焦点范围限制，也不要在源节点批次之间等待；语义不明确的节点只报告，不要猜测',
} as const;

const EXISTING_DESIGN_ORGANIZE_ACTION = {
  label: 'AI 梳理已有设计',
  description: '从总体到细节分轮拆解现有复杂设计，补出推理链并标示问题关系',
  prompt:
    '请使用 $treediagram-initialize 的“已有复杂设计梳理”模式处理当前项目：先盘点现有设计材料并完成总体结构拆分，再分轮细化复合节点；对于只有结论的部分，将可验证的既有事实与推测的假设、设计动机和中间推导分开表达，并补成可审阅的候选链。最后用矛盾、违反、导致、加剧与缓解等问题关系交叉复核整棵投影树。不要把推测伪装成事实。',
} as const;

type ThemeMode = 'dark' | 'light';

function readThemePreference(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  return window.localStorage.getItem('treediagram-theme') === 'light' ? 'light' : 'dark';
}

function initials(type: string): string {
  return (
    (
      {
        goal: 'G',
        constraint: 'C',
        decision: 'D',
        evidence: 'E',
        risk: 'R',
        question: '?',
        option: 'O',
        claim: 'A',
        validation_method: 'V',
        topic: 'T',
      } as Record<string, string>
    )[type] ?? '•'
  );
}

function readableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(readableValue).join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function changeRelationDescriptor(
  change: DesignChange,
  relations: readonly RelationDetail[],
): { relationType: string; sourceNodeId: string; targetNodeId: string } | null {
  const working = relations.find((item) => item.relation.id === change.entityId)?.relation;
  const relationType =
    typeof change.payload['relationType'] === 'string'
      ? change.payload['relationType']
      : working?.relationType;
  const sourceNodeId =
    typeof change.payload['sourceNodeId'] === 'string'
      ? change.payload['sourceNodeId']
      : working?.sourceNodeId;
  const targetNodeId =
    typeof change.payload['targetNodeId'] === 'string'
      ? change.payload['targetNodeId']
      : working?.targetNodeId;
  return relationType && sourceNodeId && targetNodeId
    ? { relationType, sourceNodeId, targetNodeId }
    : null;
}

function ChangePayloadSummary({
  change,
  nodeTitles,
  relations,
}: {
  change: DesignChange;
  nodeTitles: Map<string, string>;
  relations: readonly RelationDetail[];
}) {
  const payload = change.payload;
  const fields: Array<{ label: string; value: string; wide?: boolean }> = [];
  const addField = (
    key: string,
    label: string,
    options?: { wide?: boolean; nodeRef?: boolean },
  ) => {
    const raw = payload[key];
    if (raw === undefined || raw === null || raw === '') return;
    const value = options?.nodeRef && typeof raw === 'string' ? (nodeTitles.get(raw) ?? raw) : raw;
    fields.push({ label, value: STATE_LABELS[String(value)] ?? readableValue(value), ...options });
  };

  addField('nodeType', '节点类型');
  addField('relationType', '关系类型');
  addField('approvalState', '确认状态');
  addField('epistemicState', '认知状态');
  addField('reviewState', '复核状态');
  addField('sourceNodeId', '起点', { wide: true, nodeRef: true });
  addField('targetNodeId', '终点', { wide: true, nodeRef: true });

  const contentText = typeof payload['contentText'] === 'string' ? payload['contentText'] : null;
  const rationale = typeof payload['rationale'] === 'string' ? payload['rationale'] : null;
  const roles = Array.isArray(payload['roles'])
    ? payload['roles'].filter((role): role is string => typeof role === 'string')
    : [];
  const attributes = recordValue(payload['attributes']);
  const glanceFields = fields.filter((field) => !field.wide).slice(0, 4);
  const isRemoval = change.operation === 'remove_node' || change.operation === 'remove_relation';
  const relation = changeRelationDescriptor(change, relations);

  return (
    <>
      {relation ? (
        <div className="relation-route" aria-label="关系端点">
          <span className="relation-endpoint source">
            <small>起点</small>
            <strong>{nodeTitles.get(relation.sourceNodeId) ?? relation.sourceNodeId}</strong>
          </span>
          <span className="relation-route-type">
            <b>{RELATION_LABELS[relation.relationType] ?? relation.relationType}</b>
            <i>→</i>
          </span>
          <span className="relation-endpoint target">
            <small>终点</small>
            <strong>{nodeTitles.get(relation.targetNodeId) ?? relation.targetNodeId}</strong>
          </span>
        </div>
      ) : null}
      {glanceFields.length ? (
        <div className="change-glance">
          {glanceFields.map((field) => (
            <span key={field.label}>
              <b>{field.label}</b>
              {field.label === '节点类型' ? (NODE_LABELS[field.value] ?? field.value) : field.value}
            </span>
          ))}
        </div>
      ) : null}
      <details className="change-structured">
        <summary>查看完整信息</summary>
        <div className="change-readable">
          {contentText ? (
            <div className="change-copy">
              <span>内容</span>
              <p>{contentText}</p>
            </div>
          ) : null}
          {rationale ? (
            <div className="change-copy">
              <span>关系说明</span>
              <p>{rationale}</p>
            </div>
          ) : null}
          {fields.length ? (
            <div className="change-fields">
              {fields.map((field) => (
                <div className={field.wide ? 'wide' : undefined} key={field.label}>
                  <span>{field.label}</span>
                  <strong>
                    {field.label === '节点类型'
                      ? (NODE_LABELS[field.value] ?? field.value)
                      : field.value}
                  </strong>
                </div>
              ))}
            </div>
          ) : null}
          {roles.length ? (
            <div className="change-tags">
              <span>角色</span>
              <div>
                {roles.map((role) => (
                  <b key={role}>{role}</b>
                ))}
              </div>
            </div>
          ) : null}
          {attributes && Object.keys(attributes).length ? (
            <div className="change-attributes">
              <span>属性</span>
              <dl>
                {Object.entries(attributes).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{readableValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {isRemoval ? (
            <p className="removal-note">采用后将从 Working State 中移除此对象。</p>
          ) : null}
        </div>
        <details className="change-technical">
          <summary>技术详情与原始 JSON</summary>
          <div className="change-technical-meta">
            <span>实体 ID</span>
            <code>{change.entityId}</code>
            {change.baseRevisionId ? (
              <>
                <span>基础修订</span>
                <code>{change.baseRevisionId}</code>
              </>
            ) : null}
          </div>
          <pre>{JSON.stringify(change.payload, null, 2)}</pre>
        </details>
      </details>
    </>
  );
}

function useSidecar(api: SidecarApi, identity: UiIdentity) {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setData(await api.bootstrap(identity));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [api, identity],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!data) return;
      void api
        .events(data.eventCursor)
        .then((result) => {
          if (result.changed) void refresh(true);
        })
        .catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [api, data, refresh]);

  const run = useCallback(
    async <T,>(work: () => Promise<T>, message?: string): Promise<T | null> => {
      try {
        const result = await work();
        if (message) {
          setNotice(message);
          window.setTimeout(() => setNotice(null), 2600);
        }
        await refresh(true);
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [refresh],
  );

  return { data, loading, error, setError, notice, refresh, run };
}

interface TreeProps {
  nodes: NodeDetail[];
  relations: RelationDetail[];
  attention: AttentionContext | null;
  candidates: DesignChange[];
  activeChangeId: string | null;
  onInspectCandidate: (changeId: string, event: MouseEvent) => void;
  onSelect: (nodeId: string, event: MouseEvent) => void;
  onPin: (nodeId: string) => void;
}

function DesignTree({
  nodes,
  relations,
  attention,
  candidates,
  activeChangeId,
  onInspectCandidate,
  onSelect,
  onPin,
}: TreeProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map(nodes.map((node) => [node.node.id, node])), [nodes]);
  const contains = relations.filter((relation) => relation.relation.relationType === 'contains');
  const proposedNodes = candidates.filter(
    (change) => change.status === 'proposed' && change.operation === 'create_node',
  );
  const proposedByEntityId = new Map(proposedNodes.map((change) => [change.entityId, change]));
  const proposedRelations = candidates.filter(
    (change) => change.status === 'proposed' && change.operation === 'create_relation',
  );
  const pendingRelationChanges = candidates.filter(
    (change) => change.status === 'proposed' && change.operation.endsWith('_relation'),
  );
  const candidateChildren = new Map<string, DesignChange[]>();
  const projectedWorkingChildren = new Map<string, NodeDetail[]>();
  const projectedWorkingChildIds = new Set<string>();
  const placedCandidateIds = new Set<string>();
  const titleById = new Map(nodes.map((node) => [node.node.id, node.revision.displayTitle]));
  for (const change of proposedNodes) {
    titleById.set(change.entityId, String(change.payload['displayTitle'] ?? change.summary));
  }
  for (const relation of proposedRelations) {
    if (relation.payload['relationType'] !== 'contains') continue;
    const sourceNodeId = relation.payload['sourceNodeId'];
    const targetNodeId = relation.payload['targetNodeId'];
    if (typeof sourceNodeId !== 'string' || typeof targetNodeId !== 'string') continue;
    if (!byId.has(sourceNodeId) && !proposedByEntityId.has(sourceNodeId)) continue;
    const candidateTarget = proposedByEntityId.get(targetNodeId);
    if (candidateTarget) {
      const list = candidateChildren.get(sourceNodeId) ?? [];
      if (!list.some((item) => item.entityId === targetNodeId)) list.push(candidateTarget);
      candidateChildren.set(sourceNodeId, list);
      placedCandidateIds.add(targetNodeId);
      continue;
    }
    const workingTarget = byId.get(targetNodeId);
    if (workingTarget) {
      const list = projectedWorkingChildren.get(sourceNodeId) ?? [];
      if (!list.some((item) => item.node.id === targetNodeId)) list.push(workingTarget);
      projectedWorkingChildren.set(sourceNodeId, list);
      projectedWorkingChildIds.add(targetNodeId);
    }
  }
  const relationHints = new Map<string, Array<{ changeId: string; label: string }>>();
  for (const relation of pendingRelationChanges) {
    const descriptor = changeRelationDescriptor(relation, relations);
    if (!descriptor) continue;
    if (relation.operation === 'create_relation' && descriptor.relationType === 'contains')
      continue;
    const { relationType, sourceNodeId, targetNodeId } = descriptor;
    const operationLabel = OPERATION_LABELS[relation.operation] ?? relation.operation;
    const sourceHints = relationHints.get(sourceNodeId) ?? [];
    sourceHints.push({
      changeId: relation.id,
      label: `${operationLabel} · ${RELATION_LABELS[relationType] ?? relationType} → ${titleById.get(targetNodeId) ?? targetNodeId}`,
    });
    relationHints.set(sourceNodeId, sourceHints);
    const targetHints = relationHints.get(targetNodeId) ?? [];
    targetHints.push({
      changeId: relation.id,
      label: `${operationLabel} · ${RELATION_LABELS[relationType] ?? relationType} ← ${titleById.get(sourceNodeId) ?? sourceNodeId}`,
    });
    relationHints.set(targetNodeId, targetHints);
  }
  const children = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const item of contains) {
      const list = map.get(item.relation.sourceNodeId) ?? [];
      list.push(item.relation.targetNodeId);
      map.set(item.relation.sourceNodeId, list);
    }
    return map;
  }, [contains]);
  const childIds = new Set(contains.map((item) => item.relation.targetNodeId));
  const roots = nodes.filter(
    (node) => !childIds.has(node.node.id) && !projectedWorkingChildIds.has(node.node.id),
  );
  const selected = new Set(attention?.selectedNodeIds ?? []);
  const selectedCandidates = new Set(attention?.selectedChangeIds ?? []);
  const pinned = new Set(attention?.pinnedNodeIds ?? []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeChange = candidates.find((change) => change.id === activeChangeId);
  const activeRelation = activeChange ? changeRelationDescriptor(activeChange, relations) : null;
  const activeSourceNodeId = activeRelation?.sourceNodeId ?? null;
  const activeTargetNodeId = activeRelation?.targetNodeId ?? null;
  const activeNodeClass = (nodeId: string) => {
    const classes: string[] = [];
    if (activeChange?.entityId === nodeId && !activeSourceNodeId && !activeTargetNodeId)
      classes.push('candidate-focus');
    if (activeSourceNodeId === nodeId) classes.push('relation-source');
    if (activeTargetNodeId === nodeId) classes.push('relation-target');
    return classes.join(' ');
  };

  const inspectCandidate = (changeId: string, event: MouseEvent) => {
    onInspectCandidate(changeId, event);
    const target = document.getElementById(`change-${changeId}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    target?.animate(
      [
        { borderColor: 'var(--amber)', boxShadow: '0 0 0 1px #eeb65b55' },
        { borderColor: 'var(--line)', boxShadow: 'none' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
  };

  function candidateRow(change: DesignChange, depth: number, seen: Set<string>): React.ReactNode {
    const id = change.entityId;
    if (seen.has(id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const nodeChildren = candidateChildren.get(id) ?? [];
    const workingChildren = projectedWorkingChildren.get(id) ?? [];
    const isCollapsed = collapsed.has(id);
    const nodeType = String(change.payload['nodeType'] ?? 'topic');
    const title = String(change.payload['displayTitle'] ?? change.summary);
    const roles = Array.isArray(change.payload['roles'])
      ? change.payload['roles'].filter((role): role is string => typeof role === 'string')
      : [];
    const links = relationHints.get(id) ?? [];
    return (
      <div key={change.id}>
        <div
          className={`tree-node ghost candidate-node ${selectedCandidates.has(change.id) ? 'agent-visible-selection' : ''} ${attention?.primaryChangeId === change.id ? 'primary-change' : ''} ${activeNodeClass(id)}`}
          style={{ '--depth': depth } as React.CSSProperties}
          title={
            selectedCandidates.has(change.id)
              ? '此候选已同步为 Agent 可见焦点'
              : '候选尚未进入 Working State；点击后 Agent 可读取此焦点'
          }
          onClick={(event) => inspectCandidate(change.id, event)}
        >
          <button
            className="tree-toggle"
            aria-label={isCollapsed ? '展开候选分支' : '收起候选分支'}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed((current) => {
                const next = new Set(current);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              });
            }}
            disabled={!nodeChildren.length && !workingChildren.length}
          >
            {nodeChildren.length || workingChildren.length ? (isCollapsed ? '›' : '⌄') : '·'}
          </button>
          <span className={`node-glyph candidate type-${nodeType}`}>{initials(nodeType)}</span>
          <span className="tree-title" title={title}>
            {title}
          </span>
          {links.length ? (
            <button
              className={`relation-hint ${links.some((link) => link.changeId === activeChangeId) ? 'active' : ''}`}
              title={links.map((link) => link.label).join('\n')}
              onClick={(event) => {
                event.stopPropagation();
                inspectCandidate(links[0]!.changeId, event);
              }}
            >
              ↔ {links.length}
            </button>
          ) : null}
          <span
            className={`micro-badge candidate ${selectedCandidates.has(change.id) ? 'agent-visible' : ''}`}
          >
            {selectedCandidates.has(change.id)
              ? 'Agent 可见'
              : roles.includes('root')
                ? '候选根'
                : '候选'}
          </span>
        </div>
        {!isCollapsed
          ? [
              ...nodeChildren.map((child) => candidateRow(child, depth + 1, nextSeen)),
              ...workingChildren.map((child) => row(child, depth + 1, nextSeen)),
            ]
          : null}
      </div>
    );
  }

  const row = (node: NodeDetail, depth: number, seen: Set<string>): React.ReactNode => {
    const id = node.node.id;
    if (seen.has(id)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const nodeChildren = (children.get(id) ?? [])
      .map((child) => byId.get(child))
      .filter((child): child is NodeDetail => Boolean(child));
    for (const projectedChild of projectedWorkingChildren.get(id) ?? []) {
      if (!nodeChildren.some((child) => child.node.id === projectedChild.node.id))
        nodeChildren.push(projectedChild);
    }
    const candidateNodeChildren = candidateChildren.get(id) ?? [];
    const isCollapsed = collapsed.has(id);
    const revisionChange = candidates.find(
      (change) =>
        change.status === 'proposed' &&
        change.entityId === id &&
        change.operation === 'revise_node',
    );
    const removalChange = candidates.find(
      (change) =>
        change.status === 'proposed' &&
        change.entityId === id &&
        change.operation === 'remove_node',
    );
    const nodeCandidateChange = revisionChange ?? removalChange;
    const projectedTitle =
      typeof revisionChange?.payload['displayTitle'] === 'string'
        ? revisionChange.payload['displayTitle']
        : node.revision.displayTitle;
    const links = relationHints.get(id) ?? [];
    return (
      <div key={id}>
        <div
          className={`tree-node ${selected.has(id) ? 'selected' : ''} ${attention?.primaryNodeId === id ? 'primary' : ''} ${revisionChange ? 'revision-candidate' : ''} ${removalChange ? 'removal-candidate' : ''} ${nodeCandidateChange && selectedCandidates.has(nodeCandidateChange.id) ? 'agent-visible-selection' : ''} ${attention?.primaryChangeId === nodeCandidateChange?.id ? 'primary-change' : ''} ${projectedWorkingChildIds.has(id) ? 'position-candidate' : ''} ${activeNodeClass(id)}`}
          style={{ '--depth': depth } as React.CSSProperties}
          title={
            nodeCandidateChange
              ? `点击定位右侧${revisionChange ? '修订' : '移除'}候选；按住 Ctrl / ⌘ 可选择 Working 节点`
              : undefined
          }
          onClick={(event) => {
            if (nodeCandidateChange && !event.ctrlKey && !event.metaKey)
              inspectCandidate(nodeCandidateChange.id, event);
            else onSelect(id, event);
          }}
        >
          <button
            className="tree-toggle"
            aria-label={isCollapsed ? '展开' : '收起'}
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed((current) => {
                const next = new Set(current);
                next.has(id) ? next.delete(id) : next.add(id);
                return next;
              });
            }}
            disabled={!nodeChildren.length && !candidateNodeChildren.length}
          >
            {nodeChildren.length || candidateNodeChildren.length ? (isCollapsed ? '›' : '⌄') : '·'}
          </button>
          <span className={`node-glyph type-${node.node.nodeType}`}>
            {initials(node.node.nodeType)}
          </span>
          <span className="tree-title" title={projectedTitle}>
            {projectedTitle}
          </span>
          {node.revision.roles.includes('root') ? (
            <span className="micro-badge root">ROOT</span>
          ) : null}
          {node.revision.reviewState !== 'clean' ? (
            <span className="status-dot warning" title="待复核" />
          ) : null}
          {links.length ? (
            <button
              className={`relation-hint ${links.some((link) => link.changeId === activeChangeId) ? 'active' : ''}`}
              title={links.map((link) => link.label).join('\n')}
              onClick={(event) => {
                event.stopPropagation();
                inspectCandidate(links[0]!.changeId, event);
              }}
            >
              ↔ {links.length}
            </button>
          ) : null}
          {revisionChange ? (
            <button
              className="candidate-link"
              title="点击查看修订候选"
              onClick={(event) => {
                event.stopPropagation();
                inspectCandidate(revisionChange.id, event);
              }}
            >
              待修订
            </button>
          ) : null}
          {removalChange ? (
            <button
              className="candidate-link removal"
              title="点击查看移除候选"
              onClick={(event) => {
                event.stopPropagation();
                inspectCandidate(removalChange.id, event);
              }}
            >
              待移除
            </button>
          ) : null}
          {projectedWorkingChildIds.has(id) ? (
            <span className="micro-badge candidate">候选位置</span>
          ) : null}
          <button
            className={`pin-button ${pinned.has(id) ? 'active' : ''}`}
            aria-label={pinned.has(id) ? '已固定' : '固定节点'}
            onClick={(event) => {
              event.stopPropagation();
              onPin(id);
            }}
          >
            {pinned.has(id) ? '◆' : '◇'}
          </button>
        </div>
        {!isCollapsed ? (
          <>
            {nodeChildren.map((child) => row(child, depth + 1, nextSeen))}
            {candidateNodeChildren.map((child) => candidateRow(child, depth + 1, nextSeen))}
          </>
        ) : null}
      </div>
    );
  };

  const filtered = normalizedQuery
    ? nodes.filter((node) =>
        `${node.revision.displayTitle} ${node.revision.contentText} ${node.revision.roles.join(' ')}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : [];
  const filteredCandidates = normalizedQuery
    ? proposedNodes.filter((change) =>
        `${String(change.payload['displayTitle'] ?? '')} ${String(change.payload['contentText'] ?? '')} ${readableValue(change.payload['roles'])}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : [];
  const candidateRoots = proposedNodes.filter((change) => {
    const roles = Array.isArray(change.payload['roles']) ? change.payload['roles'] : [];
    return !placedCandidateIds.has(change.entityId) && roles.includes('root');
  });
  const candidateRootIds = new Set(candidateRoots.map((change) => change.entityId));
  const unplacedCandidates = proposedNodes.filter(
    (change) => !placedCandidateIds.has(change.entityId) && !candidateRootIds.has(change.entityId),
  );

  return (
    <section className="tree-panel panel-surface">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">DESIGN SPACE</span>
          <h2>设计树</h2>
        </div>
        <span
          className="count-pill"
          title={`${nodes.length} 个 Working 节点，${proposedNodes.length} 个候选节点`}
        >
          {nodes.length}
          {proposedNodes.length ? ` +${proposedNodes.length}` : ''}
        </span>
      </div>
      <label className="search-box">
        <span>⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索节点、正文或角色…"
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="tree-scroll" role="tree">
        {normalizedQuery ? (
          <div className="search-results">
            <p className="section-label">
              搜索结果 · {filtered.length + filteredCandidates.length}
            </p>
            {filtered.map((node) => row(node, 0, new Set()))}
            {filteredCandidates.map((change) => candidateRow(change, 0, new Set()))}
          </div>
        ) : roots.length || candidateRoots.length ? (
          <>
            {roots.map((node) => row(node, 0, new Set()))}
            {candidateRoots.map((change) => candidateRow(change, 0, new Set()))}
          </>
        ) : (
          <EmptyState
            icon="⌁"
            title="设计树还是空的"
            body="在聊天中让 Agent 建立 ChangeSet 并提出第一个根目标。"
          />
        )}
        {!normalizedQuery && unplacedCandidates.length ? (
          <div className="candidate-tree-group">
            <p className="section-label">待定位候选 · 尚无 contains 父节点</p>
            {unplacedCandidates.map((change) => candidateRow(change, 0, new Set()))}
          </div>
        ) : null}
      </div>
      <footer className="tree-legend">
        <span>
          <i className="legend-ring" /> 用户焦点
        </span>
        <span>
          <i className="legend-dot" /> Working
        </span>
        <span>
          <i className="legend-dash" /> Candidate
        </span>
        {activeSourceNodeId && activeTargetNodeId ? (
          <>
            <span className="relation-legend source">
              <i /> 关系起点
            </span>
            <span className="relation-legend target">
              <i /> 关系终点
            </span>
          </>
        ) : null}
      </footer>
    </section>
  );
}

function FocusBar({
  data,
  identity,
  api,
  run,
}: {
  data: BootstrapData;
  identity: UiIdentity;
  api: SidecarApi;
  run: ReturnType<typeof useSidecar>['run'];
}) {
  const attention = data.attention;
  const byId = new Map(data.nodes.map((node) => [node.node.id, node]));
  const primary = attention?.primaryNodeId ? byId.get(attention.primaryNodeId) : null;
  const changes = data.changeSet?.changes ?? [];
  const primaryChange = attention?.primaryChangeId
    ? changes.find((change) => change.id === attention.primaryChangeId)
    : null;
  const primaryChangeTitle = primaryChange
    ? String(primaryChange.payload['displayTitle'] ?? primaryChange.summary)
    : null;
  const selectedCount =
    (attention?.selectedNodeIds.length ?? 0) + (attention?.selectedChangeIds.length ?? 0);
  const updateScope = (scope: string) =>
    void run(
      () =>
        api.tool('attention_set', { ...identity, scope, expectedVersion: attention?.version ?? 0 }),
      '工作范围已更新',
    );
  return (
    <div className="focus-bar">
      <div className="focus-main">
        <span className="focus-signal" />
        <div>
          <span className="eyebrow">
            SHARED FOCUS <i className="agent-visible-chip">AGENT 可见</i>
          </span>
          <strong>{primaryChangeTitle ?? primary?.revision.displayTitle ?? '未选择焦点'}</strong>
          <small>
            {primaryChange
              ? '候选焦点 · Agent 可通过 attention_get 读取'
              : primary
                ? '节点焦点 · Agent 可通过 attention_get 读取'
                : '点击节点或候选后同步给当前项目的 Agent'}
          </small>
        </div>
      </div>
      <div className="focus-stat">
        <span>已选</span>
        <strong>{selectedCount}</strong>
      </div>
      <div className="focus-stat">
        <span>固定</span>
        <strong>{attention?.pinnedNodeIds.length ?? 0}</strong>
      </div>
      <label className="scope-control">
        <span>范围</span>
        <select
          value={attention?.scope ?? 'node'}
          onChange={(event) => updateScope(event.target.value)}
        >
          <option value="node">当前节点</option>
          <option value="subtree">整棵子树</option>
          <option value="related">关联范围</option>
          <option value="comparison">多项比较</option>
        </select>
      </label>
      <div
        className={`agent-presence ${data.agentActivity && !data.agentActivity.endedAt ? 'active' : ''}`}
      >
        <span className="agent-pulse" />
        <div>
          <span>Agent</span>
          <strong>
            {data.agentActivity && !data.agentActivity.endedAt
              ? data.agentActivity.summary
              : '当前空闲'}
          </strong>
        </div>
      </div>
    </div>
  );
}

function Inspector({
  node,
  relations,
  changes,
  attention,
  onConfirmRoot,
  onPrompt,
}: {
  node: NodeDetail | null;
  relations: RelationDetail[];
  changes: DesignChange[];
  attention: AttentionContext | null;
  onConfirmRoot: (nodeId: string) => void;
  onPrompt: (intent: string) => void;
}) {
  const [tab, setTab] = useState<'content' | 'relations' | 'history'>('content');
  if (!node)
    return (
      <section className="inspector panel-surface">
        <EmptyState
          icon="◎"
          title="选择一个节点开始"
          body="单击设为主焦点；按住 Ctrl / ⌘ 多选进行比较。选择只改变 Attention，不会调用模型。"
        />
      </section>
    );
  const direct = relations.filter(
    (item) =>
      item.relation.sourceNodeId === node.node.id || item.relation.targetNodeId === node.node.id,
  );
  const pending = changes.filter(
    (change) =>
      change.status === 'proposed' &&
      (change.entityId === node.node.id ||
        change.payload['sourceNodeId'] === node.node.id ||
        change.payload['targetNodeId'] === node.node.id),
  );
  const isRoot = node.revision.roles.includes('root');
  return (
    <section className="inspector panel-surface">
      <header className="inspector-header">
        <div className={`node-glyph large type-${node.node.nodeType}`}>
          {initials(node.node.nodeType)}
        </div>
        <div className="inspector-title">
          <div className="badge-row">
            <span className="type-label">
              {NODE_LABELS[node.node.nodeType] ?? node.node.nodeType}
            </span>
            {isRoot ? <span className="micro-badge root">ROOT</span> : null}
            <span className={`approval-chip ${node.revision.approvalState}`}>
              {node.revision.approvalState}
            </span>
          </div>
          <h1>{node.revision.displayTitle}</h1>
          <p className="mono-id">{node.node.id}</p>
        </div>
      </header>
      <div className="intent-strip">
        <span>围绕此节点</span>
        {FOCUSED_SKILL_ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            title={action.description}
            onClick={() => onPrompt(action.prompt)}
          >
            {action.label}
            <span>↗</span>
          </button>
        ))}
      </div>
      {isRoot && node.revision.approvalState !== 'user_confirmed' ? (
        <div className="root-callout">
          <div>
            <strong>根目标等待用户确认</strong>
            <p>确认会签发一次性、目标绑定的授权，并生成新的不可变修订。</p>
          </div>
          <button className="button primary" onClick={() => onConfirmRoot(node.node.id)}>
            确认根目标
          </button>
        </div>
      ) : null}
      {pending.length ? (
        <div className="inline-candidate">
          <span>∆</span>
          <div>
            <strong>{pending.length} 个候选影响此节点</strong>
            <p>在右侧候选区检查差异后逐项采用或丢弃。</p>
          </div>
        </div>
      ) : null}
      <nav className="tab-list">
        <button className={tab === 'content' ? 'active' : ''} onClick={() => setTab('content')}>
          正文
        </button>
        <button className={tab === 'relations' ? 'active' : ''} onClick={() => setTab('relations')}>
          关系 <span>{direct.length}</span>
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          状态
        </button>
      </nav>
      <div className="inspector-body">
        {tab === 'content' ? (
          <>
            <article className="node-content">
              {node.revision.contentText || <em>暂无正文</em>}
            </article>
            <div className="metadata-grid">
              <Meta label="Approval" value={node.revision.approvalState} />
              <Meta label="Epistemic" value={node.revision.epistemicState ?? '—'} />
              <Meta label="Review" value={node.revision.reviewState} />
              <Meta label="Revision" value={`v${node.revision.revisionNumber}`} />
            </div>
            {node.revision.roles.length ? (
              <div className="role-list">
                <span>角色</span>
                {node.revision.roles.map((role) => (
                  <b key={role}>{role}</b>
                ))}
              </div>
            ) : null}
            <details className="attributes">
              <summary>类型化字段</summary>
              <pre>{JSON.stringify(node.revision.attributes, null, 2)}</pre>
            </details>
          </>
        ) : null}
        {tab === 'relations' ? (
          direct.length ? (
            <div className="relation-cards">
              {direct.map((item) => {
                const outgoing = item.relation.sourceNodeId === node.node.id;
                return (
                  <div className="relation-card" key={item.relation.id}>
                    <span className="relation-direction">{outgoing ? '→' : '←'}</span>
                    <div>
                      <strong>{item.relation.relationType}</strong>
                      <p>{outgoing ? item.relation.targetNodeId : item.relation.sourceNodeId}</p>
                      <small>{item.revision.rationale || '无说明'}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="⇄"
              title="没有直接关系"
              body="让 Agent 提出一个小步关系候选，或在聊天中询问遗漏依赖。"
            />
          )
        ) : null}
        {tab === 'history' ? (
          <div className="history-card">
            <div>
              <span>当前修订</span>
              <strong>v{node.revision.revisionNumber}</strong>
            </div>
            <div>
              <span>创建于 ChangeSet</span>
              <strong className="mono-id">{node.revision.createdInChangeSetId}</strong>
            </div>
            <div>
              <span>上一个修订</span>
              <strong className="mono-id">
                {node.revision.supersedesRevisionId ?? '初始修订'}
              </strong>
            </div>
            <div>
              <span>Attention version</span>
              <strong>{attention?.version ?? 0}</strong>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ChangePanel({
  data,
  identity,
  api,
  run,
  activeChangeId,
  onInspectChange,
  onPreviewChange,
}: {
  data: BootstrapData;
  identity: UiIdentity;
  api: SidecarApi;
  run: ReturnType<typeof useSidecar>['run'];
  activeChangeId: string | null;
  onInspectChange: (changeId: string, event: MouseEvent) => void;
  onPreviewChange: (changeId: string | null) => void;
}) {
  const changeSet = data.changeSet;
  const [editing, setEditing] = useState<string | null>(null);
  const [payload, setPayload] = useState('');
  const [summary, setSummary] = useState('');
  const changes = changeSet?.changes ?? [];
  const pending = changes.filter((change) => change.status === 'proposed');
  const adopted = changes.filter((change) => change.status === 'adopted');
  const pendingNodeChanges = pending.filter((change) => change.operation === 'create_node');
  const pendingRelationChanges = pending.filter((change) => change.operation === 'create_relation');
  const pendingNodeByEntityId = new Map(
    pendingNodeChanges.map((change) => [change.entityId, change]),
  );
  const bundledContainsRelations = pendingRelationChanges.filter((relation) => {
    if (relation.payload['relationType'] !== 'contains') return false;
    const child = pendingNodeByEntityId.get(String(relation.payload['targetNodeId'] ?? ''));
    const roles = Array.isArray(child?.payload['roles']) ? child.payload['roles'] : [];
    return Boolean(child) && !roles.includes('root');
  });
  const bundledContainsIds = new Set(bundledContainsRelations.map((change) => change.id));
  const pendingReviewChanges = pending.filter((change) => !bundledContainsIds.has(change.id));
  const pendingNodeCount = pendingReviewChanges.filter((change) =>
    change.operation.endsWith('_node'),
  ).length;
  const pendingRelationCount = pendingReviewChanges.filter((change) =>
    change.operation.endsWith('_relation'),
  ).length;
  const workingNodeIds = new Set(data.nodes.map((node) => node.node.id));
  const nodeTitles = new Map(data.nodes.map((node) => [node.node.id, node.revision.displayTitle]));
  for (const change of changes) {
    const title = change.payload['displayTitle'];
    if (typeof title === 'string') nodeTitles.set(change.entityId, title);
  }

  if (!changeSet)
    return (
      <aside className="changes-panel panel-surface">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">WORKING STATE</span>
            <h2>候选变更</h2>
          </div>
        </div>
        <EmptyState
          icon="∆"
          title="没有活动 ChangeSet"
          body="Agent 可以在聊天中开始一个小步 ChangeSet；也可以从这里建立空白工作集。"
        />
        <button
          className="button primary full"
          onClick={() =>
            void run(
              () =>
                api.tool('changeset_begin', {
                  hostSessionRef: identity.hostSessionRef,
                  title: '设计迭代',
                  description: '从 Sidecar 开始的设计变更',
                }),
              'ChangeSet 已建立',
            )
          }
        >
          开始设计迭代
        </button>
      </aside>
    );

  const leaseState =
    data.leaseStatus?.state ??
    (data.lease?.ownerHostSessionRef === identity.hostSessionRef ? 'owned' : 'foreign_active');
  const ownLease = leaseState === 'owned';
  const reclaimableLease = leaseState === 'reclaimable';
  const handoffRequest = data.leaseHandoffRequests[0] ?? null;
  const revise = (change: DesignChange) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    void run(
      () =>
        api.tool('design_change_revise', {
          hostSessionRef: identity.hostSessionRef,
          changeId: change.id,
          expectedChangeSetVersion: changeSet.version,
          payload: parsed,
          summary: summary || change.summary,
        }),
      '候选已修订',
    ).then(() => setEditing(null));
  };

  return (
    <aside className="changes-panel panel-surface">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">WORKING STATE</span>
          <h2>候选变更</h2>
        </div>
        <span className="version-pill">v{changeSet.version}</span>
      </div>
      <div className="lease-stack">
        <div
          className={`lease-card ${ownLease ? 'owned' : reclaimableLease ? 'recoverable' : 'foreign'}`}
        >
          <span className="lease-icon">{ownLease ? '●' : reclaimableLease ? '↻' : '◐'}</span>
          <div>
            <strong>
              {ownLease
                ? '当前会话持有写入权'
                : reclaimableLease
                  ? '旧会话写入权已失效'
                  : '其他会话持有写入权'}
            </strong>
            <p>
              {reclaimableLease
                ? '可以安全恢复，现有候选不会丢失'
                : (data.lease?.ownerHostSessionRef ?? 'lease 缺失')}
            </p>
          </div>
          {!ownLease ? (
            <button
              onClick={() =>
                reclaimableLease
                  ? void run(
                      () =>
                        api.tool('changeset_begin', {
                          hostSessionRef: identity.hostSessionRef,
                          title: changeSet.title,
                          description: changeSet.description,
                        }),
                      '已恢复当前工作集',
                    )
                  : void run(
                      () =>
                        api.action('take_lease', {
                          targetId: changeSet.id,
                          hostSessionRef: identity.hostSessionRef,
                        }),
                      '写入权已接管',
                    )
              }
            >
              {reclaimableLease ? '恢复工作集' : '显式接管'}
            </button>
          ) : null}
        </div>
        {handoffRequest ? (
          <div className="lease-handoff-card">
            <span className="lease-handoff-icon">⇄</span>
            <div>
              <strong>Agent 请求写入权</strong>
              <p>{handoffRequest.purpose}</p>
              <small title={handoffRequest.requesterHostSessionRef}>
                请求方 {handoffRequest.requesterHostSessionRef}
              </small>
            </div>
            <button
              type="button"
              onClick={() =>
                void run(
                  () =>
                    api.action('approve_lease_handoff', {
                      targetId: handoffRequest.id,
                      hostSessionRef: identity.hostSessionRef,
                    }),
                  '写入权已交给请求中的 Agent',
                )
              }
            >
              交给此 Agent
            </button>
          </div>
        ) : null}
      </div>
      <div className="change-summary">
        <div>
          <strong>{pendingReviewChanges.length}</strong>
          <span>
            待批准 · {pendingNodeCount} 节点 / {pendingRelationCount} 独立关系
          </span>
          {bundledContainsRelations.length ? (
            <small>{bundledContainsRelations.length} 条 contains 随子节点处理</small>
          ) : null}
        </div>
        <div>
          <strong>{adopted.length}</strong>
          <span>已采用</span>
        </div>
        <div>
          <strong>{changes.filter((item) => item.status === 'discarded').length}</strong>
          <span>已丢弃</span>
        </div>
      </div>
      <div className="change-scroll">
        {pending.length ? (
          <details className="approval-guide">
            <summary>自上而下批准规则</summary>
            <ol>
              <li>根节点可直接批准；其他节点必须先批准父节点。</li>
              <li>批准子节点时，它的 contains 挂载关系在同一事务中一并批准。</li>
              <li>supports、depends_on 等语义关系仍作为独立决策审查。</li>
              <li>丢弃子节点时，它尚未批准的 contains 挂载也会一并丢弃。</li>
              <li>候选未全部处理前，不能校验或发布 Release。</li>
            </ol>
          </details>
        ) : null}
        {pendingReviewChanges.map((change, index) => {
          const displayTitle = change.payload['displayTitle'];
          const cardTitle = typeof displayTitle === 'string' ? displayTitle : change.summary;
          const sourceNodeId =
            typeof change.payload['sourceNodeId'] === 'string'
              ? change.payload['sourceNodeId']
              : null;
          const targetNodeId =
            typeof change.payload['targetNodeId'] === 'string'
              ? change.payload['targetNodeId']
              : null;
          const relationEndpointIds = [sourceNodeId, targetNodeId].filter(
            (nodeId): nodeId is string => Boolean(nodeId),
          );
          const missingEndpointIds = relationEndpointIds.filter(
            (nodeId) => !workingNodeIds.has(nodeId),
          );
          const dependencyNodeChanges = missingEndpointIds
            .map((nodeId) => pendingNodeByEntityId.get(nodeId))
            .filter((item): item is DesignChange => Boolean(item));
          const unresolvedEndpointIds = missingEndpointIds.filter(
            (nodeId) => !pendingNodeByEntityId.has(nodeId),
          );
          const nodeRoles = Array.isArray(change.payload['roles']) ? change.payload['roles'] : [];
          const isRootCandidate = change.operation === 'create_node' && nodeRoles.includes('root');
          const containsAttachments =
            change.operation === 'create_node'
              ? pendingRelationChanges.filter(
                  (relation) =>
                    relation.payload['relationType'] === 'contains' &&
                    relation.payload['targetNodeId'] === change.entityId,
                )
              : [];
          const parentId =
            containsAttachments.length === 1 &&
            typeof containsAttachments[0]?.payload['sourceNodeId'] === 'string'
              ? String(containsAttachments[0].payload['sourceNodeId'])
              : null;
          const parentReady = parentId ? workingNodeIds.has(parentId) : false;
          const parentCandidate = parentId ? pendingNodeByEntityId.get(parentId) : undefined;
          const parentTitle = parentId
            ? (nodeTitles.get(parentId) ?? parentCandidate?.summary ?? parentId)
            : null;
          const nodeAdoptBlockReason =
            change.operation !== 'create_node' || isRootCandidate
              ? null
              : containsAttachments.length === 0
                ? '缺少 contains 父节点'
                : containsAttachments.length > 1
                  ? '存在多个 contains 父节点'
                  : !parentReady
                    ? `先批准父节点「${parentTitle}」`
                    : null;
          const relationTouchesNode = (relation: DesignChange) =>
            relation.payload['sourceNodeId'] === change.entityId ||
            relation.payload['targetNodeId'] === change.entityId;
          const dependentRelations =
            change.operation === 'create_node'
              ? pendingRelationChanges.filter(
                  (relation) =>
                    !bundledContainsIds.has(relation.id) && relationTouchesNode(relation),
                )
              : [];
          const discardDependencies =
            change.operation === 'create_node'
              ? pendingRelationChanges.filter(
                  (relation) =>
                    !containsAttachments.some((attachment) => attachment.id === relation.id) &&
                    relationTouchesNode(relation),
                )
              : [];
          const relationAdoptBlocked =
            change.operation === 'create_relation' && missingEndpointIds.length > 0;
          const adoptBlocked = relationAdoptBlocked || Boolean(nodeAdoptBlockReason);
          const discardBlocked =
            change.operation === 'create_node' && discardDependencies.length > 0;
          return (
            <article
              className={`change-card ${activeChangeId === change.id ? 'active' : ''} ${data.attention?.selectedChangeIds.includes(change.id) ? 'agent-visible-selection' : ''}`}
              id={`change-${change.id}`}
              key={change.id}
              tabIndex={0}
              onClick={(event) => {
                if (
                  (event.target as HTMLElement).closest(
                    'button,input,textarea,select,summary,a,label',
                  )
                )
                  return;
                onInspectChange(change.id, event);
              }}
              onMouseEnter={() => onPreviewChange(change.id)}
              onMouseLeave={() => onPreviewChange(null)}
              onFocusCapture={() => onPreviewChange(change.id)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  onPreviewChange(null);
              }}
            >
              <header>
                <span className="change-index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <span className={`operation ${change.operation}`}>
                    {OPERATION_LABELS[change.operation] ?? change.operation.replace('_', ' ')}
                  </span>
                  <h3>{cardTitle}</h3>
                  {cardTitle !== change.summary ? (
                    <p className="change-intent">{change.summary}</p>
                  ) : null}
                  {data.attention?.selectedChangeIds.includes(change.id) ? (
                    <span className="change-agent-visible">● Agent 可见焦点</span>
                  ) : null}
                </div>
              </header>
              {editing === change.id ? (
                <div className="change-editor">
                  <label>
                    摘要
                    <input value={summary} onChange={(event) => setSummary(event.target.value)} />
                  </label>
                  <label>
                    高级编辑（JSON）
                    <textarea
                      value={payload}
                      onChange={(event) => setPayload(event.target.value)}
                      rows={10}
                      spellCheck={false}
                    />
                  </label>
                  <div>
                    <button className="button primary" onClick={() => revise(change)}>
                      保存修订
                    </button>
                    <button className="button ghost" onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <ChangePayloadSummary
                  change={change}
                  nodeTitles={nodeTitles}
                  relations={data.relations}
                />
              )}
              {change.operation === 'create_relation' ? (
                <div className={`approval-dependency ${adoptBlocked ? 'blocked' : 'ready'}`}>
                  <strong>{adoptBlocked ? '采用顺序受限' : '端点已就绪'}</strong>
                  <p>
                    {dependencyNodeChanges.length
                      ? `请先采用：${dependencyNodeChanges
                          .map((item) => String(item.payload['displayTitle'] ?? item.summary))
                          .join('、')}`
                      : unresolvedEndpointIds.length
                        ? `关系端点缺失：${unresolvedEndpointIds.join('、')}，请先修订该候选。`
                        : '起点和终点都已在 Working State，可以单独采用该关系。'}
                  </p>
                </div>
              ) : null}
              {change.operation === 'create_node' ? (
                <div
                  className={`approval-dependency ${nodeAdoptBlockReason ? 'blocked' : 'ready'}`}
                >
                  <strong>
                    {isRootCandidate
                      ? '根节点可直接批准'
                      : nodeAdoptBlockReason
                        ? '父子顺序受限'
                        : '批准时自动挂载'}
                  </strong>
                  <p>
                    {isRootCandidate
                      ? '根节点是自上而下审批的起点，不需要 contains 父节点。'
                      : containsAttachments.length === 0
                        ? '尚未声明父节点，请让 Agent 补充一条 contains 关系。'
                        : containsAttachments.length > 1
                          ? '该节点有多个父节点候选，请只保留一条 contains 关系。'
                          : !parentReady
                            ? `先批准父节点「${parentTitle}」，再批准当前节点。`
                            : `批准当前节点时，将在同一事务中挂到「${parentTitle}」下。`}
                  </p>
                </div>
              ) : null}
              {change.operation === 'create_node' && dependentRelations.length ? (
                <div className="approval-dependency informative">
                  <strong>语义关系仍单独审查</strong>
                  <p>
                    contains 会随节点处理；另有 {dependentRelations.length} 条语义关系保持待批准。
                  </p>
                </div>
              ) : null}
              {editing !== change.id ? (
                <footer>
                  <button
                    className="button primary"
                    disabled={!ownLease || adoptBlocked}
                    title={
                      nodeAdoptBlockReason ??
                      (relationAdoptBlocked ? '先批准关系引用的候选节点' : undefined)
                    }
                    onClick={() =>
                      void run(
                        () =>
                          api.action('adopt', {
                            targetId: change.id,
                            hostSessionRef: identity.hostSessionRef,
                          }),
                        containsAttachments.length === 1 && !isRootCandidate
                          ? '子节点及挂载关系已批准'
                          : '候选已批准',
                      )
                    }
                  >
                    {nodeAdoptBlockReason
                      ? nodeAdoptBlockReason.startsWith('先批准')
                        ? '先批准父节点'
                        : '先修正父子关系'
                      : relationAdoptBlocked
                        ? '先批准节点'
                        : containsAttachments.length === 1 && !isRootCandidate
                          ? '批准并挂载'
                          : '批准'}
                  </button>
                  <button
                    className="button ghost"
                    disabled={!ownLease}
                    onClick={() => {
                      setEditing(change.id);
                      setPayload(JSON.stringify(change.payload, null, 2));
                      setSummary(change.summary);
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="button danger"
                    disabled={!ownLease || discardBlocked}
                    title={discardBlocked ? '先丢弃或修订引用该节点的候选关系' : undefined}
                    onClick={() =>
                      void run(
                        () =>
                          api.tool('design_change_discard', {
                            hostSessionRef: identity.hostSessionRef,
                            changeId: change.id,
                            expectedChangeSetVersion: changeSet.version,
                          }),
                        '候选已丢弃',
                      )
                    }
                  >
                    {discardBlocked ? '先处理关系' : '丢弃'}
                  </button>
                </footer>
              ) : null}
            </article>
          );
        })}
        {!pending.length ? (
          <EmptyState
            icon="✓"
            title="候选队列已清空"
            body={
              adopted.length
                ? '运行一致性检查，确认 Working State 是否可以发布。'
                : '等待 Agent 提出新的小步候选。'
            }
          />
        ) : null}
        {adopted.length ? (
          <details className="adopted-list">
            <summary>已采用变更 · {adopted.length}</summary>
            {adopted.map((change) => (
              <div key={change.id}>
                <span>✓</span>
                <p>{change.summary}</p>
              </div>
            ))}
          </details>
        ) : null}
      </div>
      <footer className="release-dock">
        <button
          className="button check"
          disabled={!ownLease || !adopted.length || !!pending.length}
          onClick={() =>
            void run(
              () =>
                api.tool('changeset_validate', {
                  hostSessionRef: identity.hostSessionRef,
                  changeSetId: changeSet.id,
                  expectedChangeSetVersion: changeSet.version,
                }),
              '一致性检查完成',
            )
          }
        >
          运行一致性检查
        </button>
        <button
          className="button publish"
          disabled={!ownLease || changeSet.status !== 'ready'}
          onClick={() =>
            void run(
              () =>
                api.action('publish', {
                  targetId: changeSet.id,
                  hostSessionRef: identity.hostSessionRef,
                  summary: changeSet.title,
                }),
              'Release 已发布',
            )
          }
        >
          发布 Release <span>↗</span>
        </button>
      </footer>
    </aside>
  );
}

function RecoveryBanner({
  candidate,
  onRestore,
  onDismiss,
}: {
  candidate: AttentionContext;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="recovery-banner">
      <span>↶</span>
      <div>
        <strong>发现上一次会话的焦点</strong>
        <p>
          {candidate.selectedNodeIds.length} 个选择 · {candidate.pinnedNodeIds.length} 个固定 ·
          更新于 {new Date(candidate.updatedAt).toLocaleString()}
        </p>
      </div>
      <button className="button primary" onClick={onRestore}>
        恢复焦点
      </button>
      <button className="icon-button" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function TreeDiagramApp({
  api: apiProp,
  identity: identityProp,
}: {
  api?: SidecarApi;
  identity?: UiIdentity;
}) {
  const [api] = useState(() => apiProp ?? new SidecarApi());
  const [identity] = useState(() => identityProp ?? getUiIdentity());
  const sidecar = useSidecar(api, identity);
  const { data, loading, error, setError, notice, run } = sidecar;
  const [dismissedRecovery, setDismissedRecovery] = useState(false);
  const [inspectedChangeId, setInspectedChangeId] = useState<string | null>(null);
  const [previewedChangeId, setPreviewedChangeId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readThemePreference);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [lifecycleDialog, setLifecycleDialog] = useState<'close' | 'clear' | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleComplete, setLifecycleComplete] = useState<{
    mode: 'close' | 'clear';
    archivePath?: string;
  } | null>(null);
  const activeChangeId = previewedChangeId ?? inspectedChangeId;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('treediagram-theme', theme);
  }, [theme]);

  const selectNode = (nodeId: string, event: MouseEvent) => {
    if (!data) return;
    setInspectedChangeId(null);
    const current = data.attention?.selectedNodeIds ?? [];
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const selectedNodeIds = additive
      ? current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId]
      : [nodeId];
    const selectedChangeIds = additive ? (data.attention?.selectedChangeIds ?? []) : [];
    const primaryNodeId = selectedNodeIds.includes(nodeId) ? nodeId : (selectedNodeIds[0] ?? null);
    const primaryChangeId = primaryNodeId
      ? null
      : data.attention?.primaryChangeId &&
          selectedChangeIds.includes(data.attention.primaryChangeId)
        ? data.attention.primaryChangeId
        : (selectedChangeIds[0] ?? null);
    const selectedCount = selectedNodeIds.length + selectedChangeIds.length;
    const scope =
      selectedCount > 1
        ? 'comparison'
        : data.attention?.scope === 'comparison'
          ? 'node'
          : (data.attention?.scope ?? 'node');
    void run(() =>
      api.tool('attention_set', {
        ...identity,
        selectedNodeIds,
        selectedChangeIds,
        primaryNodeId,
        primaryChangeId,
        scope,
        expectedVersion: data.attention?.version ?? 0,
      }),
    );
  };
  const selectCandidate = (changeId: string, event: MouseEvent) => {
    if (!data) return;
    setInspectedChangeId(changeId);
    const current = data.attention?.selectedChangeIds ?? [];
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const selectedChangeIds = additive
      ? current.includes(changeId)
        ? current.filter((id) => id !== changeId)
        : [...current, changeId]
      : [changeId];
    const selectedNodeIds = additive ? (data.attention?.selectedNodeIds ?? []) : [];
    const primaryChangeId = selectedChangeIds.includes(changeId)
      ? changeId
      : (selectedChangeIds[0] ?? null);
    const primaryNodeId = primaryChangeId
      ? null
      : data.attention?.primaryNodeId && selectedNodeIds.includes(data.attention.primaryNodeId)
        ? data.attention.primaryNodeId
        : (selectedNodeIds[0] ?? null);
    const selectedCount = selectedNodeIds.length + selectedChangeIds.length;
    const scope =
      selectedCount > 1
        ? 'comparison'
        : data.attention?.scope === 'comparison'
          ? 'node'
          : (data.attention?.scope ?? 'node');
    void run(
      () =>
        api.tool('attention_set', {
          ...identity,
          selectedNodeIds,
          selectedChangeIds,
          primaryNodeId,
          primaryChangeId,
          scope,
          expectedVersion: data.attention?.version ?? 0,
        }),
      primaryChangeId ? '候选已标记为 Agent 可见焦点' : '已取消候选焦点',
    );
  };
  const pinNode = (nodeId: string) => {
    if (!data) return;
    const current = data.attention?.pinnedNodeIds ?? [];
    const pinnedNodeIds = current.includes(nodeId)
      ? current.filter((id) => id !== nodeId)
      : [...current, nodeId];
    void run(
      () =>
        api.tool('attention_set', {
          ...identity,
          pinnedNodeIds,
          expectedVersion: data.attention?.version ?? 0,
        }),
      current.includes(nodeId) ? '已取消固定' : '节点已固定',
    );
  };
  const copyPrompt = async (intent: string, scope: 'focused' | 'whole-tree' = 'focused') => {
    const primary = data?.nodes.find((node) => node.node.id === data.attention?.primaryNodeId);
    const primaryChange = data?.changeSet?.changes?.find(
      (change) => change.id === data.attention?.primaryChangeId,
    );
    const focusTitle = primaryChange
      ? String(primaryChange.payload['displayTitle'] ?? primaryChange.summary)
      : primary?.revision.displayTitle;
    const text =
      scope === 'whole-tree'
        ? `${intent}。这是整树操作：请调用 attention_get 读取用户上下文（session: ${identity.hostSessionRef}），但不要把当前焦点当作范围边界；随后读取完整设计树、全部关系、活动 ChangeSet 和待处理候选。`
        : `${intent}。请先调用 attention_get 读取 TreeDiagram 当前“Agent 可见焦点”（${primaryChange ? '候选' : '节点'}：${focusTitle ?? '未设置'}，session: ${identity.hostSessionRef}），再调用 design_context_get，并优先处理该明确标记的目标。`;
    await navigator.clipboard.writeText(text);
    void run(async () => text, '已复制宿主聊天提示');
  };

  const submitLifecycle = async () => {
    if (!data || !data.lifecycle.available || !lifecycleDialog) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      if (lifecycleDialog === 'close') {
        await api.closeWorkspace();
        setLifecycleComplete({ mode: 'close' });
      } else {
        const result = await api.clearWorkspace(confirmationText);
        setLifecycleComplete({ mode: 'clear', archivePath: result.archivePath });
      }
      setLifecycleDialog(null);
      setWorkspaceMenuOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLifecycleBusy(false);
    }
  };

  if (loading && !data)
    return (
      <div className="loading-screen">
        <span className="brand-mark">T</span>
        <p>正在打开持久设计空间…</p>
      </div>
    );
  if (!data)
    return (
      <div className="fatal-screen">
        <h1>无法打开 TreeDiagram V2</h1>
        <p>{error}</p>
        <button className="button primary" onClick={() => void sidecar.refresh()}>
          重试
        </button>
      </div>
    );

  if (lifecycleComplete)
    return (
      <div className="lifecycle-complete-screen">
        <span className="brand-mark">T</span>
        <h1>{lifecycleComplete.mode === 'clear' ? '工作区已进入归档清空流程' : '工作区已关闭'}</h1>
        <p>
          {lifecycleComplete.mode === 'clear'
            ? 'Sidecar 退出后会把完整历史移动到下方归档目录。下次 Agent 使用此项目时会启动一个新的空工作区。'
            : '设计数据仍保留在项目中。下次 Agent 使用 TreeDiagram 时，可能会自动触发 Sidecar 启动流程。'}
        </p>
        {lifecycleComplete.archivePath ? (
          <div className="archive-result">
            <small>历史归档路径</small>
            <code>{lifecycleComplete.archivePath}</code>
            <button
              className="button"
              type="button"
              onClick={() => void navigator.clipboard.writeText(lifecycleComplete.archivePath!)}
            >
              复制路径
            </button>
          </div>
        ) : null}
        <p className="manual-delete-note">
          {lifecycleComplete.mode === 'clear'
            ? 'TreeDiagram 不会永久删除这份历史；如需彻底删除，请稍后自行前往该路径手动删除。'
            : '现在可以安全关闭此页面。'}
        </p>
      </div>
    );

  const primary = data.nodes.find((node) => node.node.id === data.attention?.primaryNodeId) ?? null;
  const recovery = !data.attention && !dismissedRecovery ? data.recoveryCandidates[0] : undefined;
  return (
    <div className="td-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <div>
            <strong>TreeDiagram</strong>
            <small>Persistent Design Space</small>
          </div>
        </div>
        <div className="workspace-title">
          <span className={`workspace-health ${data.workspace.consistency}`} />{' '}
          <strong>{data.workspace.displayName}</strong>
          <span>
            Release{' '}
            {data.workspace.currentReleaseVersion
              ? `v${data.workspace.currentReleaseVersion}`
              : '—'}
          </span>
        </div>
        <div className="top-actions">
          <button
            className="button whole-tree-action existing-design-action"
            type="button"
            title={EXISTING_DESIGN_ORGANIZE_ACTION.description}
            onClick={() => void copyPrompt(EXISTING_DESIGN_ORGANIZE_ACTION.prompt, 'whole-tree')}
          >
            {EXISTING_DESIGN_ORGANIZE_ACTION.label}
          </button>
          <button
            className="button whole-tree-action"
            type="button"
            title={WHOLE_TREE_REFACTOR_ACTION.description}
            onClick={() => void copyPrompt(WHOLE_TREE_REFACTOR_ACTION.prompt, 'whole-tree')}
          >
            {WHOLE_TREE_REFACTOR_ACTION.label}
          </button>
          <span className="session-chip" title={identity.hostSessionRef}>
            {identity.hostKind} · {identity.hostSessionRef.slice(0, 8)}
          </span>
          <button
            className="icon-button theme-toggle"
            type="button"
            aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
            aria-pressed={theme === 'light'}
            title={theme === 'dark' ? '切换到亮色主题' : '切换到深色主题'}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
          <button className="icon-button" title="刷新" onClick={() => void sidecar.refresh()}>
            ↻
          </button>
          <div className="workspace-menu-wrap">
            <button
              className="icon-button"
              type="button"
              aria-label="工作区操作"
              aria-expanded={workspaceMenuOpen}
              title={data.lifecycle.available ? '工作区操作' : '当前运行方式不支持关闭工作区'}
              disabled={!data.lifecycle.available}
              onClick={() => setWorkspaceMenuOpen((current) => !current)}
            >
              ⋯
            </button>
            {workspaceMenuOpen && data.lifecycle.available ? (
              <div className="workspace-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setLifecycleDialog('close');
                    setWorkspaceMenuOpen(false);
                  }}
                >
                  <strong>关闭工作区</strong>
                  <span>停止当前项目的 Sidecar，保留全部设计数据</span>
                </button>
                <button
                  className="danger"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setConfirmationText('');
                    setLifecycleDialog('clear');
                    setWorkspaceMenuOpen(false);
                  }}
                >
                  <strong>归档并清空工作区</strong>
                  <span>保留一份历史归档，下次启动为空工作区</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <FocusBar data={data} identity={identity} api={api} run={run} />
      {recovery ? (
        <RecoveryBanner
          candidate={recovery}
          onDismiss={() => setDismissedRecovery(true)}
          onRestore={() =>
            void run(() => api.restore(recovery.id, identity), '已从上次会话恢复焦点')
          }
        />
      ) : null}
      <main className="design-workspace">
        <DesignTree
          nodes={data.nodes}
          relations={data.relations}
          attention={data.attention}
          candidates={data.changeSet?.changes ?? []}
          activeChangeId={activeChangeId}
          onInspectCandidate={selectCandidate}
          onSelect={selectNode}
          onPin={pinNode}
        />
        <Inspector
          node={primary}
          relations={data.relations}
          changes={data.changeSet?.changes ?? []}
          attention={data.attention}
          onConfirmRoot={(nodeId) =>
            void run(
              () =>
                api.action('confirm_root', {
                  targetId: nodeId,
                  hostSessionRef: identity.hostSessionRef,
                }),
              '根目标已确认',
            )
          }
          onPrompt={(intent) => void copyPrompt(intent)}
        />
        <ChangePanel
          data={data}
          identity={identity}
          api={api}
          run={run}
          activeChangeId={activeChangeId}
          onInspectChange={selectCandidate}
          onPreviewChange={setPreviewedChangeId}
        />
      </main>
      <footer className="statusline">
        <span>
          <i className="online-dot" /> Sidecar 已连接
        </span>
        <span>
          Working: {data.workspace.nodeCount} nodes · {data.workspace.relationCount} relations
        </span>
        <span title="Sidecar 与任务生命周期解耦；关闭页面或 Codex 任务不会停止，新任务会健康检查并复用。">
          后台按项目常驻 · 自动复用
        </span>
        <span>选择会标记为 Agent 可见焦点，但不会自动调用模型</span>
      </footer>
      {error ? (
        <div className="toast error">
          <div>
            <strong>操作未完成</strong>
            <p>{error}</p>
          </div>
          <button onClick={() => setError(null)}>×</button>
        </div>
      ) : null}
      {notice ? (
        <div className="toast success">
          <span>✓</span>
          <strong>{notice}</strong>
        </div>
      ) : null}
      {lifecycleDialog && data.lifecycle.available ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`lifecycle-dialog ${lifecycleDialog === 'clear' ? 'destructive' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lifecycle-dialog-title"
          >
            <header>
              <div>
                <small>PROJECT WORKSPACE</small>
                <h2 id="lifecycle-dialog-title">
                  {lifecycleDialog === 'clear' ? '归档并清空工作区' : '关闭工作区'}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="取消"
                disabled={lifecycleBusy}
                onClick={() => setLifecycleDialog(null)}
              >
                ×
              </button>
            </header>
            {lifecycleDialog === 'close' ? (
              <>
                <p>
                  这会停止当前项目的 Sidecar，但不会删除设计树。稍后 Agent 再次使用 TreeDiagram
                  时，可能会自动触发启动流程。
                </p>
                <div className="lifecycle-fact">
                  <span>保留位置</span>
                  <code>{data.lifecycle.projectRoot}</code>
                </div>
              </>
            ) : (
              <>
                <p>
                  当前工作区会先完整归档，再从项目中清空。TreeDiagram
                  不会永久删除历史；如需彻底删除，必须前往归档路径手动删除。
                </p>
                <div className="archive-preview">
                  <span>将留下的归档文件夹</span>
                  <code>{data.lifecycle.archivePath}</code>
                </div>
                <label className="confirmation-field">
                  <span>
                    输入项目名称 <b>{data.lifecycle.confirmationText}</b> 以确认
                  </span>
                  <input
                    autoFocus
                    value={confirmationText}
                    onChange={(event) => setConfirmationText(event.target.value)}
                    placeholder={data.lifecycle.confirmationText}
                  />
                </label>
              </>
            )}
            <footer>
              <button
                className="button ghost"
                type="button"
                disabled={lifecycleBusy}
                onClick={() => setLifecycleDialog(null)}
              >
                取消
              </button>
              <button
                className={`button ${lifecycleDialog === 'clear' ? 'danger-confirm' : 'primary'}`}
                type="button"
                disabled={
                  lifecycleBusy ||
                  (lifecycleDialog === 'clear' &&
                    confirmationText !== data.lifecycle.confirmationText)
                }
                onClick={() => void submitLifecycle()}
              >
                {lifecycleBusy
                  ? '正在处理…'
                  : lifecycleDialog === 'clear'
                    ? '确认归档并清空'
                    : '关闭 Sidecar'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
