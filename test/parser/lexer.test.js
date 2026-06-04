import { describe, it, expect } from 'vitest';
import { Lexer, TokenType } from '../../src/parser/lexer.js';

describe('Lexer', () => {
  it('tokenizes simple SELECT', () => {
    const lexer = new Lexer("SELECT 1");
    const types = lexer.tokens.map(t => t.type);
    expect(types).toEqual([TokenType.SELECT, TokenType.NUMBER, TokenType.EOF]);
  });

  it('tokenizes string literals with escapes', () => {
    const lexer = new Lexer("'hello''world'");
    expect(lexer.tokens[0].type).toBe(TokenType.STRING);
    expect(lexer.tokens[0].value).toBe("hello'world");
  });

  it('tokenizes comparison operators', () => {
    const lexer = new Lexer("a <= b <> c >= d");
    const types = lexer.tokens.map(t => t.type).filter(t => t !== TokenType.EOF);
    expect(types).toEqual([
      TokenType.IDENT, TokenType.LTE, TokenType.IDENT,
      TokenType.NEQ, TokenType.IDENT, TokenType.GTE, TokenType.IDENT,
    ]);
  });

  it('tokenizes keywords case-insensitively', () => {
    const lexer = new Lexer("select FROM where");
    const types = lexer.tokens.map(t => t.type).filter(t => t !== TokenType.EOF);
    expect(types).toEqual([TokenType.SELECT, TokenType.FROM, TokenType.WHERE]);
  });

  it('tokenizes decimal numbers', () => {
    const lexer = new Lexer("3.14");
    expect(lexer.tokens[0].value).toBe("3.14");
  });

  it('tokenizes concat operator', () => {
    const lexer = new Lexer("a || b");
    expect(lexer.tokens[1].type).toBe(TokenType.CONCAT);
  });

  it('skips line comments', () => {
    const lexer = new Lexer("SELECT -- comment\n1");
    const types = lexer.tokens.map(t => t.type).filter(t => t !== TokenType.EOF);
    expect(types).toEqual([TokenType.SELECT, TokenType.NUMBER]);
  });

  it('tokenizes DATE keyword', () => {
    const lexer = new Lexer("DATE '1995-01-01'");
    const types = lexer.tokens.map(t => t.type).filter(t => t !== TokenType.EOF);
    expect(types).toEqual([TokenType.DATE, TokenType.STRING]);
  });

  it('tokenizes INTERVAL', () => {
    const lexer = new Lexer("INTERVAL '1' YEAR");
    const types = lexer.tokens.map(t => t.type).filter(t => t !== TokenType.EOF);
    expect(types).toEqual([TokenType.INTERVAL, TokenType.STRING, TokenType.YEAR]);
  });
});
