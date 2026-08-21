import { Binder } from '../../src/binder/binder.js';
import { BoundExprKind } from '../../src/binder/expression-binder.js';
import { BinderScope } from '../../src/binder/scope.js';
import { Catalog } from '../../src/catalog/catalog.js';
import { FunctionRegistry } from '../../src/catalog/function-registry.js';
import { DataType } from '../../src/storage/data-type.js';
import { parse } from '../../src/parser/parser.js';

function createTestCatalog() {
  const catalog = new Catalog();
  catalog.registerTable('users', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'NAME', dataType: DataType.VARCHAR },
    { name: 'EMAIL', dataType: DataType.VARCHAR },
    { name: 'AGE', dataType: DataType.INT32 },
    { name: 'ACTIVE', dataType: DataType.BOOLEAN },
  ]);
  catalog.registerTable('orders', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'USER_ID', dataType: DataType.INT32 },
    { name: 'TOTAL', dataType: DataType.DECIMAL },
    { name: 'ORDER_DATE', dataType: DataType.DATE },
  ]);
  catalog.registerTable('products', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'NAME', dataType: DataType.VARCHAR },
    { name: 'PRICE', dataType: DataType.FLOAT64 },
  ]);
  return catalog;
}

function bind(sql, catalog) {
  catalog = catalog || createTestCatalog();
  const registry = new FunctionRegistry();
  const binder = new Binder(catalog, registry);
  return binder.bind(parse(sql));
}

