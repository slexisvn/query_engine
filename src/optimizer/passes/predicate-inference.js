import { OptimizationPass } from '../pass.js';
import { PlanNodeType, JoinType, LogicalFilter, getChildren, setChildren } from '../../planner/logical-plan.js';
import { PlanRewriter } from '../../planner/plan-visitor.js';
import { BoundExprKind, BoundBinary, BoundLiteral, BoundInList } from '../../binder/expression-binder.js';
import { splitConjuncts, combineConjuncts } from './predicate-pushdown.js';

export class PredicateInference extends OptimizationPass {
  get name() { return 'PredicateInference'; }

  apply(plan) {
    const rewriter = new InferenceRewriter();
    return rewriter.rewrite(plan);
  }
}

class InferenceRewriter extends PlanRewriter {
  rewriteFilter(node) {
    const child = this.rewrite(node.children[0]);
    const preds = splitConjuncts(node.condition);
    const inferred = inferNewPredicates(preds);
    if (inferred.length === 0) {
      if (child !== node.children[0]) {
        return { ...node, children: [child] };
      }
      return node;
    }
    const allPreds = [...preds, ...inferred];
    return LogicalFilter(combineConjuncts(allPreds), child);
  }

  rewriteJoin(node) {
    const newNode = this.rewriteChildren(node);
    if (newNode.joinType !== JoinType.INNER || !newNode.condition) return newNode;

    const preds = splitConjuncts(newNode.condition);

    const leftTables = collectTables(newNode.children[0]);
    const rightTables = collectTables(newNode.children[1]);

    const allPreds = [...preds];
    collectFiltersAbove(newNode.children[0], allPreds);
    collectFiltersAbove(newNode.children[1], allPreds);

    const inferred = inferNewPredicates(allPreds);
    if (inferred.length === 0) return newNode;

    const leftPush = [];
    const rightPush = [];

    for (const pred of inferred) {
      const refs = collectTableRefs(pred);
      if (refs.length === 0) continue;
      const leftOnly = refs.every(r => leftTables.has(r));
      const rightOnly = refs.every(r => rightTables.has(r));
      if (leftOnly) leftPush.push(pred);
      else if (rightOnly) rightPush.push(pred);
    }

    let left = newNode.children[0];
    let right = newNode.children[1];

    if (leftPush.length > 0) {
      left = LogicalFilter(combineConjuncts(leftPush), left);
    }
    if (rightPush.length > 0) {
      right = LogicalFilter(combineConjuncts(rightPush), right);
    }

    if (left !== newNode.children[0] || right !== newNode.children[1]) {
      return { ...newNode, children: [left, right] };
    }
    return newNode;
  }
}

