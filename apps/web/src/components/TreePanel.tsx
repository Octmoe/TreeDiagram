import { useCallback, useEffect, useState } from 'react';
import type {
  NodeDetail,
  QueryNodesResponse,
  RelationDetail,
  TreeResponse,
} from '@treediagram/contracts';
import { ApiError } from '../api/client';
import { useApp } from '../state/app';
import { NodeForm } from './NodeForm';

/**
 * 树面板（§14.2）：只渲染已展开分支；行内显示 type/approval/epistemic/候选徽标；
 * 键盘 Enter 选择、左右箭头展开/折叠。顶部提供全文搜索与新建节点入口。
 */

interface BranchState {
  children: NodeDetail[];
  relations: RelationDetail[];
  loading: boolean;
}

function Badges({ detail }: { detail: NodeDetail }) {
  const { node, revision } = detail;
  return (
    <span className="badges">
      <span className="badge type">{node.nodeType}</span>
      {revision.roles.includes('root') ? <span className="badge root">root</span> : null}
      <span className={`badge approval-${revision.approvalState}`}>{revision.approvalState}</span>
      {revision.epistemicState ? (
        <span className={`badge epistemic-${revision.epistemicState}`}>
          {revision.epistemicState}
        </span>
      ) : null}
      {revision.createdInChangeSetId ? <span className="badge candidate">候选</span> : null}
    </span>
  );
}

export function TreePanel() {
  const { state, api, dispatch, refresh } = useApp();
  const [branches, setBranches] = useState<Record<string, BranchState>>({});
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchResults, setSearchResults] = useState<NodeDetail[] | null>(null);
  const [showNodeForm, setShowNodeForm] = useState(false);

  const loadBranch = useCallback(
    async (parentNodeId: string | null) => {
      if (!api) return;
      const key = parentNodeId ?? '';
      setBranches((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { children: [], relations: [] }), loading: true },
      }));
      try {
        const params = new URLSearchParams({ view: 'working', depth: '1' });
        if (parentNodeId) params.set('parentNodeId', parentNodeId);
        const tree = await api.get<TreeResponse>(`/tree?${params.toString()}`);
        const children = parentNodeId
          ? tree.nodes.filter((n) => n.node.id !== parentNodeId)
          : tree.nodes;
        setBranches((prev) => ({
          ...prev,
          [key]: { children, relations: tree.relations, loading: false },
        }));
      } catch (err) {
        setBranches((prev) => ({
          ...prev,
          [key]: { children: [], relations: [], loading: false },
        }));
        setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
      }
    },
    [api],
  );

  // 初始与 refresh 后重载所有已展开分支
  useEffect(() => {
    if (!api) return;
    setError(null);
    const expandedKeys = Object.keys(branches);
    if (!expandedKeys.includes('')) {
      void loadBranch(null);
      return;
    }
    for (const key of expandedKeys) {
      void loadBranch(key === '' ? null : key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, state.refreshCounter]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    if (!expanded.has(nodeId) && !branches[nodeId]) {
      void loadBranch(nodeId);
    }
  };

  const runSearch = async () => {
    if (!api) return;
    const text = searchText.trim();
    if (!text) {
      setSearchResults(null);
      return;
    }
    try {
      const res = await api.get<QueryNodesResponse>(
        `/query?view=working&text=${encodeURIComponent(text)}`,
      );
      setSearchResults(res.nodes);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  };

  const select = (nodeId: string) => dispatch({ type: 'select-node', nodeId });

  const renderRow = (detail: NodeDetail, depth: number) => {
    const nodeId = detail.node.id;
    const isExpanded = expanded.has(nodeId);
    const branch = branches[nodeId];
    const hasChildren = (branch?.children.length ?? 0) > 0 || !branch;
    return (
      <div key={nodeId}>
        <div
          className={`tree-row${state.selectedNodeId === nodeId ? ' selected' : ''}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          tabIndex={0}
          role="treeitem"
          aria-expanded={isExpanded}
          onClick={() => select(nodeId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') select(nodeId);
            if (e.key === 'ArrowRight' && !isExpanded) toggle(nodeId);
            if (e.key === 'ArrowLeft' && isExpanded) toggle(nodeId);
          }}
        >
          <button
            className="expander"
            aria-label={isExpanded ? '折叠' : '展开'}
            onClick={(e) => {
              e.stopPropagation();
              toggle(nodeId);
            }}
          >
            {hasChildren ? (isExpanded ? '▾' : '▸') : '·'}
          </button>
          <span className="title">{detail.revision.displayTitle}</span>
          <Badges detail={detail} />
        </div>
        {isExpanded && branch ? branch.children.map((child) => renderRow(child, depth + 1)) : null}
        {isExpanded && branch?.loading ? (
          <div className="tree-loading" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
            加载中…
          </div>
        ) : null}
      </div>
    );
  };

  const rootBranch = branches[''];

  return (
    <section className="panel tree-panel" aria-label="设计树">
      <header className="panel-header">
        <h2>设计树</h2>
        <button onClick={() => setShowNodeForm((v) => !v)}>
          {showNodeForm ? '收起' : '新建节点'}
        </button>
      </header>
      {showNodeForm ? (
        <NodeForm
          onCreated={(nodeId) => {
            setShowNodeForm(false);
            dispatch({ type: 'select-node', nodeId });
            refresh();
          }}
        />
      ) : null}
      <div className="search-bar">
        <input
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          placeholder="全文搜索（Enter）"
          aria-label="全文搜索"
        />
        {searchResults ? (
          <button
            onClick={() => {
              setSearchResults(null);
              setSearchText('');
            }}
          >
            清除
          </button>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="tree-body" role="tree">
        {searchResults
          ? searchResults.map((detail) => (
              <div
                key={detail.node.id}
                className={`tree-row${state.selectedNodeId === detail.node.id ? ' selected' : ''}`}
                role="treeitem"
                aria-expanded={false}
                tabIndex={0}
                onClick={() => select(detail.node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') select(detail.node.id);
                }}
              >
                <span className="expander">🔍</span>
                <span className="title">{detail.revision.displayTitle}</span>
                <Badges detail={detail} />
              </div>
            ))
          : (rootBranch?.children ?? []).map((detail) => renderRow(detail, 0))}
        {!searchResults && rootBranch && rootBranch.children.length === 0 && !rootBranch.loading ? (
          <p className="empty">尚无节点。使用「新建节点」或（M3 起）Agent 初始化工作流。</p>
        ) : null}
      </div>
    </section>
  );
}
