export enum TokenType {
  IDENT = 'IDENT',
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  COMMA = 'COMMA',
  DOT = 'DOT',
  STAR = 'STAR',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  EQ = 'EQ',
  NEQ = 'NEQ',
  LT = 'LT',
  GT = 'GT',
  LTE = 'LTE',
  GTE = 'GTE',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  SLASH = 'SLASH',
  PERCENT = 'PERCENT',
  SEMICOLON = 'SEMICOLON',
  CONCAT = 'CONCAT',
  COLON = 'COLON',
  PLACEHOLDER = 'PLACEHOLDER',
  EOF = 'EOF',
  EXPLAIN = 'EXPLAIN',

  SELECT = 'SELECT',
  FROM = 'FROM',
  WHERE = 'WHERE',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  AS = 'AS',
  ON = 'ON',
  JOIN = 'JOIN',
  INNER = 'INNER',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  FULL = 'FULL',
  OUTER = 'OUTER',
  CROSS = 'CROSS',
  IN = 'IN',
  EXISTS = 'EXISTS',
  BETWEEN = 'BETWEEN',
  LIKE = 'LIKE',
  IS = 'IS',
  NULL = 'NULL',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  CASE = 'CASE',
  WHEN = 'WHEN',
  THEN = 'THEN',
  ELSE = 'ELSE',
  END = 'END',
  DISTINCT = 'DISTINCT',
  ALL = 'ALL',
  GROUP = 'GROUP',
  BY = 'BY',
  HAVING = 'HAVING',
  ORDER = 'ORDER',
  ASC = 'ASC',
  DESC = 'DESC',
  LIMIT = 'LIMIT',
  OFFSET = 'OFFSET',
  UNION = 'UNION',
  EXCEPT = 'EXCEPT',
  INTERSECT = 'INTERSECT',
  WITH = 'WITH',
  CAST = 'CAST',
  INTERVAL = 'INTERVAL',
  EXTRACT = 'EXTRACT',
  SUBSTRING = 'SUBSTRING',
  TRIM = 'TRIM',
  YEAR = 'YEAR',
  MONTH = 'MONTH',
  DAY = 'DAY',
  DATE = 'DATE',
  SUM = 'SUM',
  AVG = 'AVG',
  COUNT = 'COUNT',
  MIN = 'MIN',
  MAX = 'MAX',
  CREATE = 'CREATE',
  VIEW = 'VIEW',
  NULLS = 'NULLS',
  FIRST = 'FIRST',
  LAST = 'LAST',
  FETCH = 'FETCH',
  NEXT = 'NEXT',
  ROWS = 'ROWS',
  ONLY = 'ONLY',
  SOME = 'SOME',
  ANY = 'ANY',
  LEADING = 'LEADING',
  TRAILING = 'TRAILING',
  BOTH = 'BOTH',
  FOR = 'FOR',
  TIMESTAMP = 'TIMESTAMP',
  HOUR = 'HOUR',
  MINUTE = 'MINUTE',
  SECOND = 'SECOND',
  OVER = 'OVER',
  PARTITION = 'PARTITION',
  RANGE = 'RANGE',
  GROUPS = 'GROUPS',
  UNBOUNDED = 'UNBOUNDED',
  PRECEDING = 'PRECEDING',
  FOLLOWING = 'FOLLOWING',
  CURRENT = 'CURRENT',
  ROW = 'ROW',
  NATURAL = 'NATURAL',
  USING = 'USING',
  TABLE = 'TABLE',
  DROP = 'DROP',
  IF = 'IF',
  ANALYZE = 'ANALYZE',
}

const NON_KEYWORD_TOKENS = new Set([
  'IDENT', 'NUMBER', 'STRING', 'COMMA', 'DOT', 'STAR',
  'LPAREN', 'RPAREN', 'EQ', 'NEQ', 'LT', 'GT', 'LTE', 'GTE',
  'PLUS', 'MINUS', 'SLASH', 'PERCENT', 'SEMICOLON', 'CONCAT', 'COLON', 'PLACEHOLDER', 'EOF',
]);

