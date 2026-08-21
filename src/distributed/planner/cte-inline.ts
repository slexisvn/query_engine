import { PlanNodeType, type LogicalPlanNode, type LogicalCTEScanNode, type LogicalProjectNode } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-rewriter.js';

export function inlineCTEScans(plan: LogicalPlanNode, cteMap: Map<string, LogicalPlanNode> | null): LogicalPlanNode {
  if (!cteMap || cteMap.size === 0) return plan;
  return new CTEInliner(cteMap).rewrite(plan);
}

class CTEInliner extends PlanRewriter {
  _cteMap: Map<string, LogicalPlanNode>;
  _expanding: Set<string>;

  constructor(cteMap: Map<string, LogicalPlanNode>) {
    super();
    this._cteMap = cteMap;
    this._expanding = new Set();
  }

  override rewriteCTEScan(node: LogicalCTEScanNode): LogicalPlanNode {
    const key = node.cteName.toUpperCase();
    const definition = this._cteMap.get(key);
    if (!definition || this._expanding.has(key)) return node;

    this._expanding.add(key);
    const inlined = this.rewrite(definition);
    this._expanding.delete(key);

    return aliasOutput(inlined, node.alias);
  }
}

function aliasOutput(node: LogicalPlanNode, alias: string): LogicalPlanNode {
  if (!alias || node.type !== PlanNodeType.PROJECT) return node;
  return { ...node, outputAlias: alias } as LogicalProjectNode;
}
