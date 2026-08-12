import type {
  AgentActivity,
  AttentionContext,
  ChangeSet,
  ChangeSetLeaseHandoffRequest,
  ChangeSetLeaseStatus,
  ChangeSetWriteLease,
  NodeDetail,
  RelationDetail,
  ToolResult,
  WorkspaceSummary,
} from '@treediagram/contracts';

export interface BootstrapData {
  workspace: WorkspaceSummary;
  lifecycle?:
    | {
        available: true;
        projectRoot: string;
        archivePath: string;
        confirmationText: string;
      }
    | { available: false };
  nodes: NodeDetail[];
  relations: RelationDetail[];
  attention: AttentionContext | null;
  changeSet: ChangeSet | null;
  lease: ChangeSetWriteLease | null;
  leaseStatus: ChangeSetLeaseStatus | null;
  leaseHandoffRequests: ChangeSetLeaseHandoffRequest[];
  agentActivity: AgentActivity | null;
  recoveryCandidates: AttentionContext[];
  eventCursor: number;
}

export interface UiIdentity {
  hostKind: string;
  hostSessionRef: string;
  clientRef: string;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  if (!response.ok)
    throw new Error(
      (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`,
    );
  return body;
}

export class SidecarApi {
  constructor(private readonly baseUrl = '') {}

  bootstrap(identity: UiIdentity): Promise<BootstrapData> {
    const params = new URLSearchParams({
      hostKind: identity.hostKind,
      hostSessionRef: identity.hostSessionRef,
      clientRef: identity.clientRef,
    });
    return fetch(`${this.baseUrl}/api/v2/bootstrap?${params}`).then((response) =>
      json<BootstrapData>(response),
    );
  }

  async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await fetch(`${this.baseUrl}/api/v2/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    }).then((response) => json<ToolResult<T>>(response));
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.data;
  }

  async action<T>(action: string, body: Record<string, unknown>): Promise<T> {
    return fetch(`${this.baseUrl}/api/v2/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((response) => json<T>(response));
  }

  closeWorkspace(): Promise<{ accepted: true; mode: 'close' }> {
    return fetch(`${this.baseUrl}/api/v2/workspace/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((response) => json(response));
  }

  clearWorkspace(
    confirmationText: string,
  ): Promise<{ accepted: true; completed: true; mode: 'clear'; archivePath: string }> {
    return fetch(`${this.baseUrl}/api/v2/workspace/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmationText }),
    }).then((response) => json(response));
  }

  restore(sourceContextId: string, identity: UiIdentity): Promise<AttentionContext> {
    return fetch(`${this.baseUrl}/api/v2/attention/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceContextId, ...identity }),
    }).then((response) => json<AttentionContext>(response));
  }

  events(after: number): Promise<{ cursor: number; changed: boolean }> {
    return fetch(`${this.baseUrl}/api/v2/events?after=${after}`).then((response) => json(response));
  }
}

export function getUiIdentity(): UiIdentity {
  const url = new URL(window.location.href);
  const hostKind = url.searchParams.get('host') || 'codex';
  let hostSessionRef =
    url.searchParams.get('session') || sessionStorage.getItem('treediagram.hostSessionRef');
  if (!hostSessionRef) {
    hostSessionRef = crypto.randomUUID();
    sessionStorage.setItem('treediagram.hostSessionRef', hostSessionRef);
  }
  // Sidecar 与同一任务中的 Agent 共用一个明确命名的 Attention 通道。
  // hostSessionRef 继续隔离任务；clientRef 不再使用浏览器随机值，否则 Agent 无法读取用户选择。
  const clientRef = `${hostKind}-agent`;
  return { hostKind, hostSessionRef, clientRef };
}
