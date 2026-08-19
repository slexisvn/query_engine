import { BinderScope } from '../../src/binder/scope.js';

function makeColumns(...names) {
  return names.map(n => ({ name: n, dataType: 'INT32' }));
}

describe('BinderScope', () => {
  describe('addTable / resolveTable', () => {
    it('resolves a registered table at depth 0', () => {
      const scope = new BinderScope();
      const info = { originalName: 'USERS', columns: makeColumns('ID', 'NAME') };
      scope.addTable('u', info);

      const result = scope.resolveTable('u');
      expect(result).not.toBeNull();
      expect(result.depth).toBe(0);
      expect(result.table).toBe(info);
    });

    it('resolves table case-insensitively', () => {
      const scope = new BinderScope();
      scope.addTable('Users', { originalName: 'USERS', columns: [] });

      expect(scope.resolveTable('users')).not.toBeNull();
      expect(scope.resolveTable('USERS')).not.toBeNull();
    });

    it('returns null for unregistered table', () => {
      const scope = new BinderScope();
      expect(scope.resolveTable('nope')).toBeNull();
    });

    it('resolves table from parent scope with depth > 0', () => {
      const parent = new BinderScope();
      parent.addTable('t1', { originalName: 'T1', columns: [] });
      const child = parent.child();

      const result = child.resolveTable('t1');
      expect(result.depth).toBe(1);
    });

    it('resolves from grandparent at depth 2', () => {
      const root = new BinderScope();
      root.addTable('t1', { originalName: 'T1', columns: [] });
      const child = root.child();
      const grandchild = child.child();

      expect(grandchild.resolveTable('t1').depth).toBe(2);
    });

    it('prefers local scope over parent', () => {
      const parent = new BinderScope();
      parent.addTable('t1', { originalName: 'PARENT_T1', columns: [] });

      const child = parent.child();
      child.addTable('t1', { originalName: 'CHILD_T1', columns: [] });

      const result = child.resolveTable('t1');
      expect(result.depth).toBe(0);
      expect(result.table.originalName).toBe('CHILD_T1');
    });
  });

  describe('resolveColumn without table alias', () => {
    it('finds column in single table', () => {
      const scope = new BinderScope();
      scope.addTable('users', { originalName: 'USERS', columns: makeColumns('ID', 'NAME') });

      const result = scope.resolveColumn('id');
      expect(result).not.toBeNull();
      expect(result.tableAlias).toBe('USERS');
      expect(result.column.name).toBe('ID');
      expect(result.columnIndex).toBe(0);
      expect(result.depth).toBe(0);
    });

    it('finds column case-insensitively', () => {
      const scope = new BinderScope();
      scope.addTable('t', { originalName: 'T', columns: makeColumns('MyCol') });

      expect(scope.resolveColumn('mycol')).not.toBeNull();
      expect(scope.resolveColumn('MYCOL')).not.toBeNull();
    });

    it('returns null for unknown column', () => {
      const scope = new BinderScope();
      scope.addTable('t', { originalName: 'T', columns: makeColumns('ID') });

      expect(scope.resolveColumn('nope')).toBeNull();
    });

    it('throws on ambiguous column across tables', () => {
      const scope = new BinderScope();
      scope.addTable('a', { originalName: 'A', columns: makeColumns('ID', 'X') });
      scope.addTable('b', { originalName: 'B', columns: makeColumns('ID', 'Y') });

      expect(() => scope.resolveColumn('id')).toThrow('Ambiguous column reference: id');
    });

    it('does not throw when column is unique across tables', () => {
      const scope = new BinderScope();
      scope.addTable('a', { originalName: 'A', columns: makeColumns('X') });
      scope.addTable('b', { originalName: 'B', columns: makeColumns('Y') });

      const result = scope.resolveColumn('x');
      expect(result.tableAlias).toBe('A');
    });

    it('falls back to parent scope when not found locally', () => {
      const parent = new BinderScope();
      parent.addTable('t', { originalName: 'T', columns: makeColumns('OUTER_COL') });

      const child = parent.child();
      child.addTable('s', { originalName: 'S', columns: makeColumns('INNER_COL') });

      const result = child.resolveColumn('outer_col');
      expect(result).not.toBeNull();
      expect(result.depth).toBe(1);
      expect(result.column.name).toBe('OUTER_COL');
    });

    it('increments depth through multiple parent scopes', () => {
      const root = new BinderScope();
      root.addTable('t', { originalName: 'T', columns: makeColumns('ROOT_COL') });

      const child = root.child();
      const grandchild = child.child();

      const result = grandchild.resolveColumn('root_col');
      expect(result.depth).toBe(2);
    });
  });

  describe('resolveColumn with table alias', () => {
    it('resolves qualified column reference', () => {
      const scope = new BinderScope();
      scope.addTable('u', { originalName: 'USERS', columns: makeColumns('ID', 'NAME') });

      const result = scope.resolveColumn('name', 'u');
      expect(result.tableAlias).toBe('U');
      expect(result.column.name).toBe('NAME');
      expect(result.columnIndex).toBe(1);
    });

    it('returns null when table exists but column does not', () => {
      const scope = new BinderScope();
      scope.addTable('u', { originalName: 'USERS', columns: makeColumns('ID') });

      expect(scope.resolveColumn('nope', 'u')).toBeNull();
    });

    it('returns null when table alias does not exist', () => {
      const scope = new BinderScope();
      expect(scope.resolveColumn('id', 'nope')).toBeNull();
    });

    it('resolves qualified column from parent scope with depth', () => {
      const parent = new BinderScope();
      parent.addTable('t1', { originalName: 'T1', columns: makeColumns('A', 'B') });

      const child = parent.child();

      const result = child.resolveColumn('a', 't1');
      expect(result.depth).toBe(1);
    });
  });

  describe('getAllColumns', () => {
    it('returns empty array for empty scope', () => {
      expect(new BinderScope().getAllColumns()).toEqual([]);
    });

    it('returns all columns from all tables in order', () => {
      const scope = new BinderScope();
      scope.addTable('a', { originalName: 'A', columns: makeColumns('X', 'Y') });
      scope.addTable('b', { originalName: 'B', columns: makeColumns('Z') });

      const cols = scope.getAllColumns();
      expect(cols).toHaveLength(3);
      expect(cols.map(c => c.column.name)).toEqual(['X', 'Y', 'Z']);
      expect(cols[0].tableAlias).toBe('A');
      expect(cols[2].tableAlias).toBe('B');
      expect(cols[0].columnIndex).toBe(0);
      expect(cols[1].columnIndex).toBe(1);
      expect(cols[2].columnIndex).toBe(0);
    });

    it('does not include parent scope columns', () => {
      const parent = new BinderScope();
      parent.addTable('t', { originalName: 'T', columns: makeColumns('P') });

      const child = parent.child();
      child.addTable('s', { originalName: 'S', columns: makeColumns('C') });

      const cols = child.getAllColumns();
      expect(cols).toHaveLength(1);
      expect(cols[0].column.name).toBe('C');
    });
  });

  describe('getTableColumns', () => {
    it('returns columns for a specific table', () => {
      const scope = new BinderScope();
      scope.addTable('users', { originalName: 'USERS', columns: makeColumns('ID', 'NAME', 'EMAIL') });

      const cols = scope.getTableColumns('users');
      expect(cols).toHaveLength(3);
      expect(cols.map(c => c.column.name)).toEqual(['ID', 'NAME', 'EMAIL']);
      expect(cols[2].columnIndex).toBe(2);
    });

    it('returns null for unknown table', () => {
      const scope = new BinderScope();
      expect(scope.getTableColumns('nope')).toBeNull();
    });

    it('is case-insensitive', () => {
      const scope = new BinderScope();
      scope.addTable('T', { originalName: 'T', columns: makeColumns('X') });
      expect(scope.getTableColumns('t')).not.toBeNull();
    });
  });

  describe('child()', () => {
    it('creates a child with this as parent', () => {
      const parent = new BinderScope();
      const child = parent.child();
      expect(child.parent).toBe(parent);
    });

    it('child starts with empty tables and columns', () => {
      const parent = new BinderScope();
      parent.addTable('t', { originalName: 'T', columns: makeColumns('X') });

      const child = parent.child();
      expect(child.tables.size).toBe(0);
      expect(child.columns.size).toBe(0);
    });
  });

  describe('addColumn', () => {
    it('multiple columns under same alias are all resolvable via getAllColumns', () => {
      const scope = new BinderScope();
      // add a table so getAllColumns includes these columns
      scope.addTable('t', { originalName: 'T', columns: makeColumns('R1', 'R2') });

      const cols = scope.getAllColumns();
      expect(cols).toHaveLength(2);
      expect(cols.map(c => c.column.name)).toContain('R1');
      expect(cols.map(c => c.column.name)).toContain('R2');
    });

    it('columns from separate tables are listed under their own tableAlias', () => {
      const scope = new BinderScope();
      scope.addTable('a', { originalName: 'A', columns: makeColumns('X') });
      scope.addTable('b', { originalName: 'B', columns: makeColumns('X') });

      const cols = scope.getAllColumns();
      expect(cols).toHaveLength(2);
      expect(cols[0].tableAlias).toBe('A');
      expect(cols[1].tableAlias).toBe('B');
    });
  });

  describe('shadowed relation aliases', () => {
    it('keeps the user alias when nothing is shadowed', () => {
      const scope = new BinderScope();
      expect(scope.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') })).toBe('EMP');
    });

    it('renames a relation that shadows an enclosing alias', () => {
      const parent = new BinderScope();
      parent.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });

      const child = parent.child();
      const inner = child.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });

      expect(inner).not.toBe('EMP');
      expect(child.resolveColumn('id', 'emp').tableAlias).toBe(inner);
      expect(parent.resolveColumn('id', 'emp').tableAlias).toBe('EMP');
    });

    it('resolves a renamed relation by either alias', () => {
      const parent = new BinderScope();
      parent.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });
      const child = parent.child();
      const inner = child.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });

      expect(child.resolveTable(inner).depth).toBe(0);
      expect(child.resolveColumn('id', inner).tableAlias).toBe(inner);
    });

    it('gives every shadowing relation its own alias', () => {
      const root = new BinderScope();
      root.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });
      const first = root.child().addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });
      const second = root.child().addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });

      expect(first).not.toBe(second);
    });

    it('reports the shadowing alias from an unqualified lookup', () => {
      const parent = new BinderScope();
      parent.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });
      const child = parent.child();
      const inner = child.addTable('emp', { originalName: 'EMP', columns: makeColumns('ID') });

      expect(child.resolveColumn('id').tableAlias).toBe(inner);
      expect(child.resolveColumn('id').depth).toBe(0);
    });
  });
});
