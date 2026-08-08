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

interface TracePreview {
  text: string;
  originalChars: number;
  truncated: boolean;
}

interface ModelCallTrace {
  id: string;
  stage: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  provider: string;
  model: string;
  reasoningEffort: string;
  maxOutputTokens: number | null;
  outputSchemaName: string;
  startedAt: string;
  finishedAt: string | null;
  request: { instructions: TracePreview; input: TracePreview };
  response: TracePreview | null;
  providerResponseId: string | null;
  usage: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
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

function modelCallsOf(run: WorkflowRun): ModelCallTrace[] {
  const value = run.checkpoint['modelCalls'];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ModelCallTrace =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { stage?: unknown }).stage === 'string',
  );
}

function stageLabel(stage: string): string {
  if (stage === 'initialize_extract') return 'Initialize ① 提取候选';
  if (stage === 'initialize_root') return 'Initialize ② 生成根节点';
  if (stage.startsWith('reevaluate_batch_')) {
    return `Re-evaluate 批次 ${stage.slice('reevaluate_batch_'.length)}`;
  }
  return stage;
}

function elapsedLabel(call: ModelCallTrace): string {
  const start = Date.parse(call.startedAt);
  const end = call.finishedAt ? Date.parse(call.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '耗时未知';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return call.status === 'running' ? `已等待 ${seconds}s` : `耗时 ${seconds}s`;
}

function Preview({ title, preview }: { title: string; preview: TracePreview }) {
  return (
    <details>
      <summary>
        {title} · 原始 {preview.originalChars} 字符{preview.truncated ? ' · 已截断' : ''}
      </summary>
      <pre>{preview.text}</pre>
    </details>
  );
}

export function WorkflowPanel() {
  const { state, api, dispatch, refresh, reportError } = useApp();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [workflowType, setWorkflowType] = useState<WorkflowType>('initialize');
  const [focusInstruction, setFocusInstruction] = useState('');
  const [stagedSources, setStagedSources] = useState<StagedSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
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

  // 存在活跃 run 时本面板每 1s 自轮询：全局 status 轮询不会 bump refreshCounter，
  // 不这么做的话 run 在服务端转为 failed/waiting_user 后界面会一直停留在旧快照。
  const hasActiveRun = runs.some((r) => ['queued', 'running', 'waiting_user'].includes(r.status));
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [hasActiveRun, load]);

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
        {runs.map((run) => {
          const modelCalls = modelCallsOf(run);
          const expanded = expandedRunId === run.id;
          return (
            <li key={run.id} className={`run status-${run.status}`}>
              <div className="run-heading">
                <strong>{run.workflowType}</strong> · {run.status} · 步骤：{run.currentStep}
              </div>
              <button
                className="secondary"
                aria-expanded={expanded}
                onClick={() => setExpandedRunId(expanded ? null : run.id)}
              >
                {expanded ? '收起模型记录' : `查看模型记录（${modelCalls.length}）`}
              </button>
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
              {expanded ? (
                <div className="model-call-log" aria-label="模型调用记录">
                  <p className="muted">
                    仅管理员可见。密钥字段会脱敏；源码、上下文和响应按长度截断；不包含模型内部思维链。
                    每次运行最多保留最近 50 条。
                  </p>
                  {modelCalls.length === 0 ? (
                    <p className="empty">此运行没有模型记录（可能由旧版本启动或尚未发出请求）。</p>
                  ) : (
                    modelCalls.map((call) => (
                      <article key={call.id} className={`model-call status-${call.status}`}>
                        <header>
                          <strong>{stageLabel(call.stage)}</strong>
                          <span className="badge">{call.status}</span>
                          <span className="badge">{elapsedLabel(call)}</span>
                        </header>
                        <p className="model-call-meta">
                          {call.provider} / {call.model} · reasoning={call.reasoningEffort} ·
                          schema=
                          {call.outputSchemaName}
                          {call.maxOutputTokens ? ` · maxOutputTokens=${call.maxOutputTokens}` : ''}
                        </p>
                        <Preview title="发送的指令" preview={call.request.instructions} />
                        <Preview title="发送的上下文（已过滤）" preview={call.request.input} />
                        {call.response ? (
                          <Preview title="模型最终结构化响应" preview={call.response} />
                        ) : null}
                        {call.providerResponseId ? (
                          <p className="model-call-meta">responseId：{call.providerResponseId}</p>
                        ) : null}
                        {call.usage ? (
                          <pre className="model-call-usage">{JSON.stringify(call.usage)}</pre>
                        ) : null}
                        {call.error ? (
                          <p className="error">
                            {call.error.code}: {call.error.message}
                          </p>
                        ) : null}
                      </article>
                    ))
                  )}
                </div>
              ) : null}
              {run.summary ? (
                <pre className="run-summary">{JSON.stringify(run.summary, null, 2)}</pre>
              ) : null}
            </li>
          );
        })}
        {runs.length === 0 ? <p className="empty">暂无 WorkflowRun。</p> : null}
      </ul>
    </section>
  );
}
