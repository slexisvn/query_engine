import { Lexer, TokenType, Token } from '../../src/parser/lexer.js';

function tokenTypes(sql) {
  return new Lexer(sql).tokens.map(t => t.type);
}

function tokenValues(sql) {
  return new Lexer(sql).tokens.map(t => t.value);
}

describe('Lexer', () => {
  describe('keywords', () => {
    it('recognizes SQL keywords case-insensitively', () => {
      const types = tokenTypes('select FROM Where');
      expect(types).toEqual([TokenType.SELECT, TokenType.FROM, TokenType.WHERE, TokenType.EOF]);
    });

    it('recognizes all join keywords', () => {
      const types = tokenTypes('INNER LEFT RIGHT FULL OUTER CROSS JOIN');
      expect(types).toEqual([
        TokenType.INNER, TokenType.LEFT, TokenType.RIGHT, TokenType.FULL,
        TokenType.OUTER, TokenType.CROSS, TokenType.JOIN, TokenType.EOF,
      ]);
    });

    it('recognizes aggregate keywords', () => {
      const types = tokenTypes('SUM AVG COUNT MIN MAX');
      expect(types).toEqual([TokenType.SUM, TokenType.AVG, TokenType.COUNT, TokenType.MIN, TokenType.MAX, TokenType.EOF]);
    });

    it('treats unknown words as IDENT', () => {
      const lex = new Lexer('my_table foo123');
      expect(lex.tokens[0]).toEqual(new Token(TokenType.IDENT, 'my_table', 0));
      expect(lex.tokens[1]).toEqual(new Token(TokenType.IDENT, 'foo123', 9));
    });

    it('preserves original case for identifiers', () => {
      expect(tokenValues('MyTable')[0]).toBe('MyTable');
    });

    it('uppercases keyword values', () => {
      expect(tokenValues('select')[0]).toBe('SELECT');
    });
  });

  describe('numbers', () => {
    it('tokenizes integers', () => {
      const lex = new Lexer('42');
      expect(lex.tokens[0]).toEqual(new Token(TokenType.NUMBER, '42', 0));
    });

    it('tokenizes decimals', () => {
      const lex = new Lexer('3.14');
      expect(lex.tokens[0]).toEqual(new Token(TokenType.NUMBER, '3.14', 0));
    });

    it('tokenizes number with trailing dot as decimal', () => {
      const lex = new Lexer('5.');
      expect(lex.tokens[0]).toEqual(new Token(TokenType.NUMBER, '5.', 0));
    });

    it('tokenizes multiple numbers separated by operators', () => {
      const types = tokenTypes('1 + 2.5');
      expect(types).toEqual([TokenType.NUMBER, TokenType.PLUS, TokenType.NUMBER, TokenType.EOF]);
    });
  });

  describe('strings', () => {
    it('tokenizes single-quoted strings', () => {
      const lex = new Lexer("'hello world'");
      expect(lex.tokens[0]).toEqual(new Token(TokenType.STRING, 'hello world', 0));
    });

    it('handles escaped single quotes inside strings', () => {
      const lex = new Lexer("'it''s'");
      expect(lex.tokens[0].value).toBe("it's");
    });

    it('handles empty strings', () => {
      const lex = new Lexer("''");
      expect(lex.tokens[0]).toEqual(new Token(TokenType.STRING, '', 0));
    });

    it('throws on unterminated strings', () => {
      expect(() => new Lexer("'unterminated")).toThrow('Unterminated string at position 0');
    });

    it('handles string with multiple escaped quotes', () => {
      const lex = new Lexer("'a''b''c'");
      expect(lex.tokens[0].value).toBe("a'b'c");
    });
  });

  describe('operators and symbols', () => {
    it('tokenizes comparison operators', () => {
      const types = tokenTypes('= <> != < > <= >=');
      expect(types).toEqual([
        TokenType.EQ, TokenType.NEQ, TokenType.NEQ,
        TokenType.LT, TokenType.GT, TokenType.LTE, TokenType.GTE, TokenType.EOF,
      ]);
    });

    it('tokenizes arithmetic operators', () => {
      const types = tokenTypes('+ - * / %');
      expect(types).toEqual([TokenType.PLUS, TokenType.MINUS, TokenType.STAR, TokenType.SLASH, TokenType.PERCENT, TokenType.EOF]);
    });

    it('tokenizes concatenation operator', () => {
      const types = tokenTypes("'a' || 'b'");
      expect(types).toEqual([TokenType.STRING, TokenType.CONCAT, TokenType.STRING, TokenType.EOF]);
    });

    it('tokenizes parentheses, comma, dot, semicolon, colon', () => {
      const types = tokenTypes('(a.b), c;:');
      expect(types).toEqual([
        TokenType.LPAREN, TokenType.IDENT, TokenType.DOT, TokenType.IDENT, TokenType.RPAREN,
        TokenType.COMMA, TokenType.IDENT, TokenType.SEMICOLON, TokenType.COLON, TokenType.EOF,
      ]);
    });

    it('tokenizes $N parameter placeholders with the number as value', () => {
      const tokens = new Lexer('$1 $42').tokens;
      expect(tokens.map(t => t.type)).toEqual([TokenType.PLACEHOLDER, TokenType.PLACEHOLDER, TokenType.EOF]);
      expect(tokens.map(t => t.value)).toEqual(['1', '42', '']);
    });

    it('throws on $ without a following number', () => {
      expect(() => new Lexer('$ ')).toThrow("Expected parameter number after '$' at position 0");
    });

    it('throws on bare ! without =', () => {
      expect(() => new Lexer('!')).toThrow("Unexpected character '!' at position 0");
    });

    it('throws on bare | without second |', () => {
      expect(() => new Lexer('|')).toThrow("Unexpected character '|' at position 0");
    });

    it('throws on unexpected characters', () => {
      expect(() => new Lexer('@')).toThrow("Unexpected character '@' at position 0");
    });
  });

  describe('whitespace and comments', () => {
    it('skips spaces, tabs, newlines, carriage returns', () => {
      const types = tokenTypes("SELECT\t\n\rfoo");
      expect(types).toEqual([TokenType.SELECT, TokenType.IDENT, TokenType.EOF]);
    });

    it('skips single-line comments', () => {
      const types = tokenTypes('SELECT -- this is a comment\nfoo');
      expect(types).toEqual([TokenType.SELECT, TokenType.IDENT, TokenType.EOF]);
    });

    it('handles comment at end of input without newline', () => {
      const types = tokenTypes('SELECT foo -- end');
      expect(types).toEqual([TokenType.SELECT, TokenType.IDENT, TokenType.EOF]);
    });

    it('produces only EOF for empty input', () => {
      const lex = new Lexer('');
      expect(lex.tokens).toEqual([new Token(TokenType.EOF, '', 0)]);
    });

    it('produces only EOF for whitespace-only input', () => {
      const lex = new Lexer('   \t\n  ');
      expect(lex.tokens.length).toBe(1);
      expect(lex.tokens[0].type).toBe(TokenType.EOF);
    });
  });

  describe('position tracking', () => {
    it('records correct token positions', () => {
      const lex = new Lexer('SELECT foo FROM bar');
      expect(lex.tokens[0].position).toBe(0);
      expect(lex.tokens[1].position).toBe(7);
      expect(lex.tokens[2].position).toBe(11);
      expect(lex.tokens[3].position).toBe(16);
    });
  });

  describe('complex tokenization', () => {
    it('tokenizes a full SELECT query', () => {
      const sql = "SELECT a, b FROM t WHERE a > 10 AND b = 'x'";
      const types = tokenTypes(sql);
      expect(types).toEqual([
        TokenType.SELECT, TokenType.IDENT, TokenType.COMMA, TokenType.IDENT,
        TokenType.FROM, TokenType.IDENT,
        TokenType.WHERE, TokenType.IDENT, TokenType.GT, TokenType.NUMBER,
        TokenType.AND, TokenType.IDENT, TokenType.EQ, TokenType.STRING,
        TokenType.EOF,
      ]);
    });

    it('tokenizes aggregate with DISTINCT', () => {
      const types = tokenTypes('COUNT(DISTINCT id)');
      expect(types).toEqual([
        TokenType.COUNT, TokenType.LPAREN, TokenType.DISTINCT, TokenType.IDENT, TokenType.RPAREN, TokenType.EOF,
      ]);
    });

    it('distinguishes STAR from multiplication context', () => {
      const types = tokenTypes('SELECT * FROM t WHERE a * b > 0');
      const stars = types.filter(t => t === TokenType.STAR);
      expect(stars.length).toBe(2);
    });
  });
});
