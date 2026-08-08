import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceAsset, WorkflowRun, WorkflowType } from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';

/**
 * Workflow 面板（§14.5）：选择 workflow 与 target，显示当前步骤、
 * summary/warnings/提案数量；活跃 run 可取消（只停止后续步骤，不回滚已写入提案）。
 * M2 阶段模型未配置：启动会返回 MODEL_NOT_CONFIGURED，面板如实显示。
 * Initialize 支持暂存多个 source 文件（可多次多选追加、列表查看/移除），
 * 启动时逐个上传（POST /sources）并以 sourceAssetIds 启动工作流。
 */

interface WorkflowListResponse {
  runs: WorkflowRun[];
  nextCursor: string | null;
}

const WORKFLOW_TYPES: WorkflowType[] = ['initialize', 'derive', 'grill', 'unbox', 'reevaluate'];

/** 暂存的待上传文件；key 用于去重与移除。 */
interface StagedSource {
  key: string;
  file: File;
}

/** 去重键：同名同大小视为同一文件（避免重复暂存）。 */
function stagedKey(file: File): string {
  return `${file.name}:${file.size}`;
}

function isMarkdown(file: File): boolean {
  return /\.(md|markdown)$/i.test(file.name) || file.type === 'text/markdown';
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

export function WorkflowPanel() {
  const { state, api, dispatch, refresh, reportError } = useApp();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflowType, setWorkflowType] = useState<WorkflowType>('initialize');
  const [focusInstruction, setFocusInstruction] = useState('');
  const [stagedSources, setStagedSources] = useState<StagedSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // initialize：先把暂存文件逐个上传为 source，再带 sourceAssetIds 启动
      let sourceAssetIds: string[] = [];
      if (workflowType === 'initialize') {
        if (stagedSources.length === 0) {
          setError('Initialize 需要至少一个 source：请先选择文件（可多次多选追加）。');
          setBusy(false);
          return;
        }
        sourceAssetIds = await uploadStagedSources();
      }
      await api.post('/workflows', {
        workflowType,
        targetNodeId: state.selectedNodeId,
        changeSetId: null, // reevaluate 时由服务端按 live ChangeSet 不变量解析
        sourceAssetIds,
        focusInstruction: focusInstruction.trim() || null,
      });
      setFocusInstruction('');
      setStagedSources([]);
      await load();
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MODEL_NOT_CONFIGURED') {
        reportError(
          new Error('Agent 工作流尚未配置模型提供方。当前可继续使用手动编辑。'),
          '无法启动工作流',
        );
      } else {
        reportError(err, '无法启动工作流');
      }
    } finally {
      setBusy(false);
    }
  };

  /** 逐个读取暂存文件并上传；任一失败即中断并如实报错（已上传的 source 保留可复用）。 */
  const uploadStagedSources = async (): Promise<string[]> => {
    const ids: string[] = [];
    for (const { file } of stagedSources) {
      const markdown = isMarkdown(file);
      const asset = await api!.post<SourceAsset>('/sources', {
        kind: markdown ? 'markdown' : 'text',
        originalName: file.name,
        mediaType: markdown ? 'text/markdown' : 'text/plain',
        contentText: await file.text(),
      });
      ids.push(asset.id);
    }
    return ids;
  };

  const addStagedSources = (files: FileList | null) => {
    if (!files) return;
    // FileList 是 live 视图：必须同步拷贝，否则重置 input 后 updater 读到空列表
    const snapshot = [...files];
    setStagedSources((current) => {
      const existing = new Set(current.map((s) => s.key));
      const appended = snapshot
        .map((file) => ({ key: stagedKey(file), file }))
        .filter((s) => !existing.has(s.key));
      return [...current, ...appended];
    });
    // 重置 input，允许移除后再次选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeStagedSource = (key: string) => {
    setStagedSources((current) => current.filter((s) => s.key !== key));
  };

  const cancel = async (runId: string) => {
    if (!api) return;
    try {
      await api.post(`/workflows/${runId}/cancel`);
      await load();
      refresh();
    } catch (err) {
      reportError(err, '无法取消工作流');
    }
  };

  /** 失败 run 的 error 详情弹窗（run.error 为服务端序列化的 DomainError）。 */
  const showRunError = (run: WorkflowRun) => {
    const raw = (run.error ?? {}) as Record<string, unknown>;
    dispatch({
      type: 'error-show',
      report: {
        title: `工作流失败：${run.workflowType}`,
        code: typeof raw['code'] === 'string' ? raw['code'] : 'UNKNOWN',
        message: typeof raw['message'] === 'string' ? raw['message'] : JSON.stringify(run.error),
        ...(raw['details'] && typeof raw['details'] === 'object'
          ? { details: raw['details'] as Record<string, unknown> }
          : {}),
      },
    });
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
      {workflowType === 'initialize' ? (
        <div className="source-staging">
          <label>
            Source 文件（markdown/纯文本，可多次多选追加）
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              disabled={busy}
              onChange={(e) => addStagedSources(e.target.files)}
            />
          </label>
          {stagedSources.length > 0 ? (
            <ul className="staged-source-list">
              {stagedSources.map((s) => (
                <li key={s.key}>
                  <span className="staged-source-name">{s.file.name}</span>
                  <span className="badge">{formatSize(s.file.size)}</span>
                  <span className="badge">{isMarkdown(s.file) ? 'markdown' : 'text'}</span>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => removeStagedSource(s.key)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">尚未选择文件；启动前至少需要一个 source。</p>
          )}
        </div>
      ) : null}
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
            {run.error ? (
              <button className="danger" onClick={() => showRunError(run)}>
                查看错误详情
              </button>
            ) : null}
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
