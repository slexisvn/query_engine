import { LogicalPlanner, createLogicalPlan } from '../../src/planner/logical-planner.js';
import { PlanNodeType, JoinType } from '../../src/planner/logical-plan.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { Binder } from '../../src/binder/binder.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { FunctionRegistry } from '../../src/catalog/function-registry.js';
import { DataType } from '../../src/storage/data-type.js';
import { parse } from '../../src/parser/parser.js';

function makeCatalog() {
  const c = new Catalog();
  c.registerTable('users', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'NAME', dataType: DataType.VARCHAR },
    { name: 'ACTIVE', dataType: DataType.BOOLEAN },
    { name: 'AGE', dataType: DataType.INT32 },
    { name: 'DEPT', dataType: DataType.VARCHAR },
  ]);
  c.registerTable('orders', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'USER_ID', dataType: DataType.INT32 },
    { name: 'TOTAL', dataType: DataType.DECIMAL },
    { name: 'STATUS', dataType: DataType.VARCHAR },
  ]);
  c.registerTable('products', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'NAME', dataType: DataType.VARCHAR },
    { name: 'PRICE', dataType: DataType.FLOAT64 },
    { name: 'CATEGORY', dataType: DataType.VARCHAR },
  ]);
  c.registerTable('order_items', [
    { name: 'ORDER_ID', dataType: DataType.INT32 },
    { name: 'PRODUCT_ID', dataType: DataType.INT32 },
    { name: 'QTY', dataType: DataType.INT32 },
    { name: 'PRICE', dataType: DataType.DECIMAL },
  ]);
  return c;
}

function planSQL(sql) {
  const catalog = makeCatalog();
  const registry = new FunctionRegistry();
  const binder = new Binder(catalog, registry);
  return createLogicalPlan(binder.bind(parse(sql)));
}

function collect(plan) {
  const nodes = [];
  const stack = [plan];
  while (stack.length) {
    const n = stack.pop();
    nodes.push(n);
    if (n.children) stack.push(...n.children);
  }
  return nodes;
}

function find(plan, type) {
  return collect(plan).find(n => n.type === type);
}

function findAll(plan, type) {
  return collect(plan).filter(n => n.type === type);
}

