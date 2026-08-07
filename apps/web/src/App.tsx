import { useApp, AppProvider } from './state/app';
import { TokenGate } from './components/TokenGate';
import { TreePanel } from './components/TreePanel';
import { Inspector } from './components/Inspector';
import { ChangeSetDrawer } from './components/ChangeSetDrawer';
import { WorkflowPanel } from './components/WorkflowPanel';

function StatusBar() {
  const { state, dispatch } = useApp();
  const status = state.status;
  return (
    <footer className="status-bar">
      <span>
        project：<strong>{status?.status ?? '…'}</strong>
        {status?.currentReleaseVersion ? ` · Release v${status.currentReleaseVersion}` : ''}
      </span>
      {status?.blockedReason ? <span className="error">阻塞：{status.blockedReason}</span> : null}
      {state.statusError ? <span className="error">{state.statusError}</span> : null}
      <button onClick={() => dispatch({ type: 'drawer', open: !state.drawerOpen })}>
        {state.drawerOpen ? '收起 ChangeSet' : 'ChangeSet'}
      </button>
    </footer>
  );
}

function Shell() {
  const { state } = useApp();
  if (!state.token) return <TokenGate />;
  return (
    <div className="shell">
      <main className="workspace">
        <TreePanel />
        <Inspector />
        <WorkflowPanel />
      </main>
      <ChangeSetDrawer />
      <StatusBar />
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
