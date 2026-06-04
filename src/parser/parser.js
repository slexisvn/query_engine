import { Lexer, TokenType } from './lexer.js';
import * as AST from './ast.js';

export class Parser {
  constructor(sql) {
    const lexer = new Lexer(sql);
    this.tokens = lexer.tokens;
    this.pos = 0;
  }

  parse() {
    let isExplain = false;
    if (this.isAt(TokenType.EXPLAIN)) {
      this.advance();
      isExplain = true;
    }

    const stmt = this.parseQueryExpr();
    if (!this.isAt(TokenType.EOF) && !this.isAt(TokenType.SEMICOLON)) {
      this.error(`Unexpected token ${this.peek().type}`);
    }

    return isExplain ? AST.ExplainStmt(stmt) : stmt;
  }

  parseQueryExpr() {
    let left = this.parseSelectStmt();

    while (this.isAt(TokenType.UNION) || this.isAt(TokenType.EXCEPT) || this.isAt(TokenType.INTERSECT)) {
      const op = this.advance().type;
      const all = this.tryConsume(TokenType.ALL);
      if (!all) this.tryConsume(TokenType.DISTINCT);
      const right = this.parseSelectStmt();
      left = AST.SetOp(op, left, right, all);
    }

    return left;
  }

  parseSelectStmt() {
    let withClause = null;
    if (this.isAt(TokenType.WITH)) {
      withClause = this.parseWithClause();
    }

    if (this.isAt(TokenType.LPAREN)) {
      this.advance();
      const inner = this.parseQueryExpr();
      this.expect(TokenType.RPAREN);
      return inner;
    }

    this.expect(TokenType.SELECT);

    const distinct = this.tryConsume(TokenType.DISTINCT);
    if (!distinct) this.tryConsume(TokenType.ALL);

    const selectItems = this.parseSelectItems();

    let from = null;
    if (this.tryConsume(TokenType.FROM)) {
      from = this.parseFromClause();
    }

    let where = null;
    if (this.tryConsume(TokenType.WHERE)) {
      where = this.parseExpression();
    }

    let groupBy = null;
    if (this.tryConsume(TokenType.GROUP)) {
      this.expect(TokenType.BY);
      groupBy = this.parseExpressionList();
    }

    let having = null;
    if (this.tryConsume(TokenType.HAVING)) {
      having = this.parseExpression();
    }

    let orderBy = null;
    if (this.isAt(TokenType.ORDER)) {
      this.advance();
      this.expect(TokenType.BY);
      orderBy = this.parseOrderByList();
    }

    let limit = null;
    let offset = null;

    if (this.tryConsume(TokenType.LIMIT)) {
      limit = this.parseExpression();
      if (this.tryConsume(TokenType.OFFSET)) {
        offset = this.parseExpression();
      }
    }

    if (this.tryConsume(TokenType.FETCH)) {
      if (!this.tryConsume(TokenType.FIRST)) {
        this.tryConsume(TokenType.NEXT);
      }
      limit = this.parseExpression();
      this.tryConsume(TokenType.ROWS);
      this.expect(TokenType.ONLY);
    }

    return AST.SelectStmt({ withClause, distinct: !!distinct, selectItems, from, where, groupBy, having, orderBy, limit, offset });
  }

  parseWithClause() {
    this.advance();
    const ctes = [];
    do {
      ctes.push(this.parseCTE());
    } while (this.tryConsume(TokenType.COMMA));
    return AST.WithClause(ctes);
  }

  parseCTE() {
    const name = this.expectIdent();
    let columnAliases = null;
    if (this.isAt(TokenType.LPAREN) && !this.isLookaheadSelect()) {
      this.advance();
      columnAliases = [];
      do {
        columnAliases.push(this.expectIdent());
      } while (this.tryConsume(TokenType.COMMA));
      this.expect(TokenType.RPAREN);
    }
    this.expect(TokenType.AS);
    this.expect(TokenType.LPAREN);
    const query = this.parseQueryExpr();
    this.expect(TokenType.RPAREN);
    return AST.CTE(name, query, columnAliases);
  }

