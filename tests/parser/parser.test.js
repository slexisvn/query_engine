import { parse } from '../../src/parser/parser.js';
import { NodeKind } from '../../src/parser/ast.js';

describe('Parser', () => {
  describe('simple SELECT', () => {
    it('parses SELECT with single column', () => {
      const ast = parse('SELECT id FROM users');
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.selectItems).toHaveLength(1);
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.COLUMN_REF, name: 'id', table: null });
      expect(ast.from).toEqual({ kind: NodeKind.TABLE_REF, name: 'users', alias: 'users' });
    });

    it('parses SELECT with multiple columns', () => {
      const ast = parse('SELECT id, name, email FROM users');
      expect(ast.selectItems).toHaveLength(3);
      expect(ast.selectItems.map(i => i.expr.name)).toEqual(['id', 'name', 'email']);
    });

    it('parses SELECT *', () => {
      const ast = parse('SELECT * FROM users');
      expect(ast.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
      expect(ast.selectItems[0].expr.table).toBeNull();
    });

    it('parses SELECT t.*', () => {
      const ast = parse('SELECT t.* FROM users t');
      expect(ast.selectItems[0].expr.kind).toBe(NodeKind.ALL_COLUMNS);
      expect(ast.selectItems[0].expr.table).toBe('t');
    });

    it('parses SELECT without FROM', () => {
      const ast = parse('SELECT 1');
      expect(ast.from).toBeNull();
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: 1, dataType: null });
    });

    it('parses DISTINCT', () => {
      const ast = parse('SELECT DISTINCT name FROM users');
      expect(ast.distinct).toBe(true);
    });

    it('parses ALL (non-distinct)', () => {
      const ast = parse('SELECT ALL name FROM users');
      expect(ast.distinct).toBe(false);
    });

    it('allows trailing semicolon', () => {
      const ast = parse('SELECT 1;');
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
    });
  });

  describe('aliases', () => {
    it('parses column alias with AS', () => {
      const ast = parse('SELECT id AS user_id FROM users');
      expect(ast.selectItems[0].alias).toBe('user_id');
    });

    it('parses column alias without AS', () => {
      const ast = parse('SELECT id user_id FROM users');
      expect(ast.selectItems[0].alias).toBe('user_id');
    });

    it('parses table alias with AS', () => {
      const ast = parse('SELECT u.id FROM users AS u');
      expect(ast.from.alias).toBe('u');
      expect(ast.selectItems[0].expr.table).toBe('u');
    });

    it('parses table alias without AS', () => {
      const ast = parse('SELECT u.id FROM users u');
      expect(ast.from.alias).toBe('u');
    });
  });

  describe('WHERE clause', () => {
    it('parses simple equality', () => {
      const ast = parse("SELECT * FROM users WHERE id = 1");
      expect(ast.where.kind).toBe(NodeKind.BINARY_EXPR);
      expect(ast.where.op).toBe('=');
      expect(ast.where.left.name).toBe('id');
      expect(ast.where.right.value).toBe(1);
    });

    it('parses AND / OR with correct precedence', () => {
      const ast = parse('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
      expect(ast.where.op).toBe('OR');
      expect(ast.where.left.op).toBe('=');
      expect(ast.where.right.op).toBe('AND');
    });

    it('parses NOT', () => {
      const ast = parse('SELECT * FROM t WHERE NOT active');
      expect(ast.where.kind).toBe(NodeKind.UNARY_EXPR);
      expect(ast.where.op).toBe('NOT');
      expect(ast.where.operand.name).toBe('active');
    });

    it('parses nested NOT', () => {
      const ast = parse('SELECT * FROM t WHERE NOT NOT x');
      expect(ast.where.op).toBe('NOT');
      expect(ast.where.operand.op).toBe('NOT');
      expect(ast.where.operand.operand.name).toBe('x');
    });

    it('parses all comparison operators', () => {
      for (const [sqlOp, astOp] of [['=', '='], ['<>', '<>'], ['!=', '<>'], ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>=']]) {
        const ast = parse(`SELECT * FROM t WHERE a ${sqlOp} b`);
        expect(ast.where.op).toBe(astOp);
      }
    });

    it('parses IS NULL / IS NOT NULL', () => {
      const isNull = parse('SELECT * FROM t WHERE x IS NULL');
      expect(isNull.where.kind).toBe(NodeKind.IS_NULL_EXPR);
      expect(isNull.where.negated).toBe(false);

      const isNotNull = parse('SELECT * FROM t WHERE x IS NOT NULL');
      expect(isNotNull.where.kind).toBe(NodeKind.IS_NULL_EXPR);
      expect(isNotNull.where.negated).toBe(true);
    });
  });

  describe('BETWEEN', () => {
    it('parses BETWEEN .. AND ..', () => {
      const ast = parse('SELECT * FROM t WHERE x BETWEEN 1 AND 10');
      expect(ast.where.kind).toBe(NodeKind.BETWEEN_EXPR);
      expect(ast.where.low.value).toBe(1);
      expect(ast.where.high.value).toBe(10);
      expect(ast.where.negated).toBe(false);
    });

    it('parses NOT BETWEEN', () => {
      const ast = parse('SELECT * FROM t WHERE x NOT BETWEEN 1 AND 10');
      expect(ast.where.kind).toBe(NodeKind.BETWEEN_EXPR);
      expect(ast.where.negated).toBe(true);
    });
  });

  describe('IN', () => {
    it('parses IN with literal list', () => {
      const ast = parse('SELECT * FROM t WHERE status IN (1, 2, 3)');
      expect(ast.where.kind).toBe(NodeKind.IN_EXPR);
      expect(ast.where.list).toHaveLength(3);
      expect(ast.where.list.map(l => l.value)).toEqual([1, 2, 3]);
      expect(ast.where.negated).toBe(false);
    });

    it('parses NOT IN', () => {
      const ast = parse("SELECT * FROM t WHERE status NOT IN ('a', 'b')");
      expect(ast.where.kind).toBe(NodeKind.IN_EXPR);
      expect(ast.where.negated).toBe(true);
    });

    it('parses IN with subquery', () => {
      const ast = parse('SELECT * FROM t WHERE id IN (SELECT id FROM other)');
      expect(ast.where.kind).toBe(NodeKind.IN_EXPR);
      expect(ast.where.list.kind).toBe(NodeKind.SUBQUERY_EXPR);
      expect(ast.where.list.query.kind).toBe(NodeKind.SELECT_STMT);
    });
  });

  describe('LIKE', () => {
    it('parses LIKE', () => {
      const ast = parse("SELECT * FROM t WHERE name LIKE '%foo%'");
      expect(ast.where.kind).toBe(NodeKind.LIKE_EXPR);
      expect(ast.where.pattern.value).toBe('%foo%');
      expect(ast.where.negated).toBe(false);
    });

    it('parses NOT LIKE', () => {
      const ast = parse("SELECT * FROM t WHERE name NOT LIKE 'x%'");
      expect(ast.where.kind).toBe(NodeKind.LIKE_EXPR);
      expect(ast.where.negated).toBe(true);
    });
  });

  describe('EXISTS', () => {
    it('parses EXISTS subquery', () => {
      const ast = parse('SELECT * FROM t WHERE EXISTS (SELECT 1 FROM other WHERE other.id = t.id)');
      expect(ast.where.kind).toBe(NodeKind.EXISTS_EXPR);
      expect(ast.where.negated).toBe(false);
      expect(ast.where.query.kind).toBe(NodeKind.SELECT_STMT);
    });

    it('parses NOT EXISTS in WHERE', () => {
      const ast = parse('SELECT * FROM t WHERE NOT EXISTS (SELECT 1 FROM other)');
      expect(ast.where.kind).toBe(NodeKind.UNARY_EXPR);
      expect(ast.where.op).toBe('NOT');
      expect(ast.where.operand.kind).toBe(NodeKind.EXISTS_EXPR);
    });

    it('parses NOT EXISTS as negated ExistsExpr in primary', () => {
      const ast = parse('SELECT CASE WHEN NOT EXISTS (SELECT 1) THEN 0 END');
      const cond = ast.selectItems[0].expr.whenClauses[0].condition;
      expect(cond.kind).toBe(NodeKind.UNARY_EXPR);
      expect(cond.op).toBe('NOT');
      expect(cond.operand.kind).toBe(NodeKind.EXISTS_EXPR);
    });
  });

  describe('JOINs', () => {
    it('parses INNER JOIN', () => {
      const ast = parse('SELECT * FROM a INNER JOIN b ON a.id = b.a_id');
      expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.joinType).toBe('INNER');
      expect(ast.from.left.name).toBe('a');
      expect(ast.from.right.name).toBe('b');
      expect(ast.from.condition.op).toBe('=');
    });

    it('parses implicit INNER JOIN (just JOIN)', () => {
      const ast = parse('SELECT * FROM a JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('INNER');
    });

    it('parses LEFT JOIN', () => {
      const ast = parse('SELECT * FROM a LEFT JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('LEFT');
    });

    it('parses LEFT OUTER JOIN', () => {
      const ast = parse('SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('LEFT');
    });

    it('parses RIGHT JOIN', () => {
      const ast = parse('SELECT * FROM a RIGHT JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('RIGHT');
    });

    it('parses FULL JOIN', () => {
      const ast = parse('SELECT * FROM a FULL JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('FULL');
    });

    it('parses FULL OUTER JOIN', () => {
      const ast = parse('SELECT * FROM a FULL OUTER JOIN b ON a.id = b.a_id');
      expect(ast.from.joinType).toBe('FULL');
    });

    it('parses CROSS JOIN (no ON clause)', () => {
      const ast = parse('SELECT * FROM a CROSS JOIN b');
      expect(ast.from.joinType).toBe('CROSS');
      expect(ast.from.condition).toBeNull();
    });

    it('parses implicit CROSS JOIN with comma', () => {
      const ast = parse('SELECT * FROM a, b');
      expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.joinType).toBe('CROSS');
    });

    it('chains multiple joins left-to-right', () => {
      const ast = parse('SELECT * FROM a JOIN b ON a.id = b.id JOIN c ON b.id = c.id');
      expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.left.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.left.left.name).toBe('a');
      expect(ast.from.left.right.name).toBe('b');
      expect(ast.from.right.name).toBe('c');
    });

    it('parses subquery in FROM', () => {
      const ast = parse('SELECT * FROM (SELECT id FROM users) AS sub');
      expect(ast.from.kind).toBe(NodeKind.SUBQUERY_REF);
      expect(ast.from.alias).toBe('sub');
      expect(ast.from.query.kind).toBe(NodeKind.SELECT_STMT);
    });
  });

  describe('GROUP BY / HAVING', () => {
    it('parses GROUP BY with single column', () => {
      const ast = parse('SELECT dept, COUNT(*) FROM emp GROUP BY dept');
      expect(ast.groupBy).toHaveLength(1);
      expect(ast.groupBy[0].name).toBe('dept');
    });

    it('parses GROUP BY with multiple columns', () => {
      const ast = parse('SELECT a, b, SUM(c) FROM t GROUP BY a, b');
      expect(ast.groupBy).toHaveLength(2);
    });

    it('parses HAVING', () => {
      const ast = parse('SELECT dept, COUNT(*) cnt FROM emp GROUP BY dept HAVING COUNT(*) > 5');
      expect(ast.having.kind).toBe(NodeKind.BINARY_EXPR);
      expect(ast.having.op).toBe('>');
      expect(ast.having.left.kind).toBe(NodeKind.AGGREGATE_CALL);
    });
  });

  describe('ORDER BY', () => {
    it('parses ORDER BY with default ASC', () => {
      const ast = parse('SELECT * FROM t ORDER BY id');
      expect(ast.orderBy).toHaveLength(1);
      expect(ast.orderBy[0].direction).toBe('ASC');
    });

    it('parses ORDER BY DESC', () => {
      const ast = parse('SELECT * FROM t ORDER BY id DESC');
      expect(ast.orderBy[0].direction).toBe('DESC');
    });

    it('parses ORDER BY with NULLS FIRST / LAST', () => {
      const ast = parse('SELECT * FROM t ORDER BY a ASC NULLS FIRST, b DESC NULLS LAST');
      expect(ast.orderBy[0].nullOrder).toBe('FIRST');
      expect(ast.orderBy[1].nullOrder).toBe('LAST');
    });

    it('parses ORDER BY with multiple keys', () => {
      const ast = parse('SELECT * FROM t ORDER BY a DESC, b ASC, c');
      expect(ast.orderBy).toHaveLength(3);
      expect(ast.orderBy[0].direction).toBe('DESC');
      expect(ast.orderBy[1].direction).toBe('ASC');
      expect(ast.orderBy[2].direction).toBe('ASC');
    });
  });

  describe('LIMIT / OFFSET / FETCH', () => {
    it('parses LIMIT', () => {
      const ast = parse('SELECT * FROM t LIMIT 10');
      expect(ast.limit.value).toBe(10);
    });

    it('parses LIMIT with OFFSET', () => {
      const ast = parse('SELECT * FROM t LIMIT 10 OFFSET 20');
      expect(ast.limit.value).toBe(10);
      expect(ast.offset.value).toBe(20);
    });

    it('parses FETCH FIRST n ROWS ONLY', () => {
      const ast = parse('SELECT * FROM t FETCH FIRST 5 ROWS ONLY');
      expect(ast.limit.value).toBe(5);
    });

    it('parses FETCH NEXT n ROWS ONLY', () => {
      const ast = parse('SELECT * FROM t FETCH NEXT 5 ROWS ONLY');
      expect(ast.limit.value).toBe(5);
    });

    it('parses OFFSET before FETCH', () => {
      const ast = parse('SELECT * FROM t LIMIT 10 OFFSET 5 FETCH FIRST 3 ROWS ONLY');
      expect(ast.offset.value).toBe(5);
      expect(ast.limit.value).toBe(3);
    });
  });

  describe('literals', () => {
    it('parses integer literal', () => {
      const ast = parse('SELECT 42');
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: 42, dataType: null });
    });

    it('parses decimal literal', () => {
      const ast = parse('SELECT 3.14');
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: 3.14, dataType: null });
    });

    it('parses string literal', () => {
      const ast = parse("SELECT 'hello'");
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: 'hello', dataType: 'VARCHAR' });
    });

    it('parses NULL literal', () => {
      const ast = parse('SELECT NULL');
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: null, dataType: null });
    });

    it('parses boolean literals', () => {
      const ast = parse('SELECT TRUE, FALSE');
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: true, dataType: 'BOOLEAN' });
      expect(ast.selectItems[1].expr).toEqual({ kind: NodeKind.LITERAL, value: false, dataType: 'BOOLEAN' });
    });

    it('parses DATE literal', () => {
      const ast = parse("SELECT DATE '2024-01-15'");
      expect(ast.selectItems[0].expr).toEqual({ kind: NodeKind.LITERAL, value: '2024-01-15', dataType: 'DATE' });
    });
  });

  describe('arithmetic expressions', () => {
    it('respects multiplication over addition precedence', () => {
      const ast = parse('SELECT 1 + 2 * 3');
      const expr = ast.selectItems[0].expr;
      expect(expr.op).toBe('+');
      expect(expr.left.value).toBe(1);
      expect(expr.right.op).toBe('*');
      expect(expr.right.left.value).toBe(2);
      expect(expr.right.right.value).toBe(3);
    });

    it('respects parentheses overriding precedence', () => {
      const ast = parse('SELECT (1 + 2) * 3');
      const expr = ast.selectItems[0].expr;
      expect(expr.op).toBe('*');
      expect(expr.left.op).toBe('+');
    });

    it('parses unary minus', () => {
      const ast = parse('SELECT -1');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.UNARY_EXPR);
      expect(expr.op).toBe('-');
      expect(expr.operand.value).toBe(1);
    });

    it('parses unary plus (just strips it)', () => {
      const ast = parse('SELECT +42');
      expect(ast.selectItems[0].expr.value).toBe(42);
    });

    it('parses division and modulo', () => {
      const ast = parse('SELECT a / b % c');
      const expr = ast.selectItems[0].expr;
      expect(expr.op).toBe('%');
      expect(expr.left.op).toBe('/');
    });

    it('parses string concatenation', () => {
      const ast = parse("SELECT 'a' || 'b'");
      const expr = ast.selectItems[0].expr;
      expect(expr.op).toBe('||');
    });
  });

  describe('aggregate functions', () => {
    it('parses COUNT(*)', () => {
      const ast = parse('SELECT COUNT(*) FROM t');
      const agg = ast.selectItems[0].expr;
      expect(agg.kind).toBe(NodeKind.AGGREGATE_CALL);
      expect(agg.name).toBe('COUNT_STAR');
      expect(agg.args).toEqual([]);
    });

    it('parses COUNT(column)', () => {
      const ast = parse('SELECT COUNT(id) FROM t');
      const agg = ast.selectItems[0].expr;
      expect(agg.name).toBe('COUNT');
      expect(agg.args[0].name).toBe('id');
      expect(agg.distinct).toBe(false);
    });

    it('parses COUNT(DISTINCT column)', () => {
      const ast = parse('SELECT COUNT(DISTINCT category) FROM t');
      const agg = ast.selectItems[0].expr;
      expect(agg.name).toBe('COUNT');
      expect(agg.distinct).toBe(true);
    });

    it('parses SUM, AVG, MIN, MAX', () => {
      const ast = parse('SELECT SUM(a), AVG(b), MIN(c), MAX(d) FROM t');
      const names = ast.selectItems.map(i => i.expr.name);
      expect(names).toEqual(['SUM', 'AVG', 'MIN', 'MAX']);
    });
  });

  describe('function calls', () => {
    it('parses function with no args', () => {
      const ast = parse('SELECT now()');
      expect(ast.selectItems[0].expr.kind).toBe(NodeKind.FUNCTION_CALL);
      expect(ast.selectItems[0].expr.name).toBe('now');
      expect(ast.selectItems[0].expr.args).toEqual([]);
    });

    it('parses function with multiple args', () => {
      const ast = parse('SELECT coalesce(a, b, 0)');
      const fn = ast.selectItems[0].expr;
      expect(fn.kind).toBe(NodeKind.FUNCTION_CALL);
      expect(fn.name).toBe('coalesce');
      expect(fn.args).toHaveLength(3);
    });
  });

  describe('CASE expression', () => {
    it('parses searched CASE', () => {
      const ast = parse("SELECT CASE WHEN x > 0 THEN 'pos' WHEN x < 0 THEN 'neg' ELSE 'zero' END FROM t");
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.CASE_EXPR);
      expect(expr.operand).toBeNull();
      expect(expr.whenClauses).toHaveLength(2);
      expect(expr.whenClauses[0].condition.op).toBe('>');
      expect(expr.whenClauses[0].result.value).toBe('pos');
      expect(expr.elseExpr.value).toBe('zero');
    });

    it('parses simple CASE with operand', () => {
      const ast = parse("SELECT CASE status WHEN 1 THEN 'active' WHEN 0 THEN 'inactive' END");
      const expr = ast.selectItems[0].expr;
      expect(expr.operand.name).toBe('status');
      expect(expr.whenClauses).toHaveLength(2);
    });

    it('parses CASE without ELSE', () => {
      const ast = parse("SELECT CASE WHEN x THEN 'yes' END");
      expect(ast.selectItems[0].expr.elseExpr).toBeNull();
    });
  });

  describe('CAST', () => {
    it('parses CAST with simple type', () => {
      const ast = parse('SELECT CAST(x AS INTEGER)');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.CAST_EXPR);
      expect(expr.expr.name).toBe('x');
      expect(expr.targetType.name).toBe('INTEGER');
      expect(expr.targetType.params).toEqual([]);
    });

    it('parses CAST with parameterized type', () => {
      const ast = parse('SELECT CAST(price AS DECIMAL(10, 2))');
      const expr = ast.selectItems[0].expr;
      expect(expr.targetType.name).toBe('DECIMAL');
      expect(expr.targetType.params).toEqual([10, 2]);
    });
  });

  describe('EXTRACT', () => {
    it('parses EXTRACT(field FROM source)', () => {
      const ast = parse('SELECT EXTRACT(YEAR FROM created_at)');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.EXTRACT_EXPR);
      expect(expr.field).toBe('YEAR');
      expect(expr.source.name).toBe('created_at');
    });

    it('parses EXTRACT with different fields', () => {
      for (const field of ['YEAR', 'MONTH', 'DAY']) {
        const ast = parse(`SELECT EXTRACT(${field} FROM d)`);
        expect(ast.selectItems[0].expr.field).toBe(field);
      }
    });
  });

  describe('SUBSTRING', () => {
    it('parses SUBSTRING with FROM/FOR syntax', () => {
      const ast = parse('SELECT SUBSTRING(name FROM 1 FOR 3)');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.SUBSTRING_EXPR);
      expect(expr.from.value).toBe(1);
      expect(expr.length.value).toBe(3);
    });

    it('parses SUBSTRING with FROM only', () => {
      const ast = parse('SELECT SUBSTRING(name FROM 2)');
      const expr = ast.selectItems[0].expr;
      expect(expr.from.value).toBe(2);
      expect(expr.length).toBeNull();
    });

    it('parses SUBSTRING with comma syntax', () => {
      const ast = parse('SELECT SUBSTRING(name, 1, 3)');
      const expr = ast.selectItems[0].expr;
      expect(expr.from.value).toBe(1);
      expect(expr.length.value).toBe(3);
    });

    it('parses SUBSTRING with comma syntax, no length', () => {
      const ast = parse('SELECT SUBSTRING(name, 2)');
      const expr = ast.selectItems[0].expr;
      expect(expr.from.value).toBe(2);
      expect(expr.length).toBeNull();
    });
  });

  describe('TRIM', () => {
    it('parses TRIM with default (no spec)', () => {
      const ast = parse("SELECT TRIM('  hello  ')");
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.FUNCTION_CALL);
      expect(expr.name).toBe('TRIM');
      expect(expr.args).toHaveLength(1);
    });

    it('parses TRIM with LEADING', () => {
      const ast = parse("SELECT TRIM(LEADING FROM name)");
      const expr = ast.selectItems[0].expr;
      expect(expr.name).toBe('TRIM');
    });

    it('parses TRIM with BOTH and trim char', () => {
      const ast = parse("SELECT TRIM(BOTH 'x' FROM name)");
      const expr = ast.selectItems[0].expr;
      expect(expr.name).toBe('TRIM');
      expect(expr.args).toHaveLength(3);
      expect(expr.args[1].value).toBe('BOTH');
      expect(expr.args[2].value).toBe('x');
    });
  });

  describe('INTERVAL', () => {
    it('parses INTERVAL literal', () => {
      const ast = parse("SELECT INTERVAL '1' YEAR");
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.INTERVAL_EXPR);
      expect(expr.value).toBe('1');
      expect(expr.unit).toBe('YEAR');
    });

    it('parses INTERVAL with different units', () => {
      for (const unit of ['YEAR', 'MONTH', 'DAY']) {
        const ast = parse(`SELECT INTERVAL '5' ${unit}`);
        expect(ast.selectItems[0].expr.unit).toBe(unit);
      }
    });
  });

  describe('subqueries', () => {
    it('parses scalar subquery in SELECT', () => {
      const ast = parse('SELECT (SELECT MAX(id) FROM t)');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.SUBQUERY_EXPR);
      expect(expr.query.kind).toBe(NodeKind.SELECT_STMT);
    });

    it('parses subquery in FROM', () => {
      const ast = parse('SELECT s.x FROM (SELECT 1 AS x) AS s');
      expect(ast.from.kind).toBe(NodeKind.SUBQUERY_REF);
      expect(ast.from.alias).toBe('s');
    });

    it('parses correlated subquery in WHERE', () => {
      const ast = parse('SELECT * FROM t1 WHERE t1.x > (SELECT AVG(x) FROM t2 WHERE t2.id = t1.id)');
      expect(ast.where.right.kind).toBe(NodeKind.SUBQUERY_EXPR);
    });
  });

  describe('WITH (CTE)', () => {
    it('parses single CTE', () => {
      const ast = parse('WITH active AS (SELECT * FROM users WHERE active = TRUE) SELECT * FROM active');
      expect(ast.withClause.kind).toBe(NodeKind.WITH_CLAUSE);
      expect(ast.withClause.ctes).toHaveLength(1);
      expect(ast.withClause.ctes[0].name).toBe('active');
    });

    it('parses multiple CTEs', () => {
      const ast = parse(`
        WITH
          a AS (SELECT 1 AS x),
          b AS (SELECT 2 AS y)
        SELECT * FROM a, b
      `);
      expect(ast.withClause.ctes).toHaveLength(2);
      expect(ast.withClause.ctes[0].name).toBe('a');
      expect(ast.withClause.ctes[1].name).toBe('b');
    });

    it('parses CTE with column aliases', () => {
      const ast = parse('WITH totals(dept, total) AS (SELECT dept, SUM(sal) FROM emp GROUP BY dept) SELECT * FROM totals');
      const cte = ast.withClause.ctes[0];
      expect(cte.columnAliases).toEqual(['dept', 'total']);
    });

    it('attaches the WITH clause to a parenthesized SELECT body (does not drop it)', () => {
      const ast = parse('WITH c AS (SELECT 1 AS x) (SELECT * FROM c)');
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.withClause).not.toBeNull();
      expect(ast.withClause.ctes[0].name).toBe('c');
    });

    it('attaches the WITH clause to a parenthesized FROM-first body', () => {
      const ast = parse('WITH c AS (SELECT 1 AS x) (FROM c)');
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.withClause).not.toBeNull();
      expect(ast.withClause.ctes[0].name).toBe('c');
    });

    it('rejects a WITH clause before a parenthesized set operation', () => {
      expect(() => parse('WITH c AS (SELECT 1) (SELECT 1 UNION SELECT 2)')).toThrow(/set operation/);
    });
  });

  describe('set operations', () => {
    it('parses UNION', () => {
      const ast = parse('SELECT a FROM t1 UNION SELECT b FROM t2');
      expect(ast.kind).toBe(NodeKind.SET_OP);
      expect(ast.op).toBe('UNION');
      expect(ast.all).toBe(false);
    });

    it('parses UNION ALL', () => {
      const ast = parse('SELECT a FROM t1 UNION ALL SELECT b FROM t2');
      expect(ast.kind).toBe(NodeKind.SET_OP);
      expect(ast.all).toBe(true);
    });

    it('parses EXCEPT', () => {
      const ast = parse('SELECT a FROM t1 EXCEPT SELECT b FROM t2');
      expect(ast.op).toBe('EXCEPT');
    });

    it('parses INTERSECT', () => {
      const ast = parse('SELECT a FROM t1 INTERSECT SELECT b FROM t2');
      expect(ast.op).toBe('INTERSECT');
    });

    it('chains set operations left-to-right', () => {
      const ast = parse('SELECT 1 UNION SELECT 2 UNION SELECT 3');
      expect(ast.kind).toBe(NodeKind.SET_OP);
      expect(ast.left.kind).toBe(NodeKind.SET_OP);
      expect(ast.left.left.kind).toBe(NodeKind.SELECT_STMT);
    });
  });

  describe('EXPLAIN', () => {
    it('wraps query in ExplainStmt', () => {
      const ast = parse('EXPLAIN SELECT * FROM t');
      expect(ast.kind).toBe(NodeKind.EXPLAIN_STMT);
      expect(ast.query.kind).toBe(NodeKind.SELECT_STMT);
    });
  });

  describe('quantified comparison', () => {
    it('parses = ANY (subquery)', () => {
      const ast = parse('SELECT * FROM t WHERE x = ANY (SELECT id FROM other)');
      expect(ast.where.op).toBe('=');
      expect(ast.where.right.kind).toBe('QuantifiedSubquery');
      expect(ast.where.right.quantifier).toBe('ANY');
    });

    it('parses > ALL (subquery)', () => {
      const ast = parse('SELECT * FROM t WHERE x > ALL (SELECT val FROM other)');
      expect(ast.where.right.quantifier).toBe('ALL');
    });

    it('parses < SOME (subquery)', () => {
      const ast = parse('SELECT * FROM t WHERE x < SOME (SELECT val FROM other)');
      expect(ast.where.right.quantifier).toBe('SOME');
    });
  });

  describe('parameter markers', () => {
    it('parses :N parameter syntax', () => {
      const ast = parse('SELECT * FROM t WHERE id = :1');
      expect(ast.where.right.kind).toBe(NodeKind.PARAMETER);
      expect(ast.where.right.index).toBe(1);
    });

    it('parses $N placeholder syntax', () => {
      const ast = parse('SELECT * FROM t WHERE id = $2');
      expect(ast.where.right.kind).toBe(NodeKind.PARAMETER);
      expect(ast.where.right.index).toBe(2);
    });
  });

  describe('qualified column references', () => {
    it('parses table.column', () => {
      const ast = parse('SELECT t.name FROM t');
      expect(ast.selectItems[0].expr.kind).toBe(NodeKind.COLUMN_REF);
      expect(ast.selectItems[0].expr.table).toBe('t');
      expect(ast.selectItems[0].expr.name).toBe('name');
    });
  });

  describe('parenthesized query in FROM', () => {
    it('parses (query) without subquery ref', () => {
      const ast = parse('SELECT * FROM (SELECT 1 UNION SELECT 2) AS u');
      expect(ast.from.kind).toBe(NodeKind.SUBQUERY_REF);
    });
  });

  describe('error handling', () => {
    it('throws on missing FROM table', () => {
      expect(() => parse('SELECT * FROM')).toThrow(/Parse error/);
    });

    it('treats trailing identifier as alias, not error', () => {
      const ast = parse('SELECT 1 result');
      expect(ast.selectItems[0].alias).toBe('result');
    });

    it('throws on missing closing paren', () => {
      expect(() => parse('SELECT (1 + 2')).toThrow(/Expected RPAREN/);
    });

    it('throws on empty SELECT items', () => {
      expect(() => parse('SELECT FROM t')).toThrow(/Parse error/);
    });
  });

  describe('complex queries', () => {
    it('parses a multi-join query with aggregation', () => {
      const ast = parse(`
        SELECT d.name, COUNT(*) AS emp_count, AVG(e.salary) AS avg_sal
        FROM departments d
        INNER JOIN employees e ON d.id = e.dept_id
        LEFT JOIN locations l ON d.loc_id = l.id
        WHERE e.active = TRUE
        GROUP BY d.name
        HAVING COUNT(*) > 10
        ORDER BY avg_sal DESC
        LIMIT 5
      `);
      expect(ast.kind).toBe(NodeKind.SELECT_STMT);
      expect(ast.selectItems).toHaveLength(3);
      expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.joinType).toBe('LEFT');
      expect(ast.from.left.joinType).toBe('INNER');
      expect(ast.where.op).toBe('=');
      expect(ast.groupBy).toHaveLength(1);
      expect(ast.having.op).toBe('>');
      expect(ast.orderBy[0].direction).toBe('DESC');
      expect(ast.limit.value).toBe(5);
    });

    it('parses CTE with UNION and subquery', () => {
      const ast = parse(`
        WITH base AS (
          SELECT id, name FROM users WHERE active = TRUE
          UNION ALL
          SELECT id, name FROM admins
        )
        SELECT b.name, COUNT(*)
        FROM base b
        JOIN orders o ON b.id = o.user_id
        WHERE o.total > (SELECT AVG(total) FROM orders)
        GROUP BY b.name
        ORDER BY COUNT(*) DESC
      `);
      expect(ast.withClause.ctes[0].query.kind).toBe(NodeKind.SET_OP);
      expect(ast.where.right.kind).toBe(NodeKind.SUBQUERY_EXPR);
    });

    it('parses nested CASE with function calls', () => {
      const ast = parse(`
        SELECT
          CASE
            WHEN age < 18 THEN 'minor'
            WHEN age BETWEEN 18 AND 65 THEN 'adult'
            ELSE 'senior'
          END AS category,
          COALESCE(nickname, name) AS display_name
        FROM people
      `);
      const caseExpr = ast.selectItems[0].expr;
      expect(caseExpr.whenClauses[1].condition.kind).toBe(NodeKind.BETWEEN_EXPR);
      const coalesce = ast.selectItems[1].expr;
      expect(coalesce.kind).toBe(NodeKind.FUNCTION_CALL);
      expect(coalesce.args).toHaveLength(2);
    });
  });

  describe('DDL statements', () => {
    it('parses CREATE TABLE with columns', () => {
      const ast = parse('CREATE TABLE users (id INTEGER, name VARCHAR, active BOOLEAN)');
      expect(ast.kind).toBe(NodeKind.CREATE_TABLE_STMT);
      expect(ast.name).toBe('users');
      expect(ast.columns).toHaveLength(3);
      expect(ast.columns[0].name).toBe('id');
      expect(ast.columns[0].typeName.name).toBe('INTEGER');
      expect(ast.ifNotExists).toBe(false);
    });

    it('parses CREATE TABLE IF NOT EXISTS', () => {
      const ast = parse('CREATE TABLE IF NOT EXISTS users (id INT)');
      expect(ast.ifNotExists).toBe(true);
    });

    it('parses DROP TABLE', () => {
      const ast = parse('DROP TABLE users');
      expect(ast.kind).toBe(NodeKind.DROP_TABLE_STMT);
      expect(ast.name).toBe('users');
      expect(ast.ifExists).toBe(false);
    });

    it('parses DROP TABLE IF EXISTS', () => {
      const ast = parse('DROP TABLE IF EXISTS users');
      expect(ast.ifExists).toBe(true);
    });
  });

  describe('TIMESTAMP literal', () => {
    it('parses TIMESTAMP literal', () => {
      const ast = parse("SELECT TIMESTAMP '2024-06-15 10:30:45'");
      const expr = ast.selectItems[0].expr;
      expect(expr.value).toBe('2024-06-15 10:30:45');
      expect(expr.dataType).toBe('TIMESTAMP');
    });
  });

  describe('EXPLAIN ANALYZE', () => {
    it('parses EXPLAIN ANALYZE SELECT', () => {
      const ast = parse('EXPLAIN ANALYZE SELECT 1');
      expect(ast.kind).toBe(NodeKind.EXPLAIN_ANALYZE_STMT);
      expect(ast.query.kind).toBe(NodeKind.SELECT_STMT);
    });

    it('EXPLAIN without ANALYZE still works', () => {
      const ast = parse('EXPLAIN SELECT 1');
      expect(ast.kind).toBe(NodeKind.EXPLAIN_STMT);
    });
  });

  describe('NATURAL JOIN / USING', () => {
    it('parses NATURAL JOIN', () => {
      const ast = parse('SELECT * FROM users NATURAL JOIN profiles');
      expect(ast.from.kind).toBe(NodeKind.JOIN_REF);
      expect(ast.from.natural).toBe(true);
      expect(ast.from.joinType).toBe('INNER');
    });

    it('parses NATURAL LEFT JOIN', () => {
      const ast = parse('SELECT * FROM users NATURAL LEFT JOIN profiles');
      expect(ast.from.natural).toBe(true);
      expect(ast.from.joinType).toBe('LEFT');
    });

    it('parses JOIN ... USING (col)', () => {
      const ast = parse('SELECT * FROM users JOIN profiles USING (id)');
      expect(ast.from.usingColumns).toEqual(['id']);
    });

    it('parses JOIN ... USING (col1, col2)', () => {
      const ast = parse('SELECT * FROM a JOIN b USING (x, y)');
      expect(ast.from.usingColumns).toEqual(['x', 'y']);
    });
  });

  describe('window functions', () => {
    it('parses ROW_NUMBER() OVER (ORDER BY ...)', () => {
      const ast = parse('SELECT ROW_NUMBER() OVER (ORDER BY id) FROM t');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.WINDOW_CALL);
      expect(expr.name).toBe('ROW_NUMBER');
      expect(expr.windowSpec.orderBy).toHaveLength(1);
    });

    it('parses RANK() OVER (PARTITION BY dept ORDER BY salary DESC)', () => {
      const ast = parse('SELECT RANK() OVER (PARTITION BY dept ORDER BY salary DESC) FROM t');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.WINDOW_CALL);
      expect(expr.name).toBe('RANK');
      expect(expr.windowSpec.partitionBy).toHaveLength(1);
      expect(expr.windowSpec.orderBy[0].direction).toBe('DESC');
    });

    it('parses LAG(col, 1) OVER (...)', () => {
      const ast = parse('SELECT LAG(salary, 1) OVER (ORDER BY id) FROM t');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.WINDOW_CALL);
      expect(expr.name).toBe('LAG');
      expect(expr.args).toHaveLength(2);
    });

    it('parses aggregate as window function: SUM(x) OVER (...)', () => {
      const ast = parse('SELECT SUM(salary) OVER (PARTITION BY dept ORDER BY id) FROM t');
      const expr = ast.selectItems[0].expr;
      expect(expr.kind).toBe(NodeKind.WINDOW_CALL);
      expect(expr.name).toBe('SUM');
    });
  });
});
