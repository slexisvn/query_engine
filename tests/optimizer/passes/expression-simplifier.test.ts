import { describe, it, expect } from 'vitest';
import { ExpressionSimplifier, simplifyExpression } from '../../../src/optimizer/passes/expression-simplifier.js';
import {
  PlanNodeType,
  LogicalScan,
  LogicalFilter,
  LogicalProject,
  LogicalJoin,
  JoinType,
} from '../../../src/planner/logical-plan.js';
import { BoundExprKind, BoundLiteral, BoundBinary } from '../../../src/binder/expression-binder.js';

const pass = new ExpressionSimplifier();

function colRef(table, col) {
  return { kind: BoundExprKind.COLUMN_REF, tableAlias: table, columnName: col };
}

function lit(v, dt) {
  return BoundLiteral(v, dt || (typeof v === 'boolean' ? 'BOOLEAN' : 'FLOAT64'));
}

function bin(left, op, right) {
  return { kind: BoundExprKind.BINARY, op, left, right, resultType: 'BOOLEAN' };
}

function scan(name) {
  return LogicalScan(name, ['id'], name);
}

describe('simplifyExpression', () => {
  describe('AND simplification', () => {
    it('AND(true, X) => X', () => {
      const result = simplifyExpression(bin(lit(true), 'AND', colRef('t', 'a')));
      expect(result.kind).toBe(BoundExprKind.COLUMN_REF);
      expect(result.columnName).toBe('a');
    });

    it('AND(X, true) => X', () => {
      const result = simplifyExpression(bin(colRef('t', 'a'), 'AND', lit(true)));
      expect(result.kind).toBe(BoundExprKind.COLUMN_REF);
    });

    it('AND(false, X) => false', () => {
      const result = simplifyExpression(bin(lit(false), 'AND', colRef('t', 'a')));
      expect(result.kind).toBe(BoundExprKind.LITERAL);
      expect(result.value).toBe(false);
    });

    it('AND(X, false) => false', () => {
      const result = simplifyExpression(bin(colRef('t', 'a'), 'AND', lit(false)));
      expect(result.value).toBe(false);
    });

    it('AND(X, X) => X for identical column refs', () => {
      const col = colRef('t', 'a');
      const result = simplifyExpression(bin(col, 'AND', col));
      expect(result).toBe(col);
    });
  });

  describe('OR simplification', () => {
    it('OR(true, X) => true', () => {
      const result = simplifyExpression(bin(lit(true), 'OR', colRef('t', 'a')));
      expect(result.value).toBe(true);
    });

    it('OR(X, true) => true', () => {
      const result = simplifyExpression(bin(colRef('t', 'a'), 'OR', lit(true)));
      expect(result.value).toBe(true);
    });

    it('OR(false, X) => X', () => {
      const result = simplifyExpression(bin(lit(false), 'OR', colRef('t', 'a')));
      expect(result.kind).toBe(BoundExprKind.COLUMN_REF);
    });

    it('OR(X, false) => X', () => {
      const result = simplifyExpression(bin(colRef('t', 'a'), 'OR', lit(false)));
      expect(result.kind).toBe(BoundExprKind.COLUMN_REF);
    });

    it('OR(X, X) => X', () => {
      const col = colRef('t', 'a');
      const result = simplifyExpression(bin(col, 'OR', col));
      expect(result).toBe(col);
    });
  });

  describe('NOT simplification', () => {
    it('NOT(true) => false', () => {
      const result = simplifyExpression({ kind: BoundExprKind.UNARY, op: 'NOT', operand: lit(true) });
      expect(result.value).toBe(false);
    });

    it('NOT(false) => true', () => {
      const result = simplifyExpression({ kind: BoundExprKind.UNARY, op: 'NOT', operand: lit(false) });
      expect(result.value).toBe(true);
    });

    it('NOT(NOT(X)) => X (double negation)', () => {
      const col = colRef('t', 'a');
      const expr = {
        kind: BoundExprKind.UNARY, op: 'NOT',
        operand: { kind: BoundExprKind.UNARY, op: 'NOT', operand: col },
      };
      const result = simplifyExpression(expr);
      expect(result).toBe(col);
    });
  });

  describe('arithmetic simplification', () => {
    it('X + 0 => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(col, '+', lit(0)));
      expect(result).toBe(col);
    });

    it('0 + X => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(lit(0), '+', col));
      expect(result).toBe(col);
    });

    it('X - 0 => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(col, '-', lit(0)));
      expect(result).toBe(col);
    });

    it('X * 1 => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(col, '*', lit(1)));
      expect(result).toBe(col);
    });

    it('1 * X => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(lit(1), '*', col));
      expect(result).toBe(col);
    });

    it('X * 0 is NOT folded to 0 (NULL * 0 = NULL in SQL)', () => {
      const result = simplifyExpression(bin(colRef('t', 'amount'), '*', lit(0)));
      expect(result.kind).toBe(BoundExprKind.BINARY);
    });

    it('0 * X is NOT folded to 0 (NULL * 0 = NULL in SQL)', () => {
      const result = simplifyExpression(bin(lit(0), '*', colRef('t', 'amount')));
      expect(result.kind).toBe(BoundExprKind.BINARY);
    });

    it('X / 1 => X', () => {
      const col = colRef('t', 'amount');
      const result = simplifyExpression(bin(col, '/', lit(1)));
      expect(result).toBe(col);
    });
  });

  describe('constant folding', () => {
    it('folds 2 + 3 => 5', () => {
      const result = simplifyExpression(bin(lit(2), '+', lit(3)));
      expect(result.value).toBe(5);
    });

    it('folds 10 - 4 => 6', () => {
      const result = simplifyExpression(bin(lit(10), '-', lit(4)));
      expect(result.value).toBe(6);
    });

    it('folds 3 * 7 => 21', () => {
      const result = simplifyExpression(bin(lit(3), '*', lit(7)));
      expect(result.value).toBe(21);
    });

    it('folds 10 / 2 => 5', () => {
      const result = simplifyExpression(bin(lit(10), '/', lit(2)));
      expect(result.value).toBe(5);
    });

    it('folds 5 = 5 => true', () => {
      const result = simplifyExpression(bin(lit(5), '=', lit(5)));
      expect(result.value).toBe(true);
    });

    it('folds 3 > 5 => false', () => {
      const result = simplifyExpression(bin(lit(3), '>', lit(5)));
      expect(result.value).toBe(false);
    });

    it('folds 3 < 5 => true', () => {
      const result = simplifyExpression(bin(lit(3), '<', lit(5)));
      expect(result.value).toBe(true);
    });

    it('folds nested arithmetic: (2+3) * (4-1) => 15', () => {
      const inner1 = bin(lit(2), '+', lit(3));
      const inner2 = bin(lit(4), '-', lit(1));
      const result = simplifyExpression(bin(inner1, '*', inner2));
      expect(result.value).toBe(15);
    });
  });

  describe('CASE simplification', () => {
    it('removes WHEN clauses with false condition', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: lit(false), result: lit(1) },
          { condition: colRef('t', 'a'), result: lit(2) },
        ],
        elseExpr: lit(0),
        resultType: 'INT',
      };
      const result = simplifyExpression(expr);
      expect(result.whenClauses).toHaveLength(1);
    });

    it('returns result directly when WHEN condition is true', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: lit(true), result: lit(42) },
          { condition: colRef('t', 'a'), result: lit(99) },
        ],
        elseExpr: lit(0),
        resultType: 'INT',
      };
      const result = simplifyExpression(expr);
      expect(result.value).toBe(42);
    });

    it('returns else when all WHEN clauses are false', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: lit(false), result: lit(1) },
          { condition: lit(false), result: lit(2) },
        ],
        elseExpr: lit(99),
        resultType: 'INT',
      };
      const result = simplifyExpression(expr);
      expect(result.value).toBe(99);
    });

    it('returns null literal when all WHEN false and no else', () => {
      const expr = {
        kind: BoundExprKind.CASE,
        whenClauses: [
          { condition: lit(false), result: lit(1) },
        ],
        elseExpr: null,
        resultType: 'INT',
      };
      const result = simplifyExpression(expr);
      expect(result.value).toBe(null);
    });
  });

  describe('OR factoring of common conjuncts', () => {
    it('factors (A AND B) OR (A AND C) => A AND (B OR C)', () => {
      const a = bin(colRef('t', 'x'), '=', lit(1));
      const b = bin(colRef('t', 'y'), '=', lit(2));
      const c = bin(colRef('t', 'z'), '=', lit(3));
      const left = bin(a, 'AND', b);
      const right = bin(a, 'AND', c);
      const expr = bin(left, 'OR', right);

      const result = simplifyExpression(expr);

      expect(result.op).toBe('AND');
    });
  });

  describe('FUNCTION argument simplification', () => {
    it('simplifies expressions inside function args', () => {
      const expr = {
        kind: BoundExprKind.FUNCTION,
        name: 'ABS',
        args: [bin(lit(3), '+', lit(4))],
      };
      const result = simplifyExpression(expr);
      expect(result.args[0].value).toBe(7);
    });
  });

  describe('CAST simplification', () => {
    it('folds CAST of constant expression into literal', () => {
      const expr = {
        kind: BoundExprKind.CAST,
        expr: bin(lit(1), '+', lit(2)),
        targetType: 'VARCHAR',
      };
      const result = simplifyExpression(expr);
      expect(result.kind).toBe(BoundExprKind.LITERAL);
      expect(result.value).toBe('3');
    });
  });

  describe('null and undefined input', () => {
    it('returns null for null input', () => {
      expect(simplifyExpression(null)).toBe(null);
    });

    it('returns undefined for undefined input', () => {
      expect(simplifyExpression(undefined)).toBe(undefined);
    });
  });
});