  parseSelectItems() {
    const items = [];
    do {
      items.push(this.parseSelectItem());
    } while (this.tryConsume(TokenType.COMMA));
    return items;
  }

  parseSelectItem() {
    if (this.isAt(TokenType.STAR)) {
      this.advance();
      return AST.SelectItem(AST.AllColumns());
    }

    if (this.isAt(TokenType.IDENT) && this.peekAhead(1)?.type === TokenType.DOT && this.peekAhead(2)?.type === TokenType.STAR) {
      const table = this.advance().value;
      this.advance();
      this.advance();
      return AST.SelectItem(AST.AllColumns(table));
    }

    const expr = this.parseExpression();
    let alias = null;
    if (this.tryConsume(TokenType.AS)) {
      alias = this.expectIdent();
    } else if (this.isAt(TokenType.IDENT)) {
      alias = this.expectIdent();
    }
    return AST.SelectItem(expr, alias);
  }

  parseFromClause() {
    let left = this.parseTableRef();

    while (this.isJoinKeyword()) {
      left = this.parseJoin(left);
    }

    while (this.tryConsume(TokenType.COMMA)) {
      const right = this.parseTableRef();
      left = AST.JoinRef(left, right, 'CROSS');
    }

    return left;
  }

  parseTableRef() {
    if (this.isAt(TokenType.LPAREN)) {
      if (this.isSubqueryStart()) {
        return this.parseSubqueryRef();
      }
      this.advance();
      const inner = this.parseFromClause();
      this.expect(TokenType.RPAREN);
      return inner;
    }

    const name = this.expectIdent();
    let alias = name;
    if (this.tryConsume(TokenType.AS)) {
      alias = this.expectIdent();
    } else if (this.isAt(TokenType.IDENT) && !this.isJoinKeyword() && !this.isClauseKeyword()) {
      alias = this.expectIdent();
    }
    return AST.TableRef(name, alias);
  }

  parseSubqueryRef() {
    this.expect(TokenType.LPAREN);
    const query = this.parseQueryExpr();
    this.expect(TokenType.RPAREN);
    let alias = null;
    if (this.tryConsume(TokenType.AS)) {
      alias = this.expectIdent();
    } else if (this.isAt(TokenType.IDENT)) {
      alias = this.expectIdent();
    }
    return AST.SubqueryRef(query, alias);
  }