function inferNewPredicates(predicates) {
  const equalities = new Map();
  const constants = new Map();
  const existingKeys = new Set(predicates.map(predKey));
  const inferred = [];

  for (const pred of predicates) {
    for (const inList of inferInListsFromOr(pred, existingKeys)) {
      inferred.push(inList);
      existingKeys.add(predKey(inList));
    }
    for (const rangePred of inferRangePredicatesFromOr(pred, existingKeys)) {
      inferred.push(rangePred);
      existingKeys.add(predKey(rangePred));
    }
  }

  for (const pred of predicates) {
    if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') continue;

    const leftIsCol = pred.left?.kind === BoundExprKind.COLUMN_REF;
    const rightIsCol = pred.right?.kind === BoundExprKind.COLUMN_REF;
    const leftIsLit = pred.left?.kind === BoundExprKind.LITERAL;
    const rightIsLit = pred.right?.kind === BoundExprKind.LITERAL;

    if (leftIsCol && rightIsLit) {
      constants.set(colKey(pred.left), pred.right);
    } else if (rightIsCol && leftIsLit) {
      constants.set(colKey(pred.right), pred.left);
    } else if (leftIsCol && rightIsCol) {
      const lk = colKey(pred.left);
      const rk = colKey(pred.right);
      if (!equalities.has(lk)) equalities.set(lk, new Set());
      if (!equalities.has(rk)) equalities.set(rk, new Set());
      equalities.get(lk).add(rk);
      equalities.get(rk).add(lk);
    }
  }

  for (const [colK, litExpr] of constants) {
    const equivCols = equalities.get(colK);
    if (!equivCols) continue;

    for (const eqColK of equivCols) {
      if (constants.has(eqColK)) continue;
      const colExpr = findColExpr(predicates, eqColK);
      if (!colExpr) continue;

      const newPred = BoundBinary('=', colExpr, litExpr, 'BOOLEAN');
      const key = predKey(newPred);
      if (!existingKeys.has(key)) {
        inferred.push(newPred);
        existingKeys.add(key);
        constants.set(eqColK, litExpr);
      }
    }
  }

  for (const [colK, equivCols] of equalities) {
    const litExpr = constants.get(colK);
    if (!litExpr) continue;
    for (const eqColK of equivCols) {
      if (constants.has(eqColK)) continue;
      const colExpr = findColExpr(predicates, eqColK);
      if (!colExpr) continue;
      const newPred = BoundBinary('=', colExpr, litExpr, 'BOOLEAN');
      const key = predKey(newPred);
      if (!existingKeys.has(key)) {
        inferred.push(newPred);
        existingKeys.add(key);
      }
    }
  }

  for (const pred of predicates) {
    if (pred.kind !== BoundExprKind.BINARY) continue;
    if (!['<', '>', '<=', '>=', '<>'].includes(pred.op)) continue;

    const leftIsCol = pred.left?.kind === BoundExprKind.COLUMN_REF;
    const rightIsCol = pred.right?.kind === BoundExprKind.COLUMN_REF;
    const leftIsLit = pred.left?.kind === BoundExprKind.LITERAL;
    const rightIsLit = pred.right?.kind === BoundExprKind.LITERAL;

    if (leftIsCol && rightIsLit) {
      const equivCols = equalities.get(colKey(pred.left));
      if (equivCols) {
        for (const eqColK of equivCols) {
          const colExpr = findColExpr(predicates, eqColK);
          if (!colExpr) continue;
          const newPred = BoundBinary(pred.op, colExpr, pred.right, 'BOOLEAN');
          const key = predKey(newPred);
          if (!existingKeys.has(key)) {
            inferred.push(newPred);
            existingKeys.add(key);
          }
        }
      }
    } else if (rightIsCol && leftIsLit) {
      const equivCols = equalities.get(colKey(pred.right));
      if (equivCols) {
        for (const eqColK of equivCols) {
          const colExpr = findColExpr(predicates, eqColK);
          if (!colExpr) continue;
          const newPred = BoundBinary(pred.op, pred.left, colExpr, 'BOOLEAN');
          const key = predKey(newPred);
          if (!existingKeys.has(key)) {
            inferred.push(newPred);
            existingKeys.add(key);
          }
        }
      }
    }
  }

  return inferred;
}

function inferInListsFromOr(expr, existingKeys) {
  if (!expr || expr.kind !== BoundExprKind.BINARY || expr.op !== 'OR') return [];
  const branches = splitOr(expr);
  if (branches.length < 2) return [];

  const branchMaps = branches.map(branch => collectBranchConstraints(branch));

  const inferred = [];
  const first = branchMaps[0];
  for (const [key, entry] of first) {
    if (!branchMaps.every(map => map.has(key))) continue;
    const literals = new Map(entry.literals || []);
    for (let i = 1; i < branchMaps.length; i++) {
      const branchEntry = branchMaps[i].get(key);
      if (!branchEntry.literals || branchEntry.literals.size === 0) {
        literals.clear();
        break;
      }
      for (const [litKey, lit] of branchEntry.literals) {
        literals.set(litKey, lit);
      }
    }
    if (literals.size < 2) continue;
    const pred = BoundInList(entry.col, [...literals.values()], false);
    const keyPred = predKey(pred);
    if (!existingKeys.has(keyPred)) inferred.push(pred);
  }
  return inferred;
}

