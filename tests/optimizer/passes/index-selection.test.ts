import { describe, it, expect } from 'vitest';
import { IndexSelection } from '../../../src/optimizer/passes/index-selection.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../../src/binder/expression-binder.js';

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v) {
  return { kind: BoundExprKind.LITERAL, value: v };
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scan(name, cols) {
  return LogicalScan(name, cols || ['ID', 'STATUS', 'AMOUNT'], name);
}

function makeCatalog(indexes) {
  return {
    getIndexForColumn(table, col) {
      const key = `${table.toUpperCase()}.${col.toUpperCase()}`;
      return indexes.has(key) ? indexes.get(key) : null;
    },
  };
}

function makeStats(tableStats) {
  const map = new Map();
  for (const [table, stats] of Object.entries(tableStats)) {
    map.set(table.toUpperCase(), {
      rowCount: stats.rowCount,
      getColumnStats(col) {
        return stats.columns?.[col.toUpperCase()] || null;
      },
    });
  }
  return map;
}

describe('IndexSelection', () => {
  describe('equality predicate with index', () => {
    it('replaces FILTER+SCAN with INDEX_SCAN for equality', () => {
      const indexes = new Map([['ORDERS.ID', { name: 'idx_orders_id' }]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', lit(42)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanType).toBe('point');
      expect(result.scanKey).toBe(42);
      expect(result.columnName).toBe('ID');
    });

    it('handles flipped literal = column', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(lit(42), '=', colRef('orders', 'ID')),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanType).toBe('point');
      expect(result.scanKey).toBe(42);
    });
  });

  describe('range predicates with index', () => {
    it('creates range scan for > predicate', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'AMOUNT'), '>', lit(100)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanType).toBe('range');
      expect(result.scanLow).toBe(100);
      expect(result.lowInc).toBe(false);
    });

    it('creates range scan for >= predicate', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'AMOUNT'), '>=', lit(100)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanLow).toBe(100);
      expect(result.lowInc).toBe(true);
    });

    it('creates range scan for < predicate', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'AMOUNT'), '<', lit(500)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanHigh).toBe(500);
      expect(result.highInc).toBe(false);
    });

    it('creates range scan for <= predicate', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'AMOUNT'), '<=', lit(500)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanHigh).toBe(500);
      expect(result.highInc).toBe(true);
    });

    it('handles flipped literal < column as column > literal', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(lit(100), '<', colRef('orders', 'AMOUNT')),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanType).toBe('range');
      expect(result.scanLow).toBe(100);
      expect(result.lowInc).toBe(false);
    });
  });

  describe('no index available', () => {
    it('keeps FILTER+SCAN when no index exists', () => {
      const catalog = makeCatalog(new Map());
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', lit(42)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('non-indexable predicates', () => {
    it('does not use index for LIKE predicate', () => {
      const indexes = new Map([['ORDERS.STATUS', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        { kind: BoundExprKind.LIKE, expr: colRef('orders', 'STATUS'), pattern: lit('%abc%') },
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
    });

    it('does not use index for column = column', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', colRef('orders', 'STATUS')),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
    });
  });

  describe('residual predicates', () => {
    it('keeps non-indexed conjuncts as residual filter', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const idPred = bin(colRef('orders', 'ID'), '=', lit(42));
      const statusPred = bin(colRef('orders', 'STATUS'), '=', lit('active'));
      const plan = LogicalFilter(
        bin(idPred, 'AND', statusPred),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.children[0].scanKey).toBe(42);
    });
  });

  describe('statistics-based rejection', () => {
    it('skips index when selectivity exceeds threshold', () => {
      const indexes = new Map([['ORDERS.STATUS', {}]]);
      const catalog = makeCatalog(indexes);
      const stats = makeStats({
        orders: {
          rowCount: 10000,
          columns: { STATUS: { ndv: 2 } },
        },
      });
      const pass = new IndexSelection(catalog, stats);

      const plan = LogicalFilter(
        bin(colRef('orders', 'STATUS'), '=', lit('active')),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });

    it('uses index when selectivity is below threshold (high NDV)', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const stats = makeStats({
        orders: {
          rowCount: 100000,
          columns: { ID: { ndv: 100000 } },
        },
      });
      const pass = new IndexSelection(catalog, stats);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', lit(42)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
    });
  });

  describe('child is not a SCAN', () => {
    it('does not apply index selection when child is PROJECT', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', lit(42)),
        LogicalProject([colRef('orders', 'ID')], scan('orders'))
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
    });
  });

  describe('table alias mismatch', () => {
    it('ignores predicate referencing different table alias', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('other_table', 'ID'), '=', lit(42)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.children[0].type).toBe(PlanNodeType.SCAN);
    });
  });

  describe('index naming', () => {
    it('generates correct index name from table and column', () => {
      const indexes = new Map([['ORDERS.ID', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const plan = LogicalFilter(
        bin(colRef('orders', 'ID'), '=', lit(1)),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.indexName).toBe('IDX_ORDERS_ID');
    });
  });

  describe('combined range bounds', () => {
    it('merges > and < on same column into bounded range', () => {
      const indexes = new Map([['ORDERS.AMOUNT', {}]]);
      const catalog = makeCatalog(indexes);
      const pass = new IndexSelection(catalog, null);

      const lower = bin(colRef('orders', 'AMOUNT'), '>', lit(100));
      const upper = bin(colRef('orders', 'AMOUNT'), '<', lit(500));
      const plan = LogicalFilter(
        bin(lower, 'AND', upper),
        scan('orders')
      );

      const result = pass.apply(plan);

      expect(result.type).toBe(PlanNodeType.INDEX_SCAN);
      expect(result.scanType).toBe('range');
      expect(result.scanLow).toBe(100);
      expect(result.scanHigh).toBe(500);
      expect(result.lowInc).toBe(false);
      expect(result.highInc).toBe(false);
    });
  });
});