  parseJoin(left) {
    let joinType = 'INNER';

    if (this.tryConsume(TokenType.LEFT)) {
      this.tryConsume(TokenType.OUTER);
      joinType = 'LEFT';
    } else if (this.tryConsume(TokenType.RIGHT)) {
      this.tryConsume(TokenType.OUTER);
      joinType = 'RIGHT';
    } else if (this.tryConsume(TokenType.FULL)) {
      this.tryConsume(TokenType.OUTER);
      joinType = 'FULL';
    } else if (this.tryConsume(TokenType.CROSS)) {
      joinType = 'CROSS';
    } else if (this.tryConsume(TokenType.INNER)) {
      joinType = 'INNER';
    }

    this.expect(TokenType.JOIN);
    const right = this.parseTableRef();

    let condition = null;
    if (joinType !== 'CROSS' && this.tryConsume(TokenType.ON)) {
      condition = this.parseExpression();
    }

    return AST.JoinRef(left, right, joinType, condition);
  }

  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isAt(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = AST.BinaryExpr('OR', left, right);
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isAt(TokenType.AND)) {
      this.advance();
      const right = this.parseNot();
      left = AST.BinaryExpr('AND', left, right);
    }
    return left;
  }

  parseNot() {
    if (this.isAt(TokenType.NOT)) {
      this.advance();
      const operand = this.parseNot();
      return AST.UnaryExpr('NOT', operand);
    }
    return this.parseComparison();
  }

  parseComparison() {
    if (this.isAt(TokenType.EXISTS)) {
      return this.parseExists();
    }

    let left = this.parseAddition();

    if (this.isAt(TokenType.NOT)) {
      const saved = this.pos;
      this.advance();
      if (this.isAt(TokenType.BETWEEN)) {
        return this.parseBetween(left, true);
      } else if (this.isAt(TokenType.IN)) {
        return this.parseIn(left, true);
      } else if (this.isAt(TokenType.LIKE)) {
        return this.parseLike(left, true);
      }
      this.pos = saved;
    }

    if (this.isAt(TokenType.BETWEEN)) return this.parseBetween(left, false);
    if (this.isAt(TokenType.IN)) return this.parseIn(left, false);
    if (this.isAt(TokenType.LIKE)) return this.parseLike(left, false);

    if (this.isAt(TokenType.IS)) {
      this.advance();
      const negated = this.tryConsume(TokenType.NOT);
      this.expect(TokenType.NULL);
      return AST.IsNullExpr(left, !!negated);
    }

    const opMap = {
      [TokenType.EQ]: '=',
      [TokenType.NEQ]: '<>',
      [TokenType.LT]: '<',
      [TokenType.GT]: '>',
      [TokenType.LTE]: '<=',
      [TokenType.GTE]: '>=',
    };

    if (opMap[this.peek().type]) {
      const op = opMap[this.advance().type];
      if (this.isAt(TokenType.ALL) || this.isAt(TokenType.SOME) || this.isAt(TokenType.ANY)) {
        const quantifier = this.advance().type;
        this.expect(TokenType.LPAREN);
        const query = this.parseQueryExpr();
        this.expect(TokenType.RPAREN);
        return AST.BinaryExpr(op, left, { kind: 'QuantifiedSubquery', quantifier, query });
      }
      const right = this.parseAddition();
      return AST.BinaryExpr(op, left, right);
    }

    return left;
  }

  parseBetween(left, negated) {
    this.advance();
    const low = this.parseAddition();
    this.expect(TokenType.AND);
    const high = this.parseAddition();
    return AST.BetweenExpr(left, low, high, negated);
  }

  parseIn(left, negated) {
    this.advance();
    this.expect(TokenType.LPAREN);

    if (this.isAt(TokenType.SELECT) || this.isAt(TokenType.WITH)) {
      const query = this.parseQueryExpr();
      this.expect(TokenType.RPAREN);
      return AST.InExpr(left, AST.SubqueryExpr(query), negated);
    }

    const list = this.parseExpressionList();
    this.expect(TokenType.RPAREN);
    return AST.InExpr(left, list, negated);
  }

  parseLike(left, negated) {
    this.advance();
    const pattern = this.parseAddition();
    return AST.LikeExpr(left, pattern, negated);
  }

  parseExists() {
    this.advance();
    this.expect(TokenType.LPAREN);
    const query = this.parseQueryExpr();
    this.expect(TokenType.RPAREN);
    return AST.ExistsExpr(query, false);
  }

  parseAddition() {
    let left = this.parseMultiplication();
    while (this.isAt(TokenType.PLUS) || this.isAt(TokenType.MINUS) || this.isAt(TokenType.CONCAT)) {
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = AST.BinaryExpr(op, left, right);
    }
    return left;
  }

  parseMultiplication() {
    let left = this.parseUnary();
    while (this.isAt(TokenType.STAR) || this.isAt(TokenType.SLASH) || this.isAt(TokenType.PERCENT)) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = AST.BinaryExpr(op, left, right);
    }
    return left;
  }

  parseUnary() {
    if (this.isAt(TokenType.MINUS)) {
      this.advance();
      const operand = this.parseUnary();
      return AST.UnaryExpr('-', operand);
    }
    if (this.isAt(TokenType.PLUS)) {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();

    if (token.type === TokenType.NUMBER) {
      this.advance();
      return AST.Literal(token.value.includes('.') ? parseFloat(token.value) : parseInt(token.value, 10));
    }

    if (token.type === TokenType.STRING) {
      this.advance();
      return AST.Literal(token.value, 'VARCHAR');
    }

    if (token.type === TokenType.NULL) {
      this.advance();
      return AST.Literal(null);
    }

    if (token.type === TokenType.TRUE) {
      this.advance();
      return AST.Literal(true, 'BOOLEAN');
    }

    if (token.type === TokenType.FALSE) {
      this.advance();
      return AST.Literal(false, 'BOOLEAN');
    }

    if (token.type === TokenType.DATE) {
      this.advance();
      const dateStr = this.expect(TokenType.STRING);
      return AST.Literal(dateStr.value, 'DATE');
    }

    if (token.type === TokenType.INTERVAL) {
      return this.parseInterval();
    }

    if (token.type === TokenType.CASE) {
      return this.parseCaseExpr();
    }

    if (token.type === TokenType.CAST) {
      return this.parseCast();
    }

    if (token.type === TokenType.EXTRACT) {
      return this.parseExtract();
    }

    if (token.type === TokenType.SUBSTRING) {
      return this.parseSubstringFn();
    }

    if (token.type === TokenType.TRIM) {
      return this.parseTrim();
    }

    if (token.type === TokenType.EXISTS) {
      return this.parseExists();
    }

    if (token.type === TokenType.NOT) {
      this.advance();
      if (this.isAt(TokenType.EXISTS)) {
        this.advance();
        this.expect(TokenType.LPAREN);
        const query = this.parseQueryExpr();
        this.expect(TokenType.RPAREN);
        return AST.ExistsExpr(query, true);
      }
      const operand = this.parsePrimary();
      return AST.UnaryExpr('NOT', operand);
    }

    if (token.type === TokenType.LPAREN) {
      if (this.isSubqueryStart()) {
        this.advance();
        const query = this.parseQueryExpr();
        this.expect(TokenType.RPAREN);
        return AST.SubqueryExpr(query);
      }
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return expr;
    }

    if (token.type === TokenType.STAR) {
      this.advance();
      return AST.AllColumns();
    }

    if (this.isAggregateKeyword(token.type)) {
      return this.parseAggregateCall();
    }

    if (token.type === TokenType.COLON) {
      this.advance();
      const paramToken = this.expect(TokenType.NUMBER);
      return AST.Literal(`:${paramToken.value}`, 'PARAM');
    }

    if (token.type === TokenType.IDENT) {
      const name = this.advance().value;

      if (this.isAt(TokenType.LPAREN)) {
        return this.parseFunctionCallNamed(name);
      }

      if (this.isAt(TokenType.DOT)) {
        this.advance();
        if (this.isAt(TokenType.STAR)) {
          this.advance();
          return AST.AllColumns(name);
        }
        const colName = this.expectIdent();
        return AST.ColumnRef(colName, name);
      }

      return AST.ColumnRef(name);
    }

    this.error(`Unexpected token ${token.type} (${token.value})`);
  }

  parseAggregateCall() {
    const name = this.advance().value;
    this.expect(TokenType.LPAREN);

    if (name === 'COUNT' && this.isAt(TokenType.STAR)) {
      this.advance();
      this.expect(TokenType.RPAREN);
      return AST.AggregateCall('COUNT_STAR', [], false);
    }

    const distinct = this.tryConsume(TokenType.DISTINCT);
    const args = this.parseExpressionList();
    this.expect(TokenType.RPAREN);
    return AST.AggregateCall(name, args, !!distinct);
  }

  parseFunctionCallNamed(name) {
    this.expect(TokenType.LPAREN);
    if (this.isAt(TokenType.RPAREN)) {
      this.advance();
      return AST.FunctionCall(name, []);
    }
    const args = this.parseExpressionList();
    this.expect(TokenType.RPAREN);
    return AST.FunctionCall(name, args);
  }

  parseCaseExpr() {
    this.advance();
    let operand = null;

    if (!this.isAt(TokenType.WHEN)) {
      operand = this.parseExpression();
    }

    const whenClauses = [];
    while (this.tryConsume(TokenType.WHEN)) {
      const condition = this.parseExpression();
      this.expect(TokenType.THEN);
      const result = this.parseExpression();
      whenClauses.push(AST.WhenClause(condition, result));
    }

    let elseExpr = null;
    if (this.tryConsume(TokenType.ELSE)) {
      elseExpr = this.parseExpression();
    }

    this.expect(TokenType.END);
    return AST.CaseExpr(operand, whenClauses, elseExpr);
  }

  parseCast() {
    this.advance();
    this.expect(TokenType.LPAREN);
    const expr = this.parseExpression();
    this.expect(TokenType.AS);
    const targetType = this.parseTypeName();
    this.expect(TokenType.RPAREN);
    return AST.CastExpr(expr, targetType);
  }

  parseExtract() {
    this.advance();
    this.expect(TokenType.LPAREN);
    const field = this.peek().value;
    this.advance();
    this.expect(TokenType.FROM);
    const source = this.parseExpression();
    this.expect(TokenType.RPAREN);
    return AST.ExtractExpr(field.toUpperCase(), source);
  }

  parseSubstringFn() {
    this.advance();
    this.expect(TokenType.LPAREN);
    const expr = this.parseExpression();

    let from, length = null;
    if (this.isAtKeyword('FROM')) {
      this.advance();
      from = this.parseExpression();
      if (this.isAtKeyword('FOR')) {
        this.advance();
        length = this.parseExpression();
      }
    } else {
      this.expect(TokenType.COMMA);
      from = this.parseExpression();
      if (this.tryConsume(TokenType.COMMA)) {
        length = this.parseExpression();
      }
    }

    this.expect(TokenType.RPAREN);
    return AST.SubstringExpr(expr, from, length);
  }

  parseTrim() {
    this.advance();
    this.expect(TokenType.LPAREN);

    let trimSpec = null;
    if (this.isAt(TokenType.LEADING) || this.isAt(TokenType.TRAILING) || this.isAt(TokenType.BOTH)) {
      trimSpec = this.advance().value;
    }

    let trimChar = null;
    if (!this.isAt(TokenType.FROM) && trimSpec !== null) {
      if (!this.isAt(TokenType.FROM)) {
        trimChar = this.parseExpression();
      }
    }

    if (trimSpec !== null) {
      this.tryConsume(TokenType.FROM);
    }

    const expr = this.parseExpression();
    this.expect(TokenType.RPAREN);

    const args = trimChar ? [expr, AST.Literal(trimSpec), trimChar] : [expr];
    return AST.FunctionCall('TRIM', args);
  }

  parseInterval() {
    this.advance();
    const valueToken = this.expect(TokenType.STRING);
    const unit = this.expectIdent().toUpperCase();
    return AST.IntervalExpr(valueToken.value, unit);
  }

  parseTypeName() {
    const name = this.expectIdent().toUpperCase();
    const params = [];
    if (this.tryConsume(TokenType.LPAREN)) {
      do {
        params.push(parseInt(this.expect(TokenType.NUMBER).value, 10));
      } while (this.tryConsume(TokenType.COMMA));
      this.expect(TokenType.RPAREN);
    }
    return AST.TypeName(name, params);
  }

  parseExpressionList() {
    const list = [];
    do {
      list.push(this.parseExpression());
    } while (this.tryConsume(TokenType.COMMA));
    return list;
  }

  parseOrderByList() {
    const list = [];
    do {
      const expr = this.parseExpression();
      let direction = 'ASC';
      if (this.tryConsume(TokenType.ASC)) direction = 'ASC';
      else if (this.tryConsume(TokenType.DESC)) direction = 'DESC';

      let nullOrder = null;
      if (this.tryConsume(TokenType.NULLS)) {
        if (this.tryConsume(TokenType.FIRST)) nullOrder = 'FIRST';
        else if (this.tryConsume(TokenType.LAST)) nullOrder = 'LAST';
      }

      list.push(AST.OrderKey(expr, direction, nullOrder));
    } while (this.tryConsume(TokenType.COMMA));
    return list;
  }

  peek() {
    return this.tokens[this.pos];
  }

  peekAhead(offset) {
    return this.tokens[this.pos + offset] || null;
  }

  advance() {
    return this.tokens[this.pos++];
  }

  isAt(type) {
    return this.peek().type === type;
  }

  tryConsume(type) {
    if (this.isAt(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  expect(type) {
    if (!this.isAt(type)) {
      this.error(`Expected ${type}, got ${this.peek().type} (${this.peek().value})`);
    }
    return this.advance();
  }

  expectIdent() {
    const token = this.peek();
    if (token.type === TokenType.IDENT) {
      this.advance();
      return token.value;
    }
    if (this.isNonReservedKeyword(token.type)) {
      this.advance();
      return token.value;
    }
    this.error(`Expected identifier, got ${token.type} (${token.value})`);
  }

  isNonReservedKeyword(type) {
    return [
      TokenType.YEAR, TokenType.MONTH, TokenType.DAY, TokenType.DATE,
      TokenType.FIRST, TokenType.LAST, TokenType.NULLS, TokenType.VIEW,
      TokenType.ROWS, TokenType.ONLY, TokenType.NEXT, TokenType.FETCH,
      TokenType.SOME, TokenType.ANY, TokenType.LEADING, TokenType.TRAILING,
      TokenType.BOTH, TokenType.SUM, TokenType.AVG, TokenType.COUNT,
      TokenType.MIN, TokenType.MAX, TokenType.SUBSTRING, TokenType.EXTRACT,
      TokenType.TRIM, TokenType.OFFSET, TokenType.FOR, TokenType.ASC,
      TokenType.DESC, TokenType.LEFT, TokenType.RIGHT, TokenType.FULL,
      TokenType.INNER, TokenType.OUTER, TokenType.CROSS, TokenType.JOIN,
      TokenType.CREATE, TokenType.INTERVAL, TokenType.UNION, TokenType.ALL,
    ].includes(type);
  }

  isAggregateKeyword(type) {
    return [TokenType.SUM, TokenType.AVG, TokenType.COUNT, TokenType.MIN, TokenType.MAX].includes(type);
  }

  isJoinKeyword() {
    const type = this.peek().type;
    return type === TokenType.JOIN || type === TokenType.INNER || type === TokenType.LEFT
      || type === TokenType.RIGHT || type === TokenType.FULL || type === TokenType.CROSS;
  }

  isClauseKeyword() {
    const type = this.peek().type;
    return type === TokenType.WHERE || type === TokenType.GROUP || type === TokenType.HAVING
      || type === TokenType.ORDER || type === TokenType.LIMIT || type === TokenType.UNION
      || type === TokenType.EXCEPT || type === TokenType.INTERSECT || type === TokenType.ON
      || type === TokenType.FETCH;
  }

  isSubqueryStart() {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      if (this.tokens[i].type === TokenType.LPAREN) depth++;
      if (this.tokens[i].type === TokenType.RPAREN) depth--;
      if (depth === 0 && i > this.pos) break;
      if (depth === 1 && (this.tokens[i].type === TokenType.SELECT || this.tokens[i].type === TokenType.WITH)) {
        return true;
      }
    }
    return false;
  }

  isLookaheadSelect() {
    let depth = 1;
    for (let i = this.pos + 1; i < this.tokens.length; i++) {
      if (this.tokens[i].type === TokenType.LPAREN) depth++;
      if (this.tokens[i].type === TokenType.RPAREN) {
        depth--;
        if (depth === 0) break;
      }
      if (depth === 1 && this.tokens[i].type === TokenType.SELECT) return true;
    }
    return false;
  }

  isAtKeyword(keyword) {
    const t = this.peek();
    const upper = keyword.toUpperCase();
    return t.type === upper || t.value === upper;
  }

  error(message) {
    const token = this.peek();
    throw new Error(`Parse error at position ${token.position}: ${message}`);
  }
}

export function parse(sql) {
  return new Parser(sql).parse();
}
