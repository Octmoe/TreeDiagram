import { useCallback, useEffect, useState } from 'react';
import type {
  DelegationResolution,
  NodeDetail,
  NodeHistoryResponse,
  NodeRelationsResponse,
  RelationDetail,
} from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';

/**
 * Inspector（§14.3）：Overview / Relations / Evidence / History / Delegation 五个 Tab。
 * 编辑已确认内容时明确提示「保存为候选修订」——所有写入都是新 revision。
 */

type Tab = 'overview' | 'relations' | 'evidence' | 'history' | 'delegation';

const EPISTEMIC_TYPES = new Set(['claim', 'constraint', 'risk']);

export function Inspector() {
  const { state, api, refresh } = useApp();
  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodeId = state.selectedNodeId;

  const load = useCallback(async () => {
    if (!api || !nodeId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await api.get<NodeDetail>(`/nodes/${nodeId}?view=working`));
      setError(null);
    } catch (err) {
      setDetail(null);
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [api, nodeId]);

  useEffect(() => {
    void load();
  }, [load, state.refreshCounter]);

  if (!nodeId) {
    return (
      <section className="panel inspector" aria-label="Inspector">
        <p className="empty">在左侧树中选择一个节点。</p>
      </section>
    );
  }

  return (
    <section className="panel inspector" aria-label="Inspector">
      <header className="panel-header">
        <h2>{detail?.revision.displayTitle ?? '…'}</h2>
        <nav className="tabs">
          {(['overview', 'relations', 'evidence', 'history', 'delegation'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {detail ? (
        <>
          {tab === 'overview' ? <OverviewTab detail={detail} onSaved={() => void load()} /> : null}
          {tab === 'relations' ? <RelationsTab nodeId={nodeId} /> : null}
          {tab === 'evidence' ? <EvidenceTab nodeId={nodeId} /> : null}
          {tab === 'history' ? <HistoryTab nodeId={nodeId} /> : null}
          {tab === 'delegation' ? (
            <DelegationTab
              nodeId={nodeId}
              onChanged={() => {
                void load();
                refresh();
              }}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// ---- Overview ----

function OverviewTab({ detail, onSaved }: { detail: NodeDetail; onSaved: () => void }) {
  const { api, refresh, reportError } = useApp();
  const [title, setTitle] = useState(detail.revision.displayTitle);
  const [contentText, setContentText] = useState(detail.revision.contentText);
  const [attributesText, setAttributesText] = useState(
    JSON.stringify(detail.revision.attributes, null, 2),
  );
  const [approvalState, setApprovalState] = useState(detail.revision.approvalState);
  const [epistemicState, setEpistemicState] = useState<string>(
    detail.revision.epistemicState ?? 'assumed',
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTitle(detail.revision.displayTitle);
    setContentText(detail.revision.contentText);
    setAttributesText(JSON.stringify(detail.revision.attributes, null, 2));
    setApprovalState(detail.revision.approvalState);
    setEpistemicState(detail.revision.epistemicState ?? 'assumed');
    setError(null);
    setNotice(null);
  }, [detail]);

  const confirmed =
    detail.revision.approvalState === 'user_confirmed' ||
    detail.revision.approvalState === 'ai_confirmed';

  const onSave = async () => {
    if (!api) return;
    let attributes: unknown;
    try {
      attributes = JSON.parse(attributesText);
    } catch {
      setError('attributes 不是合法 JSON');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/nodes/${detail.node.id}/revisions`, {
        baseRevisionId: detail.revision.id,
        displayTitle: title,
        contentText,
        roles: detail.revision.roles,
        attributes,
        approvalState,
        epistemicState: EPISTEMIC_TYPES.has(detail.node.nodeType) ? epistemicState : null,
      });
      setNotice('已保存为候选修订（新 revision，不影响 Release）');
      refresh();
      onSaved();
    } catch (err) {
      reportError(err, '保存修订失败');
    } finally {
      setBusy(false);
    }
  };

  const onArchive = async () => {
    if (!api) return;
    if (!window.confirm(`归档节点「${detail.revision.displayTitle}」？（逻辑归档，历史可溯）`))
      return;
    try {
      await api.post(`/nodes/${detail.node.id}/archive`);
      refresh();
    } catch (err) {
      reportError(err, '归档节点失败');
    }
  };

  return (
    <div className="tab-body">
      <p className="hint">
        revision #{detail.revision.revisionNumber} · {detail.revision.createdAt}
        {confirmed ? ' · 已确认内容：编辑后将「保存为候选修订」，原 revision 永不被改写' : ''}
      </p>
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        正文
        <textarea value={contentText} onChange={(e) => setContentText(e.target.value)} rows={6} />
      </label>
      <label>
        确认状态
        <select
          value={approvalState}
          onChange={(e) => setApprovalState(e.target.value as typeof approvalState)}
        >
          <option value="draft">draft</option>
          <option value="tentative">tentative</option>
          <option value="user_confirmed">user_confirmed</option>
        </select>
      </label>
      {EPISTEMIC_TYPES.has(detail.node.nodeType) ? (
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
      <label>
        attributes（JSON）
        <textarea
          value={attributesText}
          onChange={(e) => setAttributesText(e.target.value)}
          rows={5}
          spellCheck={false}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
      <div className="button-row">
        <button onClick={() => void onSave()} disabled={busy}>
          {busy ? '保存中…' : '保存为候选修订'}
        </button>
        <button className="danger" onClick={() => void onArchive()}>
          归档节点
        </button>
      </div>
    </div>
  );
}

// ---- Relations ----

function relationRow(
  rel: RelationDetail,
  direction: 'in' | 'out',
  onJump: (nodeId: string) => void,
) {
  const { relation, revision } = rel;
  return (
    <li key={relation.id}>
      <span className="badge type">{relation.relationType}</span>
      <span className={`badge approval-${revision.approvalState}`}>{revision.approvalState}</span>
      <span className="relation-endpoint mono">
        {direction === 'out' ? revision.toNodeRevisionId : revision.fromNodeRevisionId}
      </span>
      {revision.rationaleText ? <span className="rationale">{revision.rationaleText}</span> : null}
      <button
        onClick={() => onJump(relation.id)}
        title="在关系中定位（跳转其另一端需选中端点节点）"
      >
        详情
      </button>
    </li>
  );
}

function RelationsTab({ nodeId }: { nodeId: string }) {
  const { api, dispatch } = useApp();
  const [data, setData] = useState<NodeRelationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .get<NodeRelationsResponse>(`/nodes/${nodeId}/relations?direction=both&view=working`)
      .then(setData)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err)),
      );
  }, [api, nodeId]);

  const jump = (_relationId: string) => {
    // 端点是 revision id；跳转通过搜索该关系另一端的节点实现留给树选择。
    void _relationId;
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="empty">加载中…</p>;
  return (
    <div className="tab-body">
      <h3>入边（{data.incoming.length}）</h3>
      <ul className="relation-list">{data.incoming.map((r) => relationRow(r, 'in', jump))}</ul>
      <h3>出边（{data.outgoing.length}）</h3>
      <ul className="relation-list">{data.outgoing.map((r) => relationRow(r, 'out', jump))}</ul>
      <NewRelationForm nodeId={nodeId} onCreated={() => dispatch({ type: 'refresh' })} />
    </div>
  );
}

function NewRelationForm({ nodeId, onCreated }: { nodeId: string; onCreated: () => void }) {
  const { api, reportError } = useApp();
  const [open, setOpen] = useState(false);
  const [relationType, setRelationType] = useState('supports');
  const [selfRevisionId, setSelfRevisionId] = useState<string | null>(null);
  const [otherRevisionId, setOtherRevisionId] = useState('');
  const [outgoing, setOutgoing] = useState(true);
  const [rationale, setRationale] = useState('');
  const [attributesText, setAttributesText] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api || !open) return;
    api
      .get<NodeDetail>(`/nodes/${nodeId}?view=working`)
      .then((d) => setSelfRevisionId(d.revision.id))
      .catch(() => setSelfRevisionId(null));
  }, [api, nodeId, open]);

  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        新建关系
      </button>
    );
  }

  const submit = async () => {
    if (!api || !selfRevisionId) return;
    let attributes: unknown;
    try {
      attributes = JSON.parse(attributesText);
    } catch {
      setError('attributes 不是合法 JSON');
      return;
    }
    try {
      await api.post('/relations', {
        relationType,
        fromNodeRevisionId: outgoing ? selfRevisionId : otherRevisionId,
        toNodeRevisionId: outgoing ? otherRevisionId : selfRevisionId,
        rationaleText: rationale,
        attributes,
        approvalState: 'tentative',
      });
      setOpen(false);
      onCreated();
    } catch (err) {
      reportError(err, '创建关系失败');
    }
  };

  return (
    <div className="relation-form">
      <h3>新建关系</h3>
      <label>
        类型
        <select value={relationType} onChange={(e) => setRelationType(e.target.value)}>
          {[
            'contains',
            'depends_on',
            'derived_from',
            'supports',
            'contradicts',
            'constrains',
            'resolves',
            'supersedes',
          ].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" checked={outgoing} onChange={(e) => setOutgoing(e.target.checked)} />
        当前节点为 from（否则为 to）
      </label>
      <label>
        另一端 revision id
        <input
          value={otherRevisionId}
          onChange={(e) => setOtherRevisionId(e.target.value)}
          placeholder="目标节点当前 working 修订 id"
          className="mono"
        />
      </label>
      <label>
        理由
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </label>
      <label>
        attributes（JSON；contradicts 需 {'{ "blocking": boolean }'}）
        <textarea
          value={attributesText}
          onChange={(e) => setAttributesText(e.target.value)}
          rows={2}
          spellCheck={false}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <div className="button-row">
        <button onClick={() => void submit()}>创建候选关系</button>
        <button className="secondary" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---- Evidence ----

function EvidenceTab({ nodeId }: { nodeId: string }) {
  const { api } = useApp();
  const [rows, setRows] = useState<RelationDetail[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .get<NodeRelationsResponse>(`/nodes/${nodeId}/relations?direction=both&view=working`)
      .then((rels) => {
        setRows(
          [...rels.incoming, ...rels.outgoing].filter(
            (r) =>
              r.relation.relationType === 'supports' || r.relation.relationType === 'contradicts',
          ),
        );
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err)),
      );
  }, [api, nodeId]);

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="tab-body">
      <h3>支持 / 反驳关系（{rows.length}）</h3>
      <ul className="relation-list">
        {rows.map((rel) => (
          <li key={rel.relation.id}>
            <span className="badge type">{rel.relation.relationType}</span>
            <span className="rationale">{rel.revision.rationaleText}</span>
            <span className="mono relation-endpoint">
              {rel.revision.fromNodeRevisionId} → {rel.revision.toNodeRevisionId}
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Evidence 节点的方法、前提与局限记录在其 attributes 中；选中该 Evidence 节点后在 Overview
        查看与编辑。
      </p>
    </div>
  );
}

// ---- History ----

function HistoryTab({ nodeId }: { nodeId: string }) {
  const { api } = useApp();
  const [history, setHistory] = useState<NodeHistoryResponse | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    api
      .get<NodeHistoryResponse>(`/nodes/${nodeId}/history`)
      .then(setHistory)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err)),
      );
  }, [api, nodeId]);

  if (error) return <p className="error">{error}</p>;
  if (!history) return <p className="empty">加载中…</p>;

  const revisions = [...history.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const compare = compareId ? revisions.find((r) => r.id === compareId) : null;
  const latest = revisions[0];

  return (
    <div className="tab-body">
      <h3>修订历史（{revisions.length}，倒序）</h3>
      <ul className="history-list">
        {revisions.map((r) => (
          <li key={r.id}>
            <label className="inline">
              <input
                type="radio"
                name="compare"
                checked={compareId === r.id}
                onChange={() => setCompareId(r.id)}
              />
              #{r.revisionNumber} · {r.createdAt} · {r.approvalState}
              {r.epistemicState ? ` · ${r.epistemicState}` : ''} · {r.authorKind}
            </label>
            <div className="history-title">{r.displayTitle}</div>
          </li>
        ))}
      </ul>
      {compare && latest && compare.id !== latest.id ? (
        <div className="diff">
          <h3>
            对照：#{compare.revisionNumber} ↔ #{latest.revisionNumber}
          </h3>
          <table className="field-diff">
            <tbody>
              {(
                [
                  ['标题', compare.displayTitle, latest.displayTitle],
                  ['确认状态', compare.approvalState, latest.approvalState],
                  ['认知状态', compare.epistemicState ?? '—', latest.epistemicState ?? '—'],
                  ['角色', compare.roles.join(','), latest.roles.join(',')],
                  [
                    'attributes',
                    JSON.stringify(compare.attributes),
                    JSON.stringify(latest.attributes),
                  ],
                ] as const
              ).map(([field, a, b]) => (
                <tr key={field} className={a === b ? '' : 'changed'}>
                  <td>{field}</td>
                  <td>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="content-diff">
            <div>
              <h4>#{compare.revisionNumber} 正文</h4>
              <pre>{compare.contentText}</pre>
            </div>
            <div>
              <h4>#{latest.revisionNumber} 正文</h4>
              <pre>{latest.contentText}</pre>
            </div>
          </div>
        </div>
      ) : (
        <p className="hint">选择任意修订与最新修订对照。</p>
      )}
    </div>
  );
}

// ---- Delegation ----

function DelegationTab({ nodeId, onChanged }: { nodeId: string; onChanged: () => void }) {
  const { api, reportError } = useApp();
  const [resolution, setResolution] = useState<DelegationResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      setResolution(await api.get<DelegationResolution>(`/nodes/${nodeId}/delegation`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [api, nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setMode = async (mode: 'human_final' | 'ai_managed') => {
    if (!api) return;
    try {
      await api.put(`/nodes/${nodeId}/delegation`, { mode });
      await load();
      onChanged();
    } catch (err) {
      reportError(err, '设置托管模式失败');
    }
  };

  const revoke = async () => {
    if (!api) return;
    try {
      await api.del(`/nodes/${nodeId}/delegation`);
      await load();
      onChanged();
    } catch (err) {
      reportError(err, '撤销托管设置失败');
    }
  };

  if (!resolution) return <p className="empty">加载中…</p>;
  return (
    <div className="tab-body">
      <p>
        生效模式：<strong>{resolution.mode}</strong>
        {resolution.inheritedFromNodeId
          ? `（继承自 ${resolution.inheritedFromNodeId}）`
          : resolution.explicitPolicy
            ? '（本节点显式策略）'
            : '（默认）'}
      </p>
      {resolution.warnings.length > 0 ? (
        <ul className="warning-list">
          {resolution.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="button-row">
        <button onClick={() => void setMode('ai_managed')}>设为 AI 托管</button>
        <button onClick={() => void setMode('human_final')}>设为人类终审</button>
        {resolution.explicitPolicy ? (
          <button className="danger" onClick={() => void revoke()}>
            撤销显式策略
          </button>
        ) : null}
      </div>
      <p className="hint">
        设置/撤销托管策略是不可托管操作，只能由用户执行；撤销不否定历史 AI 决策。
      </p>
    </div>
  );
}