const PLACEHOLDER_PREFIX = '$';
const QUOTE_DELIMITER = '"';

const KEYWORDS = new Map<string, TokenType>();
for (const key of Object.keys(TokenType)) {
  if (!NON_KEYWORD_TOKENS.has(key)) {
    KEYWORDS.set(key, TokenType[key as keyof typeof TokenType]);
  }
}

export interface SourcePosition { line: number; column: number; }

export function positionOf(input: string, offset: number): SourcePosition {
  const bounded = Math.max(0, Math.min(offset, input.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < bounded; i++) {
    if (input[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
}

export function describePosition(input: string, offset: number): string {
  const { line, column } = positionOf(input, offset);
  return `line ${line}, column ${column}`;
}

export class Token {
  type: TokenType;
  value: string;
  position: number;
  quoted: boolean;

  constructor(type: TokenType, value: string, position: number, quoted: boolean = false) {
    this.type = type;
    this.value = value;
    this.position = position;
    this.quoted = quoted;
  }
}

export class Lexer {
  input: string;
  pos: number;
  tokens: Token[];

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
    this.tokens = [];
    this._tokenize();
  }

  _tokenize(): void {
    while (this.pos < this.input.length) {
      this._skipWhitespaceAndComments();
      if (this.pos >= this.input.length) break;

      const start = this.pos;
      const ch = this.input[this.pos];

      if (ch === "'") {
        this.tokens.push(this._readString(start));
      } else if (ch === QUOTE_DELIMITER) {
        this.tokens.push(this._readQuotedIdent(start));
      } else if (ch === PLACEHOLDER_PREFIX) {
        this.tokens.push(this._readPlaceholder(start));
      } else if (this._isDigit(ch)) {
        this.tokens.push(this._readNumber(start));
      } else if (this._isIdentStart(ch)) {
        this.tokens.push(this._readIdentOrKeyword(start));
      } else {
        this.tokens.push(this._readSymbol(start));
      }
    }

    this.tokens.push(new Token(TokenType.EOF, '', this.pos));
  }

  _skipWhitespaceAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
        continue;
      }

      if (ch === '-' && this.input[this.pos + 1] === '-') {
        while (this.pos < this.input.length && this.input[this.pos] !== '\n') {
          this.pos++;
        }
        continue;
      }

      if (ch === '/' && this.input[this.pos + 1] === '*') {
        this._skipBlockComment();
        continue;
      }

      break;
    }
  }

  _skipBlockComment(): void {
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === '/' && this.input[this.pos + 1] === '*') {
        depth++;
        this.pos += 2;
        continue;
      }
      if (this.input[this.pos] === '*' && this.input[this.pos + 1] === '/') {
        depth--;
        this.pos += 2;
        if (depth === 0) return;
        continue;
      }
      this.pos++;
    }
    this._fail('Unterminated block comment', start);
  }

  _fail(message: string, offset: number): never {
    throw new Error(`Lex error at ${describePosition(this.input, offset)}: ${message}`);
  }

  _readQuotedIdent(start: number): Token {
    this.pos++;
    let value = '';
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === QUOTE_DELIMITER) {
        if (this.input[this.pos + 1] === QUOTE_DELIMITER) {
          value += QUOTE_DELIMITER;
          this.pos += 2;
          continue;
        }
        this.pos++;
        if (value.length === 0) this._fail('Empty delimited identifier', start);
        return new Token(TokenType.IDENT, value, start, true);
      }
      value += this.input[this.pos];
      this.pos++;
    }
    this._fail('Unterminated delimited identifier', start);
  }

  _readString(start: number): Token {
    this.pos++;
    let value = '';
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === "'") {
        if (this.pos + 1 < this.input.length && this.input[this.pos + 1] === "'") {
          value += "'";
          this.pos += 2;
        } else {
          this.pos++;
          return new Token(TokenType.STRING, value, start);
        }
      } else {
        value += this.input[this.pos];
        this.pos++;
      }
    }
    this._fail('Unterminated string', start);
  }

  _readPlaceholder(start: number): Token {
    this.pos++;
    const digitsStart = this.pos;
    while (this.pos < this.input.length && this._isDigit(this.input[this.pos])) {
      this.pos++;
    }
    if (this.pos === digitsStart) {
      this._fail(`Expected parameter number after '${PLACEHOLDER_PREFIX}'`, start);
    }
    return new Token(TokenType.PLACEHOLDER, this.input.slice(digitsStart, this.pos), start);
  }

  _readNumber(start: number): Token {
    this._readDigits();
    if (this.input[this.pos] === '.') {
      this.pos++;
      this._readDigits();
    }
    this._readExponent();
    return new Token(TokenType.NUMBER, this.input.slice(start, this.pos), start);
  }

  _readDigits(): number {
    const from = this.pos;
    while (this.pos < this.input.length && this._isDigit(this.input[this.pos])) this.pos++;
    return this.pos - from;
  }

  _readExponent(): void {
    const marker = this.input[this.pos];
    if (marker !== 'e' && marker !== 'E') return;

    const saved = this.pos;
    this.pos++;
    if (this.input[this.pos] === '+' || this.input[this.pos] === '-') this.pos++;
    if (this._readDigits() === 0) this.pos = saved;
  }

  _readIdentOrKeyword(start: number): Token {
    while (this.pos < this.input.length && this._isIdentPart(this.input[this.pos])) {
      this.pos++;
    }
    const value = this.input.slice(start, this.pos);
    const upper = value.toUpperCase();
    const keywordType = KEYWORDS.get(upper);
    if (keywordType) {
      return new Token(keywordType, upper, start);
    }
    return new Token(TokenType.IDENT, value, start);
  }

  _readSymbol(start: number): Token {
    const ch = this.input[this.pos];
    this.pos++;

    switch (ch) {
      case ',': return new Token(TokenType.COMMA, ',', start);
      case '.': return new Token(TokenType.DOT, '.', start);
      case '*': return new Token(TokenType.STAR, '*', start);
      case '(': return new Token(TokenType.LPAREN, '(', start);
      case ')': return new Token(TokenType.RPAREN, ')', start);
      case '+': return new Token(TokenType.PLUS, '+', start);
      case '-': return new Token(TokenType.MINUS, '-', start);
      case '/': return new Token(TokenType.SLASH, '/', start);
      case '%': return new Token(TokenType.PERCENT, '%', start);
      case ';': return new Token(TokenType.SEMICOLON, ';', start);
      case ':': return new Token(TokenType.COLON, ':', start);
      case '=': return new Token(TokenType.EQ, '=', start);
      case '<':
        if (this.pos < this.input.length) {
          if (this.input[this.pos] === '=') { this.pos++; return new Token(TokenType.LTE, '<=', start); }
          if (this.input[this.pos] === '>') { this.pos++; return new Token(TokenType.NEQ, '<>', start); }
        }
        return new Token(TokenType.LT, '<', start);
      case '>':
        if (this.pos < this.input.length && this.input[this.pos] === '=') {
          this.pos++;
          return new Token(TokenType.GTE, '>=', start);
        }
        return new Token(TokenType.GT, '>', start);
      case '!':
        if (this.input[this.pos] === '=') {
          this.pos++;
          return new Token(TokenType.NEQ, '!=', start);
        }
        this._fail("Unexpected character '!'", start);
      case '|':
        if (this.input[this.pos] === '|') {
          this.pos++;
          return new Token(TokenType.CONCAT, '||', start);
        }
        this._fail("Unexpected character '|'", start);
      default:
        this._fail(`Unexpected character '${ch}'`, start);
    }
  }

  _isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
  }

  _isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
  }

  _isIdentPart(ch: string): boolean {
    return this._isIdentStart(ch) || this._isDigit(ch);
  }
}
