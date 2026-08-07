import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRun, WorkflowType } from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';

/**
 * Workflow 面板（§14.5）：选择 workflow 与 target，显示当前步骤、
 * summary/warnings/提案数量；活跃 run 可取消（只停止后续步骤，不回滚已写入提案）。
 * M2 阶段模型未配置：启动会返回 MODEL_NOT_CONFIGURED，面板如实显示。
 */

interface WorkflowListResponse {
  runs: WorkflowRun[];
  nextCursor: string | null;
}

const WORKFLOW_TYPES: WorkflowType[] = ['initialize', 'derive', 'grill', 'unbox', 'reevaluate'];

export function WorkflowPanel() {
  const { state, api, dispatch, refresh } = useApp();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflowType, setWorkflowType] = useState<WorkflowType>('initialize');
  const [focusInstruction, setFocusInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const res = await api.get<WorkflowListResponse>('/workflows?limit=20');
      setRuns(res.runs);
      const active = res.runs.some((r) => ['queued', 'running', 'waiting_user'].includes(r.status));
      dispatch({ type: 'workflow-active', active });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [api, dispatch]);

  useEffect(() => {
    void load();
  }, [load, state.refreshCounter]);

  // 活跃 run 的 1s 轮询由全局 status 轮询驱动 refresh；这里直接随 refreshCounter 重读。

  const start = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/workflows', {
        workflowType,
        targetNodeId: state.selectedNodeId,
        changeSetId: null, // reevaluate 时由服务端按 live ChangeSet 不变量解析
        sourceAssetIds: [],
        focusInstruction: focusInstruction.trim() || null,
      });
      setFocusInstruction('');
      await load();
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MODEL_NOT_CONFIGURED') {
        setError('Agent 工作流尚未配置模型提供方。当前可继续使用手动编辑。');
      } else {
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (runId: string) => {
    if (!api) return;
    try {
      await api.post(`/workflows/${runId}/cancel`);
      await load();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  };

  const isActive = (run: WorkflowRun) => ['queued', 'running', 'waiting_user'].includes(run.status);

  return (
    <section className="panel workflow-panel" aria-label="Workflow">
      <header className="panel-header">
        <h2>Workflow</h2>
      </header>
      <div className="workflow-start">
        <label>
          工作流
          <select
            value={workflowType}
            onChange={(e) => setWorkflowType(e.target.value as WorkflowType)}
          >
            {WORKFLOW_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          聚焦指令（可选；target 为当前选中节点）
          <input
            value={focusInstruction}
            onChange={(e) => setFocusInstruction(e.target.value)}
            placeholder="例如：重点关注风险分支"
          />
        </label>
        <button disabled={busy} onClick={() => void start()}>
          启动
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.id} className={`run status-${run.status}`}>
            <div>
              <strong>{run.workflowType}</strong> · {run.status} · 步骤：{run.currentStep}
            </div>
            {run.summary ? (
              <pre className="run-summary">{JSON.stringify(run.summary, null, 2)}</pre>
            ) : null}
            {run.error ? <p className="error">{JSON.stringify(run.error)}</p> : null}
            {isActive(run) ? (
              <button className="danger" onClick={() => void cancel(run.id)}>
                取消（不回滚已写入提案）
              </button>
            ) : null}
          </li>
        ))}
        {runs.length === 0 ? <p className="empty">暂无 WorkflowRun。</p> : null}
      </ul>
    </section>
  );
}