describe('plan structure', () => {
  it('full query builds Limit → Project → Sort → HAVING Filter → Aggregate → WHERE Filter → Join → 2 Scans', () => {
    const plan = planSQL(`
      SELECT u.name, COUNT(*) AS cnt
      FROM users u
      JOIN orders o ON u.id = o.user_id
      WHERE u.active = TRUE
      GROUP BY u.name
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC
      LIMIT 10
    `);

    expect(plan.type).toBe(PlanNodeType.LIMIT);
    expect(plan.count).toBe(10);

    const proj = plan.children[0];
    expect(proj.type).toBe(PlanNodeType.PROJECT);
    expect(proj.expressions).toHaveLength(2);

    const sort = proj.children[0];
    expect(sort.type).toBe(PlanNodeType.SORT);
    expect(sort.orderKeys[0].direction).toBe('DESC');

    const havingFilter = sort.children[0];
    expect(havingFilter.type).toBe(PlanNodeType.FILTER);
    expect(havingFilter.condition.op).toBe('>');

    const agg = havingFilter.children[0];
    expect(agg.type).toBe(PlanNodeType.AGGREGATE);
    expect(agg.groupBy).toHaveLength(1);
    expect(agg.aggregates.length).toBeGreaterThanOrEqual(1);

    const whereFilter = agg.children[0];
    expect(whereFilter.type).toBe(PlanNodeType.FILTER);
    expect(whereFilter.condition.op).toBe('=');

    const join = whereFilter.children[0];
    expect(join.type).toBe(PlanNodeType.JOIN);
    expect(join.joinType).toBe(JoinType.INNER);
    expect(join.condition.op).toBe('=');
    expect(join.children[0].table).toBe('USERS');
    expect(join.children[1].table).toBe('ORDERS');
  });

  it('DISTINCT wraps above Project, below top-level', () => {
    const plan = planSQL('SELECT DISTINCT name, dept FROM users');
    expect(plan.type).toBe(PlanNodeType.DISTINCT);
    const proj = plan.children[0];
    expect(proj.type).toBe(PlanNodeType.PROJECT);
    expect(proj.children[0].type).toBe(PlanNodeType.SCAN);
  });

  it('SELECT without FROM projects over a single-row source', () => {
    const plan = planSQL('SELECT 1 + 2, 3 * 4');
    expect(plan.type).toBe(PlanNodeType.PROJECT);
    expect(plan.children[0].type).toBe(PlanNodeType.SINGLE_ROW);
    expect(plan.expressions[0].op).toBe('+');
    expect(plan.expressions[1].op).toBe('*');
  });

  it('aggregate without GROUP BY still produces Aggregate node', () => {
    const plan = planSQL('SELECT COUNT(*), SUM(age) FROM users');
    const agg = find(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    expect(agg.groupBy).toEqual([]);
    expect(agg.aggregates).toHaveLength(2);
  });

  it('LIMIT with OFFSET stores both values', () => {
    const plan = planSQL('SELECT * FROM users LIMIT 10 OFFSET 20');
    expect(plan.type).toBe(PlanNodeType.LIMIT);
    expect(plan.count).toBe(10);
    expect(plan.offset).toBe(20);
  });

  it('ORDER BY + LIMIT puts Limit outermost', () => {
    const plan = planSQL('SELECT * FROM users ORDER BY id LIMIT 5');
    expect(plan.type).toBe(PlanNodeType.LIMIT);
    expect(plan.children[0].type).toBe(PlanNodeType.PROJECT);
    expect(plan.children[0].children[0].type).toBe(PlanNodeType.SORT);
  });

  it('ORDER BY on non-selected column places Sort below Project', () => {
    const plan = planSQL('SELECT name FROM users ORDER BY age DESC');
    expect(plan.type).toBe(PlanNodeType.PROJECT);
    const sort = plan.children[0];
    expect(sort.type).toBe(PlanNodeType.SORT);
    expect(sort.orderKeys[0].direction).toBe('DESC');
    expect(sort.children[0].type).toBe(PlanNodeType.SCAN);
  });
});

describe('JOINs', () => {
  it('LEFT JOIN preserves join type and condition operator', () => {
    const plan = planSQL('SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id');
    const join = find(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe('LEFT');
    expect(join.condition.op).toBe('=');
    expect(join.condition.left.columnName).toBe('ID');
    expect(join.condition.right.columnName).toBe('USER_ID');
  });

  it('comma-join produces CROSS join with no condition', () => {
    const plan = planSQL('SELECT * FROM users, orders');
    const join = find(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe('CROSS');
    expect(join.condition).toBeNull();
  });

  it('3-table join chain produces 2 nested Join nodes', () => {
    const plan = planSQL(`
      SELECT * FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN order_items oi ON o.id = oi.order_id
    `);
    const joins = findAll(plan, PlanNodeType.JOIN);
    expect(joins).toHaveLength(2);

    const outerJoin = joins[0];
    expect(outerJoin.children[0].type).toBe(PlanNodeType.JOIN);
    expect(outerJoin.children[1].type).toBe(PlanNodeType.SCAN);
    expect(outerJoin.children[1].table).toBe('ORDER_ITEMS');

    const innerJoin = outerJoin.children[0];
    expect(innerJoin.children[0].table).toBe('USERS');
    expect(innerJoin.children[1].table).toBe('ORDERS');
  });

  it('4-table join chain produces 3 nested Join nodes', () => {
    const plan = planSQL(`
      SELECT * FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
    `);
    expect(findAll(plan, PlanNodeType.JOIN)).toHaveLength(3);
    expect(findAll(plan, PlanNodeType.SCAN)).toHaveLength(4);
  });

  it('WHERE filter sits above join', () => {
    const plan = planSQL('SELECT * FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 100');
    const filter = find(plan, PlanNodeType.FILTER);
    expect(filter.condition.left.columnName).toBe('TOTAL');
    expect(filter.children[0].type).toBe(PlanNodeType.JOIN);
  });
});

describe('subquery extraction', () => {
  it('EXISTS subquery becomes DependentJoin wrapping outer scan and subquery plan', () => {
    const plan = planSQL('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)');
    const dj = find(plan, PlanNodeType.DEPENDENT_JOIN);

    expect(dj.subqueryType).toBe('EXISTS');
    expect(dj.children[0].type).toBe(PlanNodeType.SCAN);
    expect(dj.children[0].table).toBe('USERS');

    const subPlan = dj.children[1];
    expect(subPlan.type).toBe(PlanNodeType.PROJECT);
    expect(find(subPlan, PlanNodeType.SCAN).table).toBe('ORDERS');
  });

  it('EXISTS detects correlated columns from outer scope', () => {
    const plan = planSQL('SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)');
    const dj = find(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(dj.correlatedColumns.length).toBeGreaterThan(0);

    const corrCol = dj.correlatedColumns[0];
    expect(corrCol.isCorrelated).toBe(true);
    expect(corrCol.columnName).toBe('ID');
  });

  it('NOT EXISTS produces NOT_EXISTS subquery type', () => {
    const plan = planSQL('SELECT * FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)');
    expect(find(plan, PlanNodeType.DEPENDENT_JOIN).subqueryType).toBe('NOT_EXISTS');
  });

  it('IN subquery produces IN type and stores the expression being compared', () => {
    const plan = planSQL('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)');
    const dj = find(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(dj.subqueryType).toBe('IN');
    expect(dj.condition.columnName).toBe('ID');
  });

  it('NOT IN subquery produces NOT_IN type', () => {
    const plan = planSQL('SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM orders)');
    expect(find(plan, PlanNodeType.DEPENDENT_JOIN).subqueryType).toBe('NOT_IN');
  });

  it('non-correlated IN subquery has empty correlatedColumns', () => {
    const plan = planSQL('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)');
    expect(find(plan, PlanNodeType.DEPENDENT_JOIN).correlatedColumns).toEqual([]);
  });

  it('scalar subquery replaces expression with _scalar placeholder and sets SCALAR type', () => {
    const plan = planSQL('SELECT * FROM users WHERE age > (SELECT AVG(age) FROM users)');
    const dj = find(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(dj.subqueryType).toBe('SCALAR');

    const filter = find(plan, PlanNodeType.FILTER);
    expect(filter.condition.op).toBe('>');
    expect(filter.condition.left.columnName).toBe('AGE');
    expect(filter.condition.right.columnName).toBe('_scalar');
    expect(filter.condition.right.kind).toBe(BoundExprKind.COLUMN_REF);
  });

  it('multiple subqueries in one WHERE produce multiple DependentJoin nodes', () => {
    const plan = planSQL(`
      SELECT * FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
        AND u.age > (SELECT AVG(age) FROM users)
    `);
    const djs = findAll(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(djs).toHaveLength(2);

    const types = djs.map(d => d.subqueryType).sort();
    expect(types).toEqual(['EXISTS', 'SCALAR']);
  });

  it('DependentJoin nodes nest: outer wraps inner', () => {
    const plan = planSQL(`
      SELECT * FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
        AND id IN (SELECT user_id FROM orders WHERE total > 100)
    `);
    const djs = findAll(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(djs).toHaveLength(2);

    expect(djs[0].children[0].type).toBe(PlanNodeType.DEPENDENT_JOIN);
  });

  it('BETWEEN in WHERE is preserved as BoundBetween', () => {
    const plan = planSQL('SELECT * FROM users WHERE age BETWEEN 18 AND 65');
    const filter = find(plan, PlanNodeType.FILTER);
    expect(filter.condition.kind).toBe(BoundExprKind.BETWEEN);
    expect(filter.condition.low.value).toBe(18);
    expect(filter.condition.high.value).toBe(65);
  });

  it('CASE in WHERE is preserved through walkAndReplace', () => {
    const plan = planSQL("SELECT * FROM users WHERE CASE WHEN active THEN 'y' ELSE 'n' END = 'y'");
    const filter = find(plan, PlanNodeType.FILTER);
    expect(filter.condition.left.kind).toBe(BoundExprKind.CASE);
    expect(filter.condition.left.whenClauses).toHaveLength(1);
    expect(filter.condition.left.elseExpr).not.toBeNull();
  });
});

describe('subquery in FROM', () => {
  it('inline subquery becomes the sub-plan directly (no SubqueryRef node)', () => {
    const plan = planSQL('SELECT s.id FROM (SELECT id FROM users WHERE active = TRUE) AS s');
    const nodes = collect(plan);
    expect(nodes.some(n => n.type === 'SubqueryRef')).toBe(false);
    expect(find(plan, PlanNodeType.FILTER).condition.left.columnName).toBe('ACTIVE');
    expect(find(plan, PlanNodeType.SCAN).table).toBe('USERS');
  });

  it('nested subquery in FROM with join', () => {
    const plan = planSQL(`
      SELECT s.id, o.total
      FROM (SELECT id FROM users) AS s
      JOIN orders o ON s.id = o.user_id
    `);
    const join = find(plan, PlanNodeType.JOIN);
    expect(join).toBeDefined();
    expect(findAll(plan, PlanNodeType.SCAN)).toHaveLength(2);
  });

  it('names the derived output after its alias so a join side is not confused with the other', () => {
    const plan = planSQL('SELECT s.id FROM (SELECT id FROM users) AS s JOIN orders o ON s.id = o.user_id');
    const join = find(plan, PlanNodeType.JOIN);
    const derived = join.children.find(child => child.type === PlanNodeType.PROJECT);
    expect(derived.outputAlias).toBe('S');
  });

  it('names the derived output even when the subquery does not end in a projection', () => {
    const plan = planSQL('SELECT s.id FROM (SELECT id FROM users LIMIT 3) AS s JOIN orders o ON s.id = o.user_id');
    const join = find(plan, PlanNodeType.JOIN);
    const derived = join.children.find(child => child.type === PlanNodeType.PROJECT);
    expect(derived.outputAlias).toBe('S');
    expect(derived.children[0].type).toBe(PlanNodeType.LIMIT);
    expect(derived.expressions.map(e => e.tableAlias)).toEqual(['S']);
  });
});

describe('UNION / set operations', () => {
  it('UNION produces Union node with all=false', () => {
    const plan = planSQL('SELECT id FROM users UNION SELECT id FROM orders');
    expect(plan.type).toBe(PlanNodeType.UNION);
    expect(plan.all).toBe(false);
    expect(plan.children[0].type).toBe(PlanNodeType.PROJECT);
    expect(plan.children[1].type).toBe(PlanNodeType.PROJECT);
  });

  it('UNION ALL produces Union with all=true', () => {
    expect(planSQL('SELECT id FROM users UNION ALL SELECT id FROM orders').all).toBe(true);
  });

  it('each UNION branch has its own Scan', () => {
    const plan = planSQL('SELECT id FROM users UNION SELECT id FROM orders');
    const leftScan = find(plan.children[0], PlanNodeType.SCAN);
    const rightScan = find(plan.children[1], PlanNodeType.SCAN);
    expect(leftScan.table).toBe('USERS');
    expect(rightScan.table).toBe('ORDERS');
  });

  it('chained UNION produces nested Union nodes', () => {
    const plan = planSQL('SELECT id FROM users UNION SELECT id FROM orders UNION SELECT id FROM products');
    expect(plan.type).toBe(PlanNodeType.UNION);
    expect(plan.children[0].type).toBe(PlanNodeType.UNION);
    expect(plan.children[1].type).toBe(PlanNodeType.PROJECT);
  });
});

describe('CTE handling', () => {
  it('CTE reference becomes CTEScan and plan is stored in cteMap', () => {
    const plan = planSQL('WITH active AS (SELECT * FROM users WHERE active = TRUE) SELECT * FROM active');
    const cteScan = find(plan, PlanNodeType.CTE_SCAN);
    expect(cteScan).toBeDefined();
    expect(plan._cteMap.size).toBe(1);

    const ctePlan = plan._cteMap.values().next().value;
    expect(ctePlan.type).toBe(PlanNodeType.PROJECT);
    expect(find(ctePlan, PlanNodeType.FILTER)).toBeDefined();
    expect(find(ctePlan, PlanNodeType.SCAN).table).toBe('USERS');
  });

  it('CTE scan is named after the reference alias, not the CTE definition', () => {
    const plan = planSQL('WITH active AS (SELECT id FROM users) SELECT x.id FROM active AS x');
    expect(find(plan, PlanNodeType.CTE_SCAN).alias).toBe('X');
  });

  it('two references to one CTE get their own names', () => {
    const plan = planSQL('WITH active AS (SELECT id FROM users) SELECT a.id FROM active a JOIN active b ON a.id = b.id');
    expect(findAll(plan, PlanNodeType.CTE_SCAN).map(n => n.alias).sort()).toEqual(['A', 'B']);
  });

  it('multiple CTEs both used are stored in cteMap', () => {
    const plan = planSQL(`
      WITH
        active AS (SELECT id FROM users WHERE active = TRUE),
        big_orders AS (SELECT id FROM orders WHERE total > 1000)
      SELECT * FROM active, big_orders
    `);
    expect(plan._cteMap.size).toBe(2);
  });
});

describe('complex real-world queries', () => {
  it('top customers by order total: uses Aggregate, Sort, Limit, Join', () => {
    const plan = planSQL(`
      SELECT u.name, SUM(o.total) AS total_spent
      FROM users u
      JOIN orders o ON u.id = o.user_id
      GROUP BY u.name
      ORDER BY total_spent DESC
      LIMIT 5
    `);

    expect(plan.type).toBe(PlanNodeType.LIMIT);
    expect(plan.count).toBe(5);

    const proj = plan.children[0];
    expect(proj.type).toBe(PlanNodeType.PROJECT);

    const sort = proj.children[0];
    expect(sort.type).toBe(PlanNodeType.SORT);
    expect(sort.orderKeys[0].direction).toBe('DESC');

    const agg = find(plan, PlanNodeType.AGGREGATE);
    expect(agg.groupBy).toHaveLength(1);
    expect(agg.aggregates.length).toBeGreaterThanOrEqual(1);

    const join = find(plan, PlanNodeType.JOIN);
    expect(join.joinType).toBe('INNER');
  });

  it('users with orders above average: combines EXISTS + scalar subquery patterns', () => {
    const plan = planSQL(`
      SELECT * FROM users u
      WHERE EXISTS (
        SELECT 1 FROM orders o
        WHERE o.user_id = u.id
          AND o.total > (SELECT AVG(total) FROM orders)
      )
    `);

    const outerDJ = find(plan, PlanNodeType.DEPENDENT_JOIN);
    expect(outerDJ.subqueryType).toBe('EXISTS');
    expect(outerDJ.correlatedColumns.length).toBeGreaterThan(0);
  });

  it('order summary with subquery in FROM and aggregation', () => {
    const plan = planSQL(`
      SELECT dept, COUNT(*) AS cnt
      FROM (SELECT name, dept FROM users WHERE active = TRUE) AS active_users
      GROUP BY dept
      ORDER BY cnt DESC
    `);

    const sort = find(plan, PlanNodeType.SORT);
    expect(sort).toBeDefined();
    const agg = find(plan, PlanNodeType.AGGREGATE);
    expect(agg).toBeDefined();
    const filter = find(plan, PlanNodeType.FILTER);
    expect(filter.condition.left.columnName).toBe('ACTIVE');
    expect(find(plan, PlanNodeType.SCAN).table).toBe('USERS');
  });

  it('multi-join with WHERE, GROUP BY, HAVING, ORDER BY, LIMIT', () => {
    const plan = planSQL(`
      SELECT u.name, p.category, SUM(oi.qty * oi.price) AS revenue
      FROM users u
      JOIN orders o ON u.id = o.user_id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN products p ON oi.product_id = p.id
      WHERE o.status = 'SHIPPED'
      GROUP BY u.name, p.category
      HAVING SUM(oi.qty * oi.price) > 1000
      ORDER BY revenue DESC
      LIMIT 20
    `);

    expect(plan.type).toBe(PlanNodeType.LIMIT);
    expect(plan.count).toBe(20);

    const scans = findAll(plan, PlanNodeType.SCAN);
    expect(scans).toHaveLength(4);
    const tables = scans.map(s => s.table).sort();
    // 'S'(83) < '_'(95) so ORDERS sorts before ORDER_ITEMS
    expect(tables).toEqual(['ORDERS', 'ORDER_ITEMS', 'PRODUCTS', 'USERS']);

    expect(findAll(plan, PlanNodeType.JOIN)).toHaveLength(3);

    const agg = find(plan, PlanNodeType.AGGREGATE);
    expect(agg.groupBy).toHaveLength(2);

    const filters = findAll(plan, PlanNodeType.FILTER);
    expect(filters.length).toBeGreaterThanOrEqual(2);
  });
});