function inferRangePredicatesFromOr(expr, existingKeys) {
  if (!expr || expr.kind !== BoundExprKind.BINARY || expr.op !== 'OR') return [];
  const branches = splitOr(expr);
  if (branches.length < 2) return [];

  const branchMaps = branches.map(branch => collectBranchConstraints(branch));
  const inferred = [];
  const first = branchMaps[0];
  for (const [key, entry] of first) {
    if (!branchMaps.every(map => map.has(key))) continue;
    const entries = branchMaps.map(map => map.get(key));
    if (!entries.every(e => e.lower && e.upper)) continue;
    const lower = entries.reduce((best, e) => compareLiteral(e.lower.literal, best.literal) < 0 ? e.lower : best, entries[0].lower);
    const upper = entries.reduce((best, e) => compareLiteral(e.upper.literal, best.literal) > 0 ? e.upper : best, entries[0].upper);
    const lowerPred = BoundBinary(lower.op, entry.col, lower.literal, 'BOOLEAN');
    const upperPred = BoundBinary(upper.op, entry.col, upper.literal, 'BOOLEAN');
    for (const pred of [lowerPred, upperPred]) {
      const keyPred = predKey(pred);
      if (!existingKeys.has(keyPred)) inferred.push(pred);
    }
  }
  return inferred;
}

function collectBranchConstraints(branch) {
  const map = new Map();
  for (const pred of splitConjuncts(branch)) {
    addEqualityConstraint(map, pred);
    addInListConstraint(map, pred);
    addRangeConstraint(map, pred);
  }
  return map;
}

function ensureConstraint(map, col) {
  const key = colKey(col);
  if (!map.has(key)) map.set(key, { col, literals: new Map(), lower: null, upper: null });
  return map.get(key);
}

function addEqualityConstraint(map, pred) {
  if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') return;
  const leftIsCol = pred.left?.kind === BoundExprKind.COLUMN_REF;
  const rightIsCol = pred.right?.kind === BoundExprKind.COLUMN_REF;
  const leftIsLit = pred.left?.kind === BoundExprKind.LITERAL;
  const rightIsLit = pred.right?.kind === BoundExprKind.LITERAL;
  let col = null;
  let lit = null;
  if (leftIsCol && rightIsLit) {
    col = pred.left;
    lit = pred.right;
  } else if (rightIsCol && leftIsLit) {
    col = pred.right;
    lit = pred.left;
  }
  if (!col || !lit) return;
  ensureConstraint(map, col).literals.set(literalKey(lit), lit);
}

function addInListConstraint(map, pred) {
  if (pred.kind !== BoundExprKind.IN_LIST || pred.negated || !Array.isArray(pred.list)) return;
  if (pred.expr?.kind !== BoundExprKind.COLUMN_REF) return;
  if (!pred.list.every(item => item.kind === BoundExprKind.LITERAL)) return;
  const entry = ensureConstraint(map, pred.expr);
  for (const lit of pred.list) entry.literals.set(literalKey(lit), lit);
}

function addRangeConstraint(map, pred) {
  if (pred.kind === BoundExprKind.BETWEEN && !pred.negated && pred.expr?.kind === BoundExprKind.COLUMN_REF) {
    if (pred.low?.kind === BoundExprKind.LITERAL) setLower(ensureConstraint(map, pred.expr), '>=', pred.low);
    if (pred.high?.kind === BoundExprKind.LITERAL) setUpper(ensureConstraint(map, pred.expr), '<=', pred.high);
    return;
  }
  if (pred.kind !== BoundExprKind.BINARY) return;
  const leftIsCol = pred.left?.kind === BoundExprKind.COLUMN_REF;
  const rightIsCol = pred.right?.kind === BoundExprKind.COLUMN_REF;
  const leftIsLit = pred.left?.kind === BoundExprKind.LITERAL;
  const rightIsLit = pred.right?.kind === BoundExprKind.LITERAL;
  if (leftIsCol && rightIsLit) {
    const entry = ensureConstraint(map, pred.left);
    if (pred.op === '>=' || pred.op === '>') setLower(entry, pred.op, pred.right);
    if (pred.op === '<=' || pred.op === '<') setUpper(entry, pred.op, pred.right);
  } else if (rightIsCol && leftIsLit) {
    const entry = ensureConstraint(map, pred.right);
    if (pred.op === '<=' || pred.op === '<') setLower(entry, flipRangeOp(pred.op), pred.left);
    if (pred.op === '>=' || pred.op === '>') setUpper(entry, flipRangeOp(pred.op), pred.left);
  }
}

