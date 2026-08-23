import { parse } from '@engine/parser/parser.js';
import { Binder } from '@engine/binder/binder.js';
import { createLogicalPlan } from '@engine/planner/logical-planner.js';
import { defaultFunctionRegistry } from '@engine/catalog/function-registry.js';
import type { Catalog } from '@engine/catalog/catalog.js';
import type { QueryStmt, Statement } from '@engine/parser/ast.js';
import type { BoundQuery } from '@engine/binder/binder.js';
import type { LogicalPlanNode } from '@engine/planner/logical-plan.js';

type BinderCatalog = ConstructorParameters<typeof Binder>[0];

const EXPLAIN_KINDS = new Set(['ExplainStmt', 'ExplainAnalyzeStmt']);
const DDL_KINDS = new Set(['CreateTableStmt', 'DropTableStmt']);

export type CompilePhase = 'parse' | 'bind' | 'plan';

export interface CompileFailure {
  phase: CompilePhase;
  message: string;
}

export interface CompiledQuery {
  statement: Statement;
  query: QueryStmt;
  bound: BoundQuery;
  logicalPlan: LogicalPlanNode;
}

export type CompileOutcome =
  | { ok: true; value: CompiledQuery }
  | { ok: false; error: CompileFailure };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrapExplain(statement: Statement): QueryStmt {
  const wrapper = statement as Statement & { query?: QueryStmt };
  return EXPLAIN_KINDS.has(statement.kind) && wrapper.query ? wrapper.query : (statement as QueryStmt);
}

export function compile(sql: string, catalog: Catalog): CompileOutcome {
  let statement: Statement;
  try {
    statement = parse(sql);
  } catch (error) {
    return { ok: false, error: { phase: 'parse', message: messageOf(error) } };
  }

  if (DDL_KINDS.has(statement.kind)) {
    return { ok: false, error: { phase: 'parse', message: `${statement.kind} has no query plan — write a SELECT statement instead` } };
  }

  const query = unwrapExplain(statement);

  let bound: BoundQuery;
  try {
    bound = new Binder(catalog as BinderCatalog, defaultFunctionRegistry, []).bind(query);
  } catch (error) {
    return { ok: false, error: { phase: 'bind', message: messageOf(error) } };
  }

  let logicalPlan: LogicalPlanNode;
  try {
    logicalPlan = createLogicalPlan(bound);
  } catch (error) {
    return { ok: false, error: { phase: 'plan', message: messageOf(error) } };
  }

  return { ok: true, value: { statement, query, bound, logicalPlan } };
}
