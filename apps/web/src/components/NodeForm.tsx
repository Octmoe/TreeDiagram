import { useState, type FormEvent } from 'react';
import type { NodeDetail, NodeType, RelationDetail } from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';

/**
 * 新建候选节点表单。类型特定 attributes 以 JSON 模板编辑（每类型给出默认模板）；
 * 选择父节点时同时创建 contains 候选关系（显式关系修订，§14.2 不做拖拽）。
 */

const NODE_TYPES: NodeType[] = [
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

const ATTRIBUTE_TEMPLATES: Record<NodeType, string> = {
  topic: '{}',
  claim: '{}',
  goal: '{ "priorityNote": null }',
  constraint: '{ "strength": "hard" }',
  risk: '{ "impactNote": null }',
  question: '{ "blocking": false }',
  option: '{}',
  decision:
    '{ "importance": "important", "noAlternativeFound": false, "alternativeSearchNote": null }',
  evidence:
    '{ "evidenceKind": "user_observation", "sourceAssetId": null, "method": "", "premises": [], "limitations": [] }',
  validation_method:
    '{ "method": "方法", "expectedSignal": "预期信号", "successInterpretation": "成功解释", "failureInterpretation": "失败解释" }',
};

const EPISTEMIC_TYPES = new Set<NodeType>(['claim', 'constraint', 'risk']);
const ROOT_TYPES = new Set<NodeType>(['claim', 'goal', 'constraint']);

export function NodeForm({ onCreated }: { onCreated: (nodeId: string) => void }) {
  const { api, state } = useApp();
  const [nodeType, setNodeType] = useState<NodeType>('topic');
  const [title, setTitle] = useState('');
  const [contentText, setContentText] = useState('');
  const [isRoot, setIsRoot] = useState(false);
  const [approvalState, setApprovalState] = useState('tentative');
  const [epistemicState, setEpistemicState] = useState('unexamined');
  const [attributesText, setAttributesText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parentNodeId = state.selectedNodeId;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!api) return;
    setError(null);
    let attributes: unknown;
    try {
      attributes = JSON.parse(attributesText);
    } catch {
      setError('attributes 不是合法 JSON');
      return;
    }
    setBusy(true);
    try {
      const detail = await api.post<NodeDetail>('/nodes', {
        nodeType,
        displayTitle: title,
        contentText,
        roles: isRoot ? ['root'] : [],
        attributes,
        approvalState,
        epistemicState: EPISTEMIC_TYPES.has(nodeType) ? epistemicState : null,
      });
      if (parentNodeId && parentNodeId !== detail.node.id) {
        // 父节点当前 working 修订：先读取再建 contains
        const parent = await api.get<NodeDetail>(`/nodes/${parentNodeId}?view=working`);
        await api.post<RelationDetail>('/relations', {
          relationType: 'contains',
          fromNodeRevisionId: parent.revision.id,
          toNodeRevisionId: detail.revision.id,
          rationaleText: `将「${detail.revision.displayTitle}」挂到「${parent.revision.displayTitle}」下`,
          attributes: {},
          approvalState,
        });
      }
      onCreated(detail.node.id);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="node-form" onSubmit={(e) => void onSubmit(e)}>
      <p className="hint">
        {parentNodeId ? '将在当前选中节点下创建（自动建立 contains 关系）' : '将作为顶层节点创建'}
      </p>
      <label>
        类型
        <select
          value={nodeType}
          onChange={(e) => {
            const t = e.target.value as NodeType;
            setNodeType(t);
            setAttributesText(ATTRIBUTE_TEMPLATES[t]);
            if (!ROOT_TYPES.has(t)) setIsRoot(false);
          }}
        >
          {NODE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        正文
        <textarea value={contentText} onChange={(e) => setContentText(e.target.value)} rows={3} />
      </label>
      <label>
        确认状态
        <select value={approvalState} onChange={(e) => setApprovalState(e.target.value)}>
          <option value="draft">draft</option>
          <option value="tentative">tentative</option>
          <option value="user_confirmed">user_confirmed</option>
        </select>
      </label>
      {EPISTEMIC_TYPES.has(nodeType) ? (
        <label>
          认知状态
          <select value={epistemicState} onChange={(e) => setEpistemicState(e.target.value)}>
            <option value="unexamined">unexamined</option>
            <option value="assumed">assumed</option>
            <option value="supported">supported</option>
            <option value="refuted">refuted</option>
          </select>
        </label>
      ) : null}
      {ROOT_TYPES.has(nodeType) ? (
        <label className="inline">
          <input type="checkbox" checked={isRoot} onChange={(e) => setIsRoot(e.target.checked)} />
          root 角色
        </label>
      ) : null}
      <label>
        attributes（JSON）
        <textarea
          value={attributesText}
          onChange={(e) => setAttributesText(e.target.value)}
          rows={3}
          spellCheck={false}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy || !title.trim()}>
        {busy ? '创建中…' : '创建候选节点'}
      </button>
    </form>
  );
}