function setLower(entry, op, literal) {
  if (!entry.lower || compareLiteral(literal, entry.lower.literal) > 0) entry.lower = { op, literal };
}

function setUpper(entry, op, literal) {
  if (!entry.upper || compareLiteral(literal, entry.upper.literal) < 0) entry.upper = { op, literal };
}

function flipRangeOp(op) {
  if (op === '<=') return '>=';
  if (op === '<') return '>';
  if (op === '>=') return '<=';
  if (op === '>') return '<';
  return op;
}

function compareLiteral(a, b) {
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
  return String(a.value).localeCompare(String(b.value));
}

function splitOr(expr) {
  if (!expr) return [];
  if (expr.kind === BoundExprKind.BINARY && expr.op === 'OR') {
    return [...splitOr(expr.left), ...splitOr(expr.right)];
  }
  return [expr];
}

function colKey(expr) {
  return `${(expr.tableAlias || '').toUpperCase()}.${(expr.columnName || '').toUpperCase()}`;
}

function predKey(pred) {
  if (pred.kind === BoundExprKind.BINARY) {
    return `${pred.op}:${exprKey(pred.left)}:${exprKey(pred.right)}`;
  }
  if (pred.kind === BoundExprKind.IN_LIST) {
    return `IN:${exprKey(pred.expr)}:${pred.list.map(exprKey).join(',')}:${pred.negated}`;
  }
  return JSON.stringify(pred).slice(0, 80);
}

function exprKey(expr) {
  if (!expr) return 'null';
  if (expr.kind === BoundExprKind.COLUMN_REF) return colKey(expr);
  if (expr.kind === BoundExprKind.LITERAL) return `LIT:${expr.value}`;
  return JSON.stringify(expr).slice(0, 40);
}

function literalKey(expr) {
  return `${expr.dataType || ''}:${String(expr.value)}`;
}

function findColExpr(predicates, colK) {
  for (const pred of predicates) {
    if (pred.kind !== BoundExprKind.BINARY) continue;
    if (pred.left?.kind === BoundExprKind.COLUMN_REF && colKey(pred.left) === colK) return pred.left;
    if (pred.right?.kind === BoundExprKind.COLUMN_REF && colKey(pred.right) === colK) return pred.right;
  }
  return null;
}

function collectTables(node) {
  const tables = new Set();
  function walk(n) {
    if (!n) return;
    if (n.type === PlanNodeType.SCAN) {
      tables.add((n.alias || n.table).toUpperCase());
    }
    for (const child of getChildren(n)) walk(child);
  }
  walk(node);
  return tables;
}

function collectTableRefs(expr) {
  const refs = [];
  walkExpr(expr, e => {
    if (e.kind === BoundExprKind.COLUMN_REF && e.tableAlias) {
      refs.push(e.tableAlias.toUpperCase());
    }
  });
  return refs;
}

function collectFiltersAbove(node, preds) {
  if (!node) return;
  if (node.type === PlanNodeType.FILTER) {
    preds.push(...splitConjuncts(node.condition));
  }
}

function walkExpr(expr, fn) {
  if (!expr || typeof expr !== 'object') return;
  fn(expr);
  if (expr.left) walkExpr(expr.left, fn);
  if (expr.right) walkExpr(expr.right, fn);
  if (expr.operand) walkExpr(expr.operand, fn);
  if (expr.expr) walkExpr(expr.expr, fn);
  if (expr.low) walkExpr(expr.low, fn);
  if (expr.high) walkExpr(expr.high, fn);
  if (expr.args) for (const a of expr.args) walkExpr(a, fn);
  if (Array.isArray(expr.list)) for (const item of expr.list) walkExpr(item, fn);
  if (expr.pattern) walkExpr(expr.pattern, fn);
  if (expr.source) walkExpr(expr.source, fn);
  if (expr.whenClauses) for (const wc of expr.whenClauses) {
    walkExpr(wc.condition, fn);
    walkExpr(wc.result, fn);
  }
  if (expr.elseExpr) walkExpr(expr.elseExpr, fn);
}