describe('Binder', () => {
  describe('basic SELECT binding', () => {
    it('binds SELECT with column references', () => {
      const bound = bind('SELECT id, name FROM users');
      expect(bound.type).toBe('BoundSelect');
      expect(bound.outputColumns).toHaveLength(2);
      expect(bound.outputColumns[0].name).toBe('id');
      expect(bound.outputColumns[0].dataType).toBe(DataType.INT32);
      expect(bound.outputColumns[1].name).toBe('name');
      expect(bound.outputColumns[1].dataType).toBe(DataType.VARCHAR);
    });

    it('binds SELECT * expanding all columns', () => {
      const bound = bind('SELECT * FROM users');
      expect(bound.outputColumns).toHaveLength(5);
      expect(bound.outputColumns.map(c => c.name)).toEqual(['ID', 'NAME', 'EMAIL', 'AGE', 'ACTIVE']);
    });

    it('binds SELECT t.* expanding table columns', () => {
      const bound = bind('SELECT u.* FROM users u');
      expect(bound.outputColumns).toHaveLength(5);
      expect(bound.selectItems[0].expr.tableAlias).toBe('U');
    });

    it('binds SELECT DISTINCT', () => {
      const bound = bind('SELECT DISTINCT name FROM users');
      expect(bound.distinct).toBe(true);
    });

    it('binds column aliases', () => {
      const bound = bind('SELECT id AS user_id FROM users');
      expect(bound.outputColumns[0].name).toBe('user_id');
    });

    it('infers column name from column ref (preserves parser case)', () => {
      const bound = bind('SELECT id FROM users');
      expect(bound.outputColumns[0].name).toBe('id');
    });

    it('infers column name from aggregate', () => {
      const bound = bind('SELECT COUNT(*) FROM users');
      expect(bound.outputColumns[0].name).toBe('count_star');
    });

    it('infers column name from function', () => {
      const bound = bind('SELECT upper(name) FROM users');
      expect(bound.outputColumns[0].name).toBe('upper');
    });

    it('generates fallback column name for expressions', () => {
      const bound = bind('SELECT 1 + 2');
      expect(bound.outputColumns[0].name).toBe('col0');
    });

    it('binds SELECT without FROM', () => {
      const bound = bind('SELECT 1, 2, 3');
      expect(bound.plan).toBeNull();
      expect(bound.outputColumns).toHaveLength(3);
    });
  });

  describe('COALESCE / NULLIF type inference', () => {
    it('infers COALESCE type from the first non-null-typed argument', () => {
      const bound = bind('SELECT COALESCE(NULL, id) AS y FROM users');
      expect(bound.outputColumns[0].dataType).toBe(DataType.INT32);
    });

    it('infers COALESCE type from a leading typed argument', () => {
      const bound = bind('SELECT COALESCE(id, 0) AS y FROM users');
      expect(bound.outputColumns[0].dataType).toBe(DataType.INT32);
    });

    it('infers NULLIF type past a leading NULL literal', () => {
      const bound = bind('SELECT NULLIF(NULL, age) AS y FROM users');
      expect(bound.outputColumns[0].dataType).toBe(DataType.INT32);
    });

    it('leaves COALESCE of all-untyped NULLs as a null type', () => {
      const bound = bind('SELECT COALESCE(NULL, NULL) AS y FROM users');
      expect(bound.outputColumns[0].dataType).toBeNull();
    });
  });

  describe('table references', () => {
    it('binds simple table ref', () => {
      const bound = bind('SELECT id FROM users');
      expect(bound.plan.type).toBe('TableRef');
      expect(bound.plan.tableName).toBe('USERS');
      expect(bound.plan.alias).toBe('USERS');
    });

    it('binds table with alias', () => {
      const bound = bind('SELECT u.id FROM users AS u');
      expect(bound.plan.alias).toBe('U');
      expect(bound.selectItems[0].expr.tableAlias).toBe('U');
    });

    it('throws on unknown table', () => {
      expect(() => bind('SELECT * FROM nonexistent')).toThrow('Unknown table: nonexistent');
    });

    it('is case-insensitive for table names', () => {
      const bound = bind('SELECT id FROM USERS');
      expect(bound.plan.tableName).toBe('USERS');
    });
  });

  describe('column resolution', () => {
    it('resolves unqualified column', () => {
      const bound = bind('SELECT name FROM users');
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.COLUMN_REF);
      expect(expr.columnName).toBe('NAME');
      expect(expr.columnIndex).toBe(1);
      expect(expr.dataType).toBe(DataType.VARCHAR);
    });

    it('resolves qualified column reference', () => {
      const bound = bind('SELECT u.name FROM users u');
      const expr = bound.selectItems[0].expr;
      expect(expr.tableAlias).toBe('U');
      expect(expr.columnName).toBe('NAME');
    });

    it('throws on unknown column', () => {
      expect(() => bind('SELECT nonexistent FROM users')).toThrow('Unknown column: nonexistent');
    });

    it('throws on ambiguous column without qualifier', () => {
      expect(() => bind('SELECT id FROM users JOIN orders ON users.id = orders.id')).toThrow('Ambiguous column reference');
    });

    it('resolves ambiguous column with qualifier', () => {
      const bound = bind('SELECT users.id FROM users JOIN orders ON users.id = orders.user_id');
      expect(bound.selectItems[0].expr.tableAlias).toBe('USERS');
    });
  });

  describe('literals', () => {
    it('binds integer literal as INT32', () => {
      const bound = bind('SELECT 42');
      expect(bound.selectItems[0].expr.value).toBe(42);
      expect(bound.selectItems[0].expr.dataType).toBe(DataType.INT32);
    });

    it('binds float literal as FLOAT64', () => {
      const bound = bind('SELECT 3.14');
      expect(bound.selectItems[0].expr.value).toBe(3.14);
      expect(bound.selectItems[0].expr.dataType).toBe(DataType.FLOAT64);
    });

    it('binds string literal as VARCHAR', () => {
      const bound = bind("SELECT 'hello'");
      expect(bound.selectItems[0].expr.value).toBe('hello');
      expect(bound.selectItems[0].expr.dataType).toBe(DataType.VARCHAR);
    });

    it('binds NULL literal', () => {
      const bound = bind('SELECT NULL');
      expect(bound.selectItems[0].expr.value).toBeNull();
      expect(bound.selectItems[0].expr.dataType).toBeNull();
    });

    it('binds boolean literals', () => {
      const bound = bind('SELECT TRUE, FALSE');
      expect(bound.selectItems[0].expr.value).toBe(true);
      expect(bound.selectItems[0].expr.dataType).toBe(DataType.BOOLEAN);
      expect(bound.selectItems[1].expr.value).toBe(false);
    });

    it('binds DATE literal converting to epoch days', () => {
      const bound = bind("SELECT DATE '2024-01-01'");
      const expr = bound.selectItems[0].expr;
      expect(expr.dataType).toBe(DataType.DATE);
      expect(typeof expr.value).toBe('number');
      const expectedDays = Math.floor(Date.UTC(2024, 0, 1) / 86400000);
      expect(expr.value).toBe(expectedDays);
    });
  });

  describe('binary expressions', () => {
    it('binds comparison with BOOLEAN result', () => {
      const bound = bind('SELECT * FROM users WHERE id = 1');
      expect(bound.where.kind).toBe(BoundExprKind.BINARY);
      expect(bound.where.op).toBe('=');
      expect(bound.where.resultType).toBe(DataType.BOOLEAN);
    });

    it('binds all comparison operators as BOOLEAN', () => {
      for (const op of ['=', '<>', '<', '>', '<=', '>=']) {
        const bound = bind(`SELECT * FROM users WHERE id ${op === '<>' ? '<>' : op} 1`);
        expect(bound.where.resultType).toBe(DataType.BOOLEAN);
      }
    });

    it('binds AND/OR as BOOLEAN', () => {
      const bound = bind('SELECT * FROM users WHERE id > 0 AND active = TRUE');
      expect(bound.where.resultType).toBe(DataType.BOOLEAN);
      expect(bound.where.op).toBe('AND');
    });

    it('binds concatenation as VARCHAR', () => {
      const bound = bind("SELECT name || ' ' || email FROM users");
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.VARCHAR);
    });

    it('widens INT32 + INT32 to INT64 so the sum cannot wrap', () => {
      const bound = bind('SELECT id + age FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT64);
    });

    it('types integer division as FLOAT64 so the quotient keeps its fraction', () => {
      const bound = bind('SELECT id / age FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('keeps modulo on integers as an integer', () => {
      const bound = bind('SELECT id % age FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT32);
    });

    it('infers arithmetic type INT32 + FLOAT64 = FLOAT64', () => {
      const bound = bind('SELECT users.age + products.price FROM users, products');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('infers arithmetic type INT32 + DECIMAL = DECIMAL', () => {
      const bound = bind('SELECT users.id + orders.total FROM users, orders');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.DECIMAL);
    });
  });

  describe('unary expressions', () => {
    it('binds NOT as BOOLEAN', () => {
      const bound = bind('SELECT * FROM users WHERE NOT active');
      expect(bound.where.kind).toBe(BoundExprKind.UNARY);
      expect(bound.where.op).toBe('NOT');
      expect(bound.where.resultType).toBe(DataType.BOOLEAN);
    });

    it('binds unary minus preserving type', () => {
      const bound = bind('SELECT -id FROM users');
      expect(bound.selectItems[0].expr.op).toBe('-');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT32);
    });
  });

  describe('WHERE clause', () => {
    it('binds WHERE with column reference', () => {
      const bound = bind('SELECT * FROM users WHERE active = TRUE');
      expect(bound.where).not.toBeNull();
      expect(bound.where.kind).toBe(BoundExprKind.BINARY);
    });

    it('binds IS NULL', () => {
      const bound = bind('SELECT * FROM users WHERE email IS NULL');
      expect(bound.where.kind).toBe(BoundExprKind.IS_NULL);
      expect(bound.where.negated).toBe(false);
    });

    it('binds IS NOT NULL', () => {
      const bound = bind('SELECT * FROM users WHERE email IS NOT NULL');
      expect(bound.where.kind).toBe(BoundExprKind.IS_NULL);
      expect(bound.where.negated).toBe(true);
    });

    it('binds BETWEEN', () => {
      const bound = bind('SELECT * FROM users WHERE age BETWEEN 18 AND 65');
      expect(bound.where.kind).toBe(BoundExprKind.BETWEEN);
      expect(bound.where.negated).toBe(false);
      expect(bound.where.low.value).toBe(18);
      expect(bound.where.high.value).toBe(65);
    });

    it('binds NOT BETWEEN', () => {
      const bound = bind('SELECT * FROM users WHERE age NOT BETWEEN 0 AND 17');
      expect(bound.where.kind).toBe(BoundExprKind.BETWEEN);
      expect(bound.where.negated).toBe(true);
    });

    it('binds IN with literal list', () => {
      const bound = bind("SELECT * FROM users WHERE name IN ('alice', 'bob')");
      expect(bound.where.kind).toBe(BoundExprKind.IN_LIST);
      expect(bound.where.list).toHaveLength(2);
      expect(bound.where.negated).toBe(false);
    });

    it('binds NOT IN', () => {
      const bound = bind('SELECT * FROM users WHERE id NOT IN (1, 2, 3)');
      expect(bound.where.negated).toBe(true);
    });

    it('binds IN with subquery', () => {
      const bound = bind('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)');
      expect(bound.where.kind).toBe(BoundExprKind.IN_LIST);
      expect(bound.where.list.kind).toBe(BoundExprKind.SUBQUERY);
      expect(bound.where.list.subqueryType).toBe('IN');
    });

    it('binds LIKE', () => {
      const bound = bind("SELECT * FROM users WHERE name LIKE '%alice%'");
      expect(bound.where.kind).toBe(BoundExprKind.LIKE);
      expect(bound.where.pattern.value).toBe('%alice%');
      expect(bound.where.negated).toBe(false);
    });

    it('binds NOT LIKE', () => {
      const bound = bind("SELECT * FROM users WHERE name NOT LIKE 'test%'");
      expect(bound.where.negated).toBe(true);
    });
  });

  describe('JOINs', () => {
    it('binds INNER JOIN', () => {
      const bound = bind('SELECT * FROM users JOIN orders ON users.id = orders.user_id');
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.plan.joinType).toBe('INNER');
      expect(bound.plan.left.tableName).toBe('USERS');
      expect(bound.plan.right.tableName).toBe('ORDERS');
      expect(bound.plan.condition.kind).toBe(BoundExprKind.BINARY);
    });

    it('binds LEFT JOIN', () => {
      const bound = bind('SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id');
      expect(bound.plan.joinType).toBe('LEFT');
    });

    it('binds CROSS JOIN without condition', () => {
      const bound = bind('SELECT * FROM users CROSS JOIN orders');
      expect(bound.plan.joinType).toBe('CROSS');
      expect(bound.plan.condition).toBeNull();
    });

    it('binds multi-table join chaining', () => {
      const bound = bind(`
        SELECT * FROM users u
        JOIN orders o ON u.id = o.user_id
        JOIN products p ON p.id = 1
      `);
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.plan.left.type).toBe('JoinRef');
      expect(bound.plan.left.left.alias).toBe('U');
      expect(bound.plan.right.alias).toBe('P');
    });

    it('resolves columns across joined tables', () => {
      const bound = bind('SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id');
      expect(bound.selectItems[0].expr.tableAlias).toBe('U');
      expect(bound.selectItems[0].expr.columnName).toBe('NAME');
      expect(bound.selectItems[1].expr.tableAlias).toBe('O');
      expect(bound.selectItems[1].expr.columnName).toBe('TOTAL');
    });

    it('binds implicit CROSS JOIN from comma-separated tables', () => {
      const bound = bind('SELECT * FROM users, orders');
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.plan.joinType).toBe('CROSS');
    });
  });

  describe('subqueries', () => {
    it('binds subquery in FROM clause', () => {
      const bound = bind('SELECT s.id FROM (SELECT id FROM users) AS s');
      expect(bound.plan.type).toBe('SubqueryRef');
      expect(bound.plan.alias).toBe('S');
      expect(bound.plan.query.type).toBe('BoundSelect');
    });

    it('binds scalar subquery in SELECT', () => {
      const bound = bind('SELECT (SELECT 1)');
      expect(bound.selectItems[0].expr.kind).toBe(BoundExprKind.SUBQUERY);
      expect(bound.selectItems[0].expr.subqueryType).toBe('SCALAR');
    });

    it('binds EXISTS subquery', () => {
      const bound = bind('SELECT * FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)');
      expect(bound.where.kind).toBe(BoundExprKind.EXISTS);
      expect(bound.where.negated).toBe(false);
    });

    it('binds correlated subquery with depth > 0', () => {
      const bound = bind('SELECT * FROM users u WHERE u.id IN (SELECT o.user_id FROM orders o WHERE o.user_id = u.id)');
      const subPlan = bound.where.list.plan;
      const whereExpr = subPlan.where;
      const rightSide = whereExpr.right;
      expect(rightSide.isCorrelated).toBe(true);
      expect(rightSide.depth).toBeGreaterThan(0);
    });
  });

  describe('aggregates', () => {
    it('binds COUNT(*)', () => {
      const bound = bind('SELECT COUNT(*) FROM users');
      const agg = bound.selectItems[0].expr;
      expect(agg.kind).toBe(BoundExprKind.AGGREGATE);
      expect(agg.name).toBe('COUNT_STAR');
      expect(agg.resultType).toBe(DataType.INT64);
    });

    it('binds COUNT(column)', () => {
      const bound = bind('SELECT COUNT(id) FROM users');
      const agg = bound.selectItems[0].expr;
      expect(agg.name).toBe('COUNT');
      expect(agg.resultType).toBe(DataType.INT64);
    });

    it('binds COUNT(DISTINCT column)', () => {
      const bound = bind('SELECT COUNT(DISTINCT name) FROM users');
      expect(bound.selectItems[0].expr.distinct).toBe(true);
    });

    it('widens SUM over an integer column to INT64', () => {
      const bound = bind('SELECT SUM(age) FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT64);
    });

    it('keeps SUM over a float column as FLOAT64', () => {
      const bound = bind('SELECT SUM(price) FROM products');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('binds AVG always as FLOAT64', () => {
      const bound = bind('SELECT AVG(age) FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('binds MIN/MAX inheriting arg type', () => {
      const bound = bind('SELECT MIN(age), MAX(age) FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT32);
      expect(bound.selectItems[1].expr.resultType).toBe(DataType.INT32);
    });

    it('tracks aggregates found during binding', () => {
      const bound = bind('SELECT COUNT(*), SUM(age), AVG(age) FROM users');
      expect(bound.aggregates).toHaveLength(3);
    });

    it('tracks aggregates from HAVING clause', () => {
      const bound = bind('SELECT name, COUNT(*) FROM users GROUP BY name HAVING COUNT(*) > 5');
      expect(bound.aggregates.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GROUP BY', () => {
    it('binds GROUP BY columns', () => {
      const bound = bind('SELECT name, COUNT(*) FROM users GROUP BY name');
      expect(bound.groupBy).toHaveLength(1);
      expect(bound.groupBy[0].kind).toBe(BoundExprKind.COLUMN_REF);
    });

    it('binds GROUP BY with multiple columns', () => {
      const bound = bind('SELECT name, email, COUNT(*) FROM users GROUP BY name, email');
      expect(bound.groupBy).toHaveLength(2);
    });

    it('resolves GROUP BY referencing select alias', () => {
      const bound = bind('SELECT name AS n, COUNT(*) FROM users GROUP BY n');
      expect(bound.groupBy[0].kind).toBe(BoundExprKind.COLUMN_REF);
      expect(bound.groupBy[0].columnName).toBe('NAME');
    });
  });

  describe('HAVING', () => {
    it('binds HAVING clause', () => {
      const bound = bind('SELECT name, COUNT(*) FROM users GROUP BY name HAVING COUNT(*) > 1');
      expect(bound.having).not.toBeNull();
      expect(bound.having.kind).toBe(BoundExprKind.BINARY);
      expect(bound.having.op).toBe('>');
    });
  });

  describe('ORDER BY', () => {
    it('binds ORDER BY', () => {
      const bound = bind('SELECT id, name FROM users ORDER BY name');
      expect(bound.orderBy).toHaveLength(1);
      expect(bound.orderBy[0].direction).toBe('ASC');
    });

    it('binds ORDER BY DESC', () => {
      const bound = bind('SELECT * FROM users ORDER BY id DESC');
      expect(bound.orderBy[0].direction).toBe('DESC');
    });

    it('resolves ORDER BY using select alias', () => {
      const bound = bind('SELECT id AS uid FROM users ORDER BY uid');
      expect(bound.orderBy[0].expr.kind).toBe(BoundExprKind.COLUMN_REF);
      expect(bound.orderBy[0].expr.columnName).toBe('ID');
    });

    it('binds ORDER BY with NULLS FIRST/LAST', () => {
      const bound = bind('SELECT * FROM users ORDER BY name ASC NULLS LAST');
      expect(bound.orderBy[0].nullOrder).toBe('LAST');
    });
  });

  describe('LIMIT / OFFSET', () => {
    it('binds LIMIT', () => {
      const bound = bind('SELECT * FROM users LIMIT 10');
      expect(bound.limit.value).toBe(10);
    });

    it('binds LIMIT and OFFSET', () => {
      const bound = bind('SELECT * FROM users LIMIT 10 OFFSET 20');
      expect(bound.limit.value).toBe(10);
      expect(bound.offset.value).toBe(20);
    });
  });

  describe('functions', () => {
    it('binds UPPER as VARCHAR', () => {
      const bound = bind('SELECT UPPER(name) FROM users');
      const fn = bound.selectItems[0].expr;
      expect(fn.kind).toBe(BoundExprKind.FUNCTION);
      expect(fn.name).toBe('UPPER');
      expect(fn.resultType).toBe(DataType.VARCHAR);
    });

    it('binds COALESCE inheriting first arg type', () => {
      const bound = bind('SELECT COALESCE(name, email) FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.VARCHAR);
    });

    it('binds ABS inheriting arg type', () => {
      const bound = bind('SELECT ABS(age) FROM users');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.INT32);
    });

    it('uppercases function names', () => {
      const bound = bind('SELECT lower(name) FROM users');
      expect(bound.selectItems[0].expr.name).toBe('LOWER');
    });
  });

  describe('CASE expression', () => {
    it('binds searched CASE', () => {
      const bound = bind("SELECT CASE WHEN age >= 18 THEN 'adult' ELSE 'minor' END FROM users");
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.CASE);
      expect(expr.whenClauses).toHaveLength(1);
      expect(expr.whenClauses[0].condition.op).toBe('>=');
      expect(expr.elseExpr).not.toBeNull();
      expect(expr.resultType).toBe(DataType.VARCHAR);
    });

    it('rewrites simple CASE into equality comparisons against the operand', () => {
      const bound = bind("SELECT CASE age WHEN 18 THEN 'adult' ELSE 'minor' END FROM users");
      const condition = bound.selectItems[0].expr.whenClauses[0].condition;
      expect(condition.kind).toBe(BoundExprKind.BINARY);
      expect(condition.op).toBe('=');
      expect(condition.left.columnName).toBe('AGE');
      expect(condition.right.value).toBe(18);
    });

    it('binds CASE without ELSE', () => {
      const bound = bind("SELECT CASE WHEN active THEN 'yes' END FROM users");
      expect(bound.selectItems[0].expr.elseExpr).toBeNull();
    });
  });

  describe('CAST', () => {
    it('binds CAST to target type', () => {
      const bound = bind('SELECT CAST(id AS VARCHAR) FROM users');
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.CAST);
      expect(expr.targetType).toBe(DataType.VARCHAR);
      expect(expr.expr.dataType).toBe(DataType.INT32);
    });

    it('resolves various type name aliases', () => {
      const types = {
        'INTEGER': DataType.INT32, 'INT': DataType.INT32,
        'BIGINT': DataType.INT64,
        'FLOAT': DataType.FLOAT64, 'DOUBLE': DataType.FLOAT64,
        'DECIMAL': DataType.DECIMAL, 'NUMERIC': DataType.DECIMAL,
        'VARCHAR': DataType.VARCHAR, 'TEXT': DataType.VARCHAR,
        'DATE': DataType.DATE,
        'BOOLEAN': DataType.BOOLEAN, 'BOOL': DataType.BOOLEAN,
      };
      for (const [sqlType, expected] of Object.entries(types)) {
        const bound = bind(`SELECT CAST(id AS ${sqlType}) FROM users`);
        expect(bound.selectItems[0].expr.targetType).toBe(expected);
      }
    });
  });

  describe('EXTRACT', () => {
    it('binds EXTRACT with INT32 result', () => {
      const bound = bind('SELECT EXTRACT(YEAR FROM order_date) FROM orders');
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.EXTRACT);
      expect(expr.field).toBe('YEAR');
      expect(expr.resultType).toBe(DataType.INT32);
    });
  });

  describe('SUBSTRING', () => {
    it('binds SUBSTRING as FUNCTION with VARCHAR result', () => {
      const bound = bind('SELECT SUBSTRING(name FROM 1 FOR 3) FROM users');
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.FUNCTION);
      expect(expr.name).toBe('SUBSTRING');
      expect(expr.resultType).toBe(DataType.VARCHAR);
      expect(expr.args).toHaveLength(3);
    });

    it('binds SUBSTRING without FOR (2 args)', () => {
      const bound = bind('SELECT SUBSTRING(name FROM 1) FROM users');
      expect(bound.selectItems[0].expr.args).toHaveLength(2);
    });
  });

  describe('INTERVAL', () => {
    it('binds INTERVAL literal', () => {
      const bound = bind("SELECT INTERVAL '30' DAY");
      const expr = bound.selectItems[0].expr;
      expect(expr.kind).toBe(BoundExprKind.INTERVAL);
      expect(expr.value).toBe(30);
      expect(expr.unit).toBe('DAY');
      expect(expr.resultType).toBe(DataType.INT32);
    });
  });

  describe('WITH (CTE)', () => {
    it('binds CTE and resolves it as table', () => {
      const bound = bind(`
        WITH active_users AS (SELECT id, name FROM users WHERE active = TRUE)
        SELECT * FROM active_users
      `);
      expect(bound.plan.type).toBe('CTERef');
      expect(bound.plan.cteName).toBe('active_users');
      expect(bound.plan.columns).toHaveLength(2);
    });

    it('binds multiple CTEs', () => {
      const bound = bind(`
        WITH
          a AS (SELECT id FROM users),
          b AS (SELECT id FROM orders)
        SELECT * FROM a, b
      `);
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.plan.left.type).toBe('CTERef');
      expect(bound.plan.right.type).toBe('CTERef');
    });

    it('respects CTE column aliases', () => {
      const bound = bind(`
        WITH totals(uid, cnt) AS (SELECT user_id, COUNT(*) FROM orders GROUP BY user_id)
        SELECT * FROM totals
      `);
      expect(bound.outputColumns.map(c => c.name)).toEqual(['uid', 'cnt']);
    });
  });

  describe('set operations', () => {
    it('binds UNION', () => {
      const bound = bind('SELECT id, name FROM users UNION SELECT id, name FROM products');
      expect(bound.type).toBe('SetOp');
      expect(bound.op).toBe('UNION');
      expect(bound.all).toBe(false);
      expect(bound.outputColumns).toHaveLength(2);
    });

    it('binds UNION ALL', () => {
      const bound = bind('SELECT id FROM users UNION ALL SELECT id FROM orders');
      expect(bound.all).toBe(true);
    });

    it('binds EXCEPT', () => {
      const bound = bind('SELECT id FROM users EXCEPT SELECT user_id FROM orders');
      expect(bound.op).toBe('EXCEPT');
    });

    it('binds INTERSECT', () => {
      const bound = bind('SELECT id FROM users INTERSECT SELECT user_id FROM orders');
      expect(bound.op).toBe('INTERSECT');
    });

    it('output columns come from left side', () => {
      const bound = bind('SELECT id AS uid FROM users UNION SELECT id FROM orders');
      expect(bound.outputColumns[0].name).toBe('uid');
    });
  });

  describe('type inference', () => {
    it('FLOAT64 wins over INT32 in arithmetic', () => {
      const bound = bind('SELECT age + price FROM users, products');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('DECIMAL wins over INT32 in arithmetic', () => {
      const bound = bind('SELECT users.id + orders.total FROM users, orders');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.DECIMAL);
    });

    it('FLOAT64 wins over DECIMAL in arithmetic', () => {
      const bound = bind('SELECT price + total FROM products, orders');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.FLOAT64);
    });

    it('DATE type preserved when added to', () => {
      const bound = bind('SELECT order_date + 1 FROM orders');
      expect(bound.selectItems[0].expr.resultType).toBe(DataType.DATE);
    });
  });

  describe('error handling', () => {
    it('throws on star in non-SELECT position', () => {
      expect(() => bind('SELECT * FROM users WHERE * = 1')).toThrow();
    });

    it('throws on unknown column with table prefix', () => {
      expect(() => bind('SELECT users.nonexistent FROM users')).toThrow('Unknown column: users.nonexistent');
    });

    it('throws on unknown FROM node kind', () => {
      const catalog = createTestCatalog();
      const registry = new FunctionRegistry();
      const binder = new Binder(catalog, registry);
      expect(() => binder.bindFrom({ kind: 'FakeNode' }, new (BinderScope || Object)())).toThrow('Unknown FROM node kind');
    });
  });

  describe('complex queries', () => {
    it('binds full analytical query', () => {
      const bound = bind(`
        SELECT u.name, COUNT(*) AS order_count, SUM(o.total) AS total_spent
        FROM users u
        JOIN orders o ON u.id = o.user_id
        WHERE u.active = TRUE
        GROUP BY u.name
        HAVING SUM(o.total) > 100
        ORDER BY total_spent DESC
        LIMIT 10
      `);
      expect(bound.type).toBe('BoundSelect');
      expect(bound.outputColumns).toHaveLength(3);
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.where).not.toBeNull();
      expect(bound.groupBy).toHaveLength(1);
      expect(bound.having).not.toBeNull();
      expect(bound.orderBy).toHaveLength(1);
      expect(bound.limit).not.toBeNull();
      expect(bound.distinct).toBe(false);
    });

    it('binds CTE + join + aggregate + subquery', () => {
      const bound = bind(`
        WITH high_value AS (
          SELECT user_id FROM orders WHERE total > 100
        )
        SELECT u.name, COUNT(*)
        FROM users u
        JOIN high_value h ON u.id = h.user_id
        WHERE u.id NOT IN (SELECT user_id FROM orders WHERE total < 10)
        GROUP BY u.name
        ORDER BY COUNT(*) DESC
      `);
      expect(bound.withClause).toBeUndefined();
      expect(bound.plan.type).toBe('JoinRef');
      expect(bound.where.kind).toBe(BoundExprKind.IN_LIST);
      expect(bound.where.negated).toBe(true);
    });
  });
});
