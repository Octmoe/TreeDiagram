import { useEffect, useState } from 'react';
import { useApp } from '../state/app';

/**
 * 独立错误窗口：展示用户操作失败的完整信息
 * （错误码 / 消息 / HTTP 状态 / requestId / details 原始 JSON），
 * 支持一键复制全部内容用于反馈或排查。Esc 或点击遮罩关闭。
 */
export function ErrorDialog() {
  const { state, dispatch } = useApp();
  const report = state.errorReport;
  const [copied, setCopied] = useState(false);

  const close = () => dispatch({ type: 'error-dismiss' });

  useEffect(() => {
    setCopied(false);
    if (!report) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  if (!report) return null;

  const copyAll = async () => {
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // 剪贴板不可用（如非安全上下文）：选中 details 文本由用户手动复制
      setCopied(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={close} role="presentation">
      <div
        className="error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={report.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{report.title}</h2>
          <button className="secondary" onClick={close} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="error-dialog-body">
          <p>
            <span className="badge dialog-code">{report.code}</span>
            {report.status !== undefined ? (
              <span className="badge">HTTP {report.status}</span>
            ) : null}
          </p>
          <p className="error-dialog-message">{report.message}</p>
          {report.details ? (
            <>
              <h3>详细信息</h3>
              <pre className="error-dialog-details">{JSON.stringify(report.details, null, 2)}</pre>
            </>
          ) : null}
          {report.requestId ? <p className="muted">requestId：{report.requestId}</p> : null}
        </div>
        <footer>
          <button onClick={() => void copyAll()}>{copied ? '已复制 ✓' : '复制全部'}</button>
          <button className="secondary" onClick={close}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
