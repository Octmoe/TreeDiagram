import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type { ProjectStatusResponse } from '@treediagram/contracts';
import { ApiError, createApiClient, loadToken, saveToken, type ApiClient } from '../api/client';

/**
 * 全局状态（IMPLEMENTATION_DESIGN §14.1）：useReducer，无状态库。
 * mutation 完成后通过 refresh() 重新读取受影响 slice，不做 optimistic update。
 */

/** 错误窗口（ErrorDialog）展示用的结构化错误报告。 */
export interface ErrorReport {
  title: string;
  code: string;
  message: string;
  status?: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface AppState {
  token: string | null;
  tokenChecked: boolean;
  status: ProjectStatusResponse | null;
  statusError: string | null;
  selectedNodeId: string | null;
  drawerOpen: boolean;
  /** 每次 mutation 后 +1，驱动各面板重新拉取。 */
  refreshCounter: number;
  /** 当前是否存在活跃 WorkflowRun（驱动 1s 轮询）。 */
  activeWorkflow: boolean;
  /** 非空时弹出独立错误窗口。 */
  errorReport: ErrorReport | null;
}

export type AppAction =
  | { type: 'token-set'; token: string }
  | { type: 'token-invalid' }
  | { type: 'status'; status: ProjectStatusResponse }
  | { type: 'status-error'; message: string }
  | { type: 'select-node'; nodeId: string | null }
  | { type: 'drawer'; open: boolean }
  | { type: 'refresh' }
  | { type: 'workflow-active'; active: boolean }
  | { type: 'error-show'; report: ErrorReport }
  | { type: 'error-dismiss' };

const initialState: AppState = {
  token: loadToken(),
  tokenChecked: false,
  status: null,
  statusError: null,
  selectedNodeId: null,
  drawerOpen: false,
  refreshCounter: 0,
  activeWorkflow: false,
  errorReport: null,
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'token-set':
      return { ...state, token: action.token, tokenChecked: true, statusError: null };
    case 'token-invalid':
      return { ...state, token: null, tokenChecked: true, status: null };
    case 'status':
      return { ...state, status: action.status, statusError: null, tokenChecked: true };
    case 'status-error':
      return { ...state, statusError: action.message };
    case 'select-node':
      return { ...state, selectedNodeId: action.nodeId };
    case 'drawer':
      return { ...state, drawerOpen: action.open };
    case 'refresh':
      return { ...state, refreshCounter: state.refreshCounter + 1 };
    case 'workflow-active':
      return { ...state, activeWorkflow: action.active };
    case 'error-show':
      return { ...state, errorReport: action.report };
    case 'error-dismiss':
      return { ...state, errorReport: null };
  }
}

interface AppContextValue {
  state: AppState;
  api: ApiClient | null;
  dispatch: (action: AppAction) => void;
  refresh: () => void;
  login: (token: string) => void;
  /** 把任意错误转成 ErrorReport 并弹出独立错误窗口（用户操作失败时使用）。 */
  reportError: (err: unknown, title?: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, baseDispatch] = useReducer(reducer, initialState);
  const dispatch = useCallback((action: AppAction) => baseDispatch(action), []);
  const refresh = useCallback(() => baseDispatch({ type: 'refresh' }), []);
  const login = useCallback((token: string) => {
    saveToken(token);
    baseDispatch({ type: 'token-set', token });
  }, []);
  const reportError = useCallback((err: unknown, title = '操作失败') => {
    if (err instanceof ApiError) {
      baseDispatch({
        type: 'error-show',
        report: {
          title,
          code: err.code,
          message: err.message,
          status: err.status,
          ...(err.requestId ? { requestId: err.requestId } : {}),
          ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
        },
      });
      return;
    }
    baseDispatch({
      type: 'error-show',
      report: {
        title,
        code: 'CLIENT_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }, []);

  const api = useMemo(() => (state.token ? createApiClient(state.token) : null), [state.token]);

  // status 轮询（§14.1）：active workflow 1s；reevaluating/blocked 2s；否则 10s；不可见时暂停。
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      if (stopped || document.hidden) {
        schedule();
        return;
      }
      try {
        const status = await api.get<ProjectStatusResponse>('/status');
        baseDispatch({ type: 'status', status });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          baseDispatch({ type: 'token-invalid' });
          return;
        }
        baseDispatch({
          type: 'status-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      schedule();
    };

    const schedule = () => {
      if (stopped || !api) return;
      const s = state.status?.status;
      const interval = state.activeWorkflow
        ? 1000
        : s === 'reevaluating' || s === 'blocked'
          ? 2000
          : 10000;
      timer = setTimeout(() => void tick(), interval);
    };

    void tick();
    const onVisibility = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, state.activeWorkflow, state.status?.status, state.refreshCounter]);

  const value = useMemo(
    () => ({ state, api, dispatch, refresh, login, reportError }),
    [state, api, dispatch, refresh, login, reportError],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
