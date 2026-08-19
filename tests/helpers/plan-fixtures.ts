import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { LogicalScan } from '../../src/planner/logical-plan.js';
import { PlanProperties } from '../../src/optimizer/passes/plan-properties.js';
import { PhysicalPlanner } from '../../src/execution/physical-planner.js';

export function colRef(table, column) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: column };
}

export function lit(value) {
  return { kind: BoundExprKind.LITERAL, value };
}

export function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

export function eqJoin(leftTable, leftCol, rightTable, rightCol) {
  return bin(colRef(leftTable, leftCol), '=', colRef(rightTable, rightCol));
}

export function scan(name) {
  return LogicalScan(name, ['id', 'val'], name);
}

export function makeStats(tables) {
  const map = new Map();
  for (const [name, info] of Object.entries(tables)) {
    const columnStats = new Map();
    for (const [column, stats] of Object.entries(info.columns ?? {})) {
      columnStats.set(column.toUpperCase(), stats);
    }
    map.set(name.toUpperCase(), {
      rowCount: info.rowCount,
      columnStats,
      getColumnStats: (column) => columnStats.get(column.toUpperCase()) ?? null,
    });
  }
  return map;
}

export function annotate(plan, stats = new Map()) {
  return new PlanProperties(stats).apply(plan);
}

export function planPhysical(plan, stats = new Map()) {
  return new PhysicalPlanner(stats).plan(annotate(plan, stats));
}
