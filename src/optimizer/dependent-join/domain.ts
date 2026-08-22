import {
  BoundBinary,
  BoundColumnRef,
  BoundExprKind,
  BoundIsNull,
  type BoundColumnRefNode,
  type BoundExpr,
} from '../../binder/expression-binder.js';
import { DataType } from '../../storage/data-type.js';
import {
  JoinType,
  LogicalDistinct,
  LogicalJoin,
  LogicalProject,
  type LogicalPlanNode,
  type ProjectedExpr,
} from '../../planner/logical-plan.js';
import type { NullColumnPredicate } from '../passes/null-rejection.js';
import { CorrelationSet, decorrelateRefs, referencesCorrelation, substituteCorrelatedRefs } from './correlation.js';

export enum DomainKind {
  LIFTED = 'Lifted',
  MATERIALIZED = 'Materialized',
}

export interface DomainAnchor {
  readonly plan: LogicalPlanNode;
  readonly columns: readonly BoundColumnRefNode[];
}

export interface CorrelatedConjunct {
  readonly lift: BoundExpr | null;
  readonly keep: BoundExpr | null;
  readonly column: BoundColumnRefNode | null;
}

export interface CorrelationDomain {
  readonly kind: DomainKind;
  readonly liftsPredicates: boolean;
  readonly width: number;
  anchor(node: LogicalPlanNode): DomainAnchor;
  substitute(expr: BoundExpr, columns: readonly BoundColumnRefNode[]): BoundExpr;
  correlatedConjunct(pred: BoundExpr, columns: readonly BoundColumnRefNode[]): CorrelatedConjunct;
  columnMatcher(index: number): NullColumnPredicate;
  joinBack(columns: readonly BoundColumnRefNode[], nullSafe: readonly boolean[]): BoundExpr[];
}

export function equiBindingColumn(pred: BoundExpr, set: CorrelationSet): BoundColumnRefNode | null {
  if (pred.kind !== BoundExprKind.BINARY || pred.op !== '=') return null;
  const leftCorrelated = referencesCorrelation(pred.left, set);
  const rightCorrelated = referencesCorrelation(pred.right, set);
  if (leftCorrelated === rightCorrelated) return null;
  const inner = leftCorrelated ? pred.right : pred.left;
  return inner.kind === BoundExprKind.COLUMN_REF ? inner : null;
}

export function nullSafeEquals(outer: BoundExpr, domain: BoundExpr): BoundExpr {
  const bothPresent = BoundBinary(
    'AND',
    BoundBinary('AND', BoundIsNull(outer, true), BoundIsNull(domain, true), DataType.BOOLEAN),
    BoundBinary('=', outer, domain, DataType.BOOLEAN),
    DataType.BOOLEAN,
  );
  const bothAbsent = BoundBinary('AND', BoundIsNull(outer, false), BoundIsNull(domain, false), DataType.BOOLEAN);
  return BoundBinary('OR', bothPresent, bothAbsent, DataType.BOOLEAN);
}

export class LiftedDomain implements CorrelationDomain {
  readonly kind = DomainKind.LIFTED;
  readonly liftsPredicates = true;
  readonly width = 0;
  private readonly set: CorrelationSet;

  constructor(set: CorrelationSet) {
    this.set = set;
  }

  columnMatcher(): NullColumnPredicate {
    return () => false;
  }

  anchor(node: LogicalPlanNode): DomainAnchor {
    return { plan: node, columns: [] };
  }

  substitute(expr: BoundExpr): BoundExpr {
    return expr;
  }

  correlatedConjunct(pred: BoundExpr): CorrelatedConjunct {
    return { lift: decorrelateRefs(pred, this.set), keep: null, column: equiBindingColumn(pred, this.set) };
  }

  joinBack(): BoundExpr[] {
    return [];
  }
}

let domainInstanceCount = 0;

export class MaterializedDomain implements CorrelationDomain {
  readonly kind = DomainKind.MATERIALIZED;
  readonly liftsPredicates = false;
  private readonly aliases = new Set<string>();
  private readonly set: CorrelationSet;
  private readonly outer: LogicalPlanNode;
  private readonly names: readonly string[];

  constructor(set: CorrelationSet, outer: LogicalPlanNode) {
    this.set = set;
    this.outer = outer;
    this.names = set.columns.map((_, index) => `c${index}`);
  }

  get width(): number {
    return this.set.size;
  }

  columnMatcher(index: number): NullColumnPredicate {
    const name = this.names[index].toUpperCase();
    return (ref) => this.aliases.has((ref.tableAlias || '').toUpperCase())
      && (ref.columnName || '').toUpperCase() === name;
  }

  anchor(node: LogicalPlanNode): DomainAnchor {
    const alias = `__domain_${domainInstanceCount++}`;
    this.aliases.add(alias.toUpperCase());
    const projections: ProjectedExpr[] = this.set.columns.map((column, index) => ({
      ...decorrelateRefs(column, this.set),
      outputName: this.names[index],
    }));
    const relation = LogicalDistinct(LogicalProject(projections, this.outer, alias));
    const columns = this.set.columns.map((column, index) =>
      BoundColumnRef(alias, this.names[index], index, column.dataType));
    return { plan: LogicalJoin(JoinType.CROSS, null, node, relation), columns };
  }

  substitute(expr: BoundExpr, columns: readonly BoundColumnRefNode[]): BoundExpr {
    return substituteCorrelatedRefs(expr, this.set, (ref) => {
      const index = this.set.indexOf(ref);
      if (index < 0 || index >= columns.length) {
        throw new Error(`Correlated column ${ref.tableAlias}.${ref.columnName} has no domain column at this point in the subquery`);
      }
      return columns[index];
    });
  }

  correlatedConjunct(pred: BoundExpr, columns: readonly BoundColumnRefNode[]): CorrelatedConjunct {
    return { lift: null, keep: this.substitute(pred, columns), column: null };
  }

  joinBack(columns: readonly BoundColumnRefNode[], nullSafe: readonly boolean[]): BoundExpr[] {
    return this.set.columns.map((column, index) => {
      const outer = decorrelateRefs(column, this.set);
      return nullSafe[index]
        ? nullSafeEquals(outer, columns[index])
        : BoundBinary('=', outer, columns[index], DataType.BOOLEAN);
    });
  }
}
