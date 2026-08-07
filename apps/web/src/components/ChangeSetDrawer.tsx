import { useCallback, useEffect, useState } from 'react';
import type {
  ChangeSet,
  CheckConsistencyResponse,
  ReviewItemsResponse,
} from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';

/**
 * ChangeSet 抽屉（§14.4）：base Release、变更数量、root change 警告、
 * consistency preview、复核项处理与 adopt/abandon/publish 动作。
 * 按钮启用条件完全来自服务端状态，前端仅显示防误触。
 */

interface ChangeSetView {
  changeSet: ChangeSet | null;
  counts: {
    nodesCreated: number;
    nodesRevised: number;
    nodesRemoved: number;
    relationsCreated: number;
    relationsRevised: number;
    relationsRemoved: number;
  } | null;
  rootChange: boolean;
}

export function ChangeSetDrawer() {
  const { state, api, dispatch, refresh } = useApp();
  const [view, setView] = useState<ChangeSetView | null>(null);
  const [review, setReview] = useState<ReviewItemsResponse | null>(null);
  const [check, setCheck] = useState<CheckConsistencyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);

  const open = state.drawerOpen;

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const current = await api.get<ChangeSetView>('/change-set/current');
      setView(current);
      if (current.changeSet) {
        setReview(await api.get<ReviewItemsResponse>('/change-set/review-items'));
      } else {
        setReview(null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [api]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, state.refreshCounter]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const cs = view?.changeSet ?? null;
  const counts = view?.counts ?? null;

  return (
    <aside className="drawer" aria-label="ChangeSet">
      <header className="panel-header">
        <h2>ChangeSet</h2>
        <button onClick={() => dispatch({ type: 'drawer', open: false })}>关闭</button>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {!cs ? (
        <p className="empty">当前没有 live ChangeSet。编辑节点或关系后自动创建。</p>
      ) : (
        <div className="drawer-body">
          <p>
            状态：<strong>{cs.status}</strong> · base Release：
            {cs.baseReleaseId ? <span className="mono">{cs.baseReleaseId}</span> : '（首版）'}
          </p>
          {view?.rootChange ? (
            <p className="warning">⚠ 包含 root change：影响整棵设计树，publish 前请仔细复核。</p>
          ) : null}
          {counts ? (
            <table className="counts">
              <tbody>
                <tr>
                  <td>节点</td>
                  <td>+{counts.nodesCreated}</td>
                  <td>~{counts.nodesRevised}</td>
                  <td>-{counts.nodesRemoved}</td>
                </tr>
                <tr>
                  <td>关系</td>
                  <td>+{counts.relationsCreated}</td>
                  <td>~{counts.relationsRevised}</td>
                  <td>-{counts.relationsRemoved}</td>
                </tr>
              </tbody>
            </table>
          ) : null}

          <div className="button-row">
            <button
              disabled={busy || cs.status !== 'open'}
              onClick={() => void act(() => api!.post('/change-set/adopt'))}
            >
              Adopt and reevaluate
            </button>
            <button
              className="danger"
              disabled={busy || cs.status === 'published' || cs.status === 'abandoned'}
              onClick={() => {
                if (window.confirm('放弃当前 ChangeSet 的全部候选？')) {
                  void act(() => api!.post('/change-set/abandon'));
                }
              }}
            >
              Abandon
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setCheck(await api!.post<CheckConsistencyResponse>('/change-set/check'));
                })
              }
            >
              一致性预览
            </button>
          </div>

          {check ? (
            <div className="check-result">
              <h3>
                一致性预览：{check.blockingCount} blocking / {check.warningCount} warning
              </h3>
              <ul>
                {check.issues.map((issue, i) => (
                  <li key={i} className={issue.severity === 'blocking' ? 'error' : 'warning'}>
                    [{issue.severity}] {issue.code}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {review && review.items.length > 0 ? (
            <div className="review-items">
              <h3>
                复核项：{review.pendingCount} pending / {review.blockedCount} blocked /{' '}
                {review.resolvedCount} resolved
              </h3>
              <ul>
                {review.items.map((item) => (
                  <li key={item.id} className={`review-item status-${item.status}`}>
                    <span className="mono">{item.entityRevisionId ?? item.entityKind}</span>
                    <span className="badge">{item.reasonCode}</span>
                    <span className="badge">{item.status}</span>
                    {item.status === 'pending' ? (
                      <span className="button-row inline-actions">
                        {(['valid', 'revise', 'refute', 'supersede'] as const).map((verdict) => (
                          <button
                            key={verdict}
                            disabled={busy}
                            onClick={() =>
                              void act(() =>
                                api!.post(`/review-items/${item.id}/resolve`, {
                                  verdict,
                                  rationale: `人工复核结论：${verdict}`,
                                }),
                              )
                            }
                          >
                            {verdict}
                          </button>
                        ))}
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api!.post(`/review-items/${item.id}/block`, {
                                rationale: '人工复核：无法确认，标记阻塞',
                              }),
                            )
                          }
                        >
                          block
                        </button>
                      </span>
                    ) : null}
                    {item.status === 'blocked' ? (
                      <span className="button-row inline-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api!.post(`/review-items/${item.id}/resolve`, {
                                verdict: 'valid',
                                rationale: '解除阻塞：复核确认为 valid',
                              }),
                            )
                          }
                        >
                          解除阻塞（valid）
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="publish-box">
            <h3>发布</h3>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Release 摘要（必填）"
              aria-label="Release 摘要"
            />
            <button
              disabled={busy || cs.status !== 'ready' || !summary.trim()}
              onClick={() =>
                void act(async () => {
                  await api!.post('/change-set/publish', { summary: summary.trim() });
                  setSummary('');
                  setCheck(null);
                })
              }
            >
              Publish（仅 ready 且 checker 通过）
            </button>
            {cs.status !== 'ready' ? (
              <p className="hint">
                全部复核项 resolved 且一致性检查通过后，ChangeSet 自动进入 ready。
              </p>
            ) : null}
          </div>
        </div>
      )}
    </aside>
  );
}
