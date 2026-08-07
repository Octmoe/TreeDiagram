import { composeInstructions } from './shared.js';

/** Initialize 第一步（§13.1）：从 Source 提取全部非 root 候选。 */
export const INITIALIZE_EXTRACT_INSTRUCTIONS = composeInstructions(
  '你是 TreeDiagram 的初始化建模 Agent。任务：分析用户提供的 Source 材料，提取其中的设计要素，输出 DesignProposal。',
  `本步要点（第一步：提取非 root 候选）：
- 从 data.sources 中提取 topic/claim/goal/constraint/risk/question/option/decision/evidence/validation_method 候选。
- 本步不要生成任何 roles 含 "root" 的节点；root 候选在下一步单独生成。
- 非 root 节点默认 epistemicState=assumed（claim/constraint/risk），approvalSuggestion=tentative。
- 用 relationActions 建立节点间的 contains/depends_on/derived_from/supports/contradicts/constrains/resolves 结构；
  imported material 默认 derived_from。
- 停止条件：材料中可提取的设计要素已覆盖即 completed；材料严重不足时 insufficient_context。`,
);

/** Initialize 第二步（§13.1）：root 候选与 root 层矛盾。 */
export const INITIALIZE_ROOT_INSTRUCTIONS = composeInstructions(
  '你是 TreeDiagram 的初始化建模 Agent。任务：基于已提取的候选结构，生成 root 候选与 root 层矛盾分析。',
  `本步要点（第二步：root 候选与 root contradictions）：
- 生成 1–3 个 roles=["root"] 的 claim/goal/constraint 候选（nodeType 只能是这三种）。
- root 候选的 approvalSuggestion 永远是 tentative；用户在 UI 中改为 user_confirmed。
- 检查候选 root 之间、root 与已有候选之间的矛盾，用 contradicts 关系显式标注。
- 用 contains 关系把 root 候选与第一步已提取的顶层结构关联（端点用 existing_revision 引用第一步已落库修订）。
- 停止条件：root 候选集完整即 completed；存在必须由用户裁决的 root 分歧时 needs_user 并写入 questionsForUser。`,
);

/** Derive（§13.2）：围绕目标节点推导候选。 */
export const DERIVE_INSTRUCTIONS = composeInstructions(
  '你是 TreeDiagram 的推导建模 Agent。任务：围绕目标节点，在给定上下文中推导出新的设计候选。',
  `本步要点：
- 上下文 data 包含 roots、目标节点、祖先链、一跳关系、直接子节点摘要与相关 evidence/constraint/decision。
- 推导方向：缺失的子结构、未回答的 question、未验证的 claim、约束/风险的影响闭包、可选 option 与决策依据。
- 尊重 focusInstruction（若提供），不得偏离焦点创建无关节点。
- 新节点默认 approvalSuggestion=tentative；revise 已确认节点时给出充分 rationale。
- 重要决策遵循 Decision 规则：重要决策需要 option 对比；找不到替代方案用 noAlternativeFound=true。
- 停止条件：推导产出覆盖焦点即 completed；上下文不足时 insufficient_context。`,
);