describe('ExpressionSimplifier pass', () => {
  describe('FILTER rewriting', () => {
    it('removes FILTER when condition simplifies to true', () => {
      const plan = LogicalFilter(
        bin(lit(true), 'AND', lit(true)),
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.SCAN);
    });

    it('keeps FILTER when condition does not simplify to true', () => {
      const plan = LogicalFilter(
        bin(colRef('t', 'id'), '>', lit(0)),
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
    });

    it('simplifies condition inside FILTER', () => {
      const plan = LogicalFilter(
        bin(bin(colRef('t', 'id'), '>', lit(0)), 'AND', lit(true)),
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.FILTER);
      expect(result.condition.op).toBe('>');
    });
  });

  describe('PROJECT rewriting', () => {
    it('folds constants in projection expressions', () => {
      const plan = LogicalProject(
        [bin(lit(2), '+', lit(3)), colRef('t', 'id')],
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.expressions[0].value).toBe(5);
      expect(result.expressions[1].kind).toBe(BoundExprKind.COLUMN_REF);
    });
  });

  describe('JOIN condition rewriting', () => {
    it('simplifies join condition', () => {
      const plan = LogicalJoin(
        JoinType.INNER,
        bin(bin(colRef('a', 'id'), '=', colRef('b', 'a_id')), 'AND', lit(true)),
        scan('a'),
        scan('b')
      );
      const result = pass.apply(plan);
      expect(result.condition.op).toBe('=');
    });
  });

  describe('recursive rewriting', () => {
    it('simplifies expressions in nested plan nodes', () => {
      const plan = LogicalProject(
        [colRef('t', 'id')],
        LogicalFilter(
          bin(lit(true), 'AND', bin(colRef('t', 'id'), '>', lit(0))),
          scan('t')
        )
      );
      const result = pass.apply(plan);
      expect(result.children[0].condition.op).toBe('>');
    });
  });

  describe('FILTER with false condition returns EMPTY', () => {
    it('produces EMPTY node when condition is literal false', () => {
      const plan = LogicalFilter(lit(false), scan('t'));
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });

    it('produces EMPTY when AND simplifies to false', () => {
      const plan = LogicalFilter(
        bin(lit(true), 'AND', lit(false)),
        scan('t')
      );
      const result = pass.apply(plan);
      expect(result.type).toBe(PlanNodeType.EMPTY);
    });
  });

  describe('EXTRACT folding', () => {
    it('folds EXTRACT(YEAR FROM date literal)', () => {
      const dateVal = new Date(2024, 5, 15);
      const expr = {
        kind: BoundExprKind.EXTRACT,
        field: 'YEAR',
        source: { kind: BoundExprKind.LITERAL, value: dateVal, dataType: 'DATE' },
      };
      const result = simplifyExpression(expr);
      expect(result.kind).toBe(BoundExprKind.LITERAL);
      expect(result.value).toBe(2024);
    });

    it('folds EXTRACT(MONTH FROM date literal)', () => {
      const dateVal = new Date(2024, 11, 25);
      const expr = {
        kind: BoundExprKind.EXTRACT,
        field: 'MONTH',
        source: { kind: BoundExprKind.LITERAL, value: dateVal, dataType: 'DATE' },
      };
      const result = simplifyExpression(expr);
      expect(result.kind).toBe(BoundExprKind.LITERAL);
      expect(result.value).toBe(12);
    });
  });
});
