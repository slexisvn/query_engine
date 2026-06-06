import { Catalog } from '../../src/catalog/catalog.js';
import { DataType } from '../../src/storage/data-type.js';

function makeCatalog() {
  const c = new Catalog();
  c.registerTable('users', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'NAME', dataType: DataType.VARCHAR },
    { name: 'EMAIL', dataType: DataType.VARCHAR },
  ], { primaryKey: ['ID'] });
  c.registerTable('orders', [
    { name: 'ID', dataType: DataType.INT32 },
    { name: 'USER_ID', dataType: DataType.INT32 },
    { name: 'TOTAL', dataType: DataType.DECIMAL },
  ], {
    primaryKey: ['ID'],
    foreignKeys: [{ columns: ['USER_ID'], refTable: 'USERS', refColumns: ['ID'] }],
  });
  return c;
}

describe('Catalog', () => {
  describe('registerTable / getTable', () => {
    it('stores and retrieves table metadata', () => {
      const c = makeCatalog();
      const t = c.getTable('users');
      expect(t).not.toBeNull();
      expect(t.name).toBe('USERS');
      expect(t.columns).toHaveLength(3);
      expect(t.primaryKey).toEqual(['ID']);
    });

    it('is case-insensitive on lookup', () => {
      const c = makeCatalog();
      expect(c.getTable('USERS')).toBe(c.getTable('users'));
      expect(c.getTable('Users')).toBe(c.getTable('users'));
    });

    it('returns null for unknown table', () => {
      expect(makeCatalog().getTable('nonexistent')).toBeNull();
    });

    it('stores foreignKeys', () => {
      const c = makeCatalog();
      const o = c.getTable('orders');
      expect(o.foreignKeys).toHaveLength(1);
      expect(o.foreignKeys[0].refTable).toBe('USERS');
    });

    it('defaults primaryKey and foreignKeys to empty arrays', () => {
      const c = new Catalog();
      c.registerTable('bare', [{ name: 'X', dataType: DataType.INT32 }]);
      const t = c.getTable('bare');
      expect(t.primaryKey).toEqual([]);
      expect(t.foreignKeys).toEqual([]);
    });
  });

  describe('hasTable', () => {
    it('returns true for registered tables', () => {
      const c = makeCatalog();
      expect(c.hasTable('users')).toBe(true);
      expect(c.hasTable('ORDERS')).toBe(true);
    });

    it('returns false for unregistered tables', () => {
      expect(makeCatalog().hasTable('nope')).toBe(false);
    });
  });

  describe('listTables', () => {
    it('returns all registered table names uppercased', () => {
      const c = makeCatalog();
      const names = c.listTables();
      expect(names).toContain('USERS');
      expect(names).toContain('ORDERS');
      expect(names).toHaveLength(2);
    });

    it('returns empty array when no tables', () => {
      expect(new Catalog().listTables()).toEqual([]);
    });
  });

  describe('getColumn', () => {
    it('returns column metadata by table and column name', () => {
      const c = makeCatalog();
      const col = c.getColumn('users', 'name');
      expect(col).not.toBeNull();
      expect(col.name).toBe('NAME');
      expect(col.dataType).toBe(DataType.VARCHAR);
    });

    it('is case-insensitive for both table and column', () => {
      const c = makeCatalog();
      expect(c.getColumn('USERS', 'email')).not.toBeNull();
      expect(c.getColumn('users', 'EMAIL')).not.toBeNull();
    });

    it('returns null for unknown table', () => {
      expect(makeCatalog().getColumn('nope', 'ID')).toBeNull();
    });

    it('returns null for unknown column in valid table', () => {
      expect(makeCatalog().getColumn('users', 'nope')).toBeNull();
    });
  });

  describe('getColumnIndex', () => {
    it('returns zero-based index of column', () => {
      const c = makeCatalog();
      expect(c.getColumnIndex('users', 'ID')).toBe(0);
      expect(c.getColumnIndex('users', 'NAME')).toBe(1);
      expect(c.getColumnIndex('users', 'EMAIL')).toBe(2);
    });

    it('is case-insensitive', () => {
      expect(makeCatalog().getColumnIndex('users', 'email')).toBe(2);
    });

    it('returns -1 for unknown column', () => {
      expect(makeCatalog().getColumnIndex('users', 'nope')).toBe(-1);
    });

    it('returns -1 for unknown table', () => {
      expect(makeCatalog().getColumnIndex('nope', 'ID')).toBe(-1);
    });
  });

  describe('indexes', () => {
    it('registers and retrieves index for column', () => {
      const c = makeCatalog();
      const mockBtree = { search: () => {} };
      c.registerIndex('users', 'ID', mockBtree);

      const btree = c.getIndexForColumn('users', 'ID');
      expect(btree).toBe(mockBtree);
    });

    it('is case-insensitive for index lookup', () => {
      const c = makeCatalog();
      const mockBtree = { search: () => {} };
      c.registerIndex('USERS', 'id', mockBtree);
      expect(c.getIndexForColumn('users', 'ID')).toBe(mockBtree);
    });

    it('returns null for non-indexed column', () => {
      expect(makeCatalog().getIndexForColumn('users', 'NAME')).toBeNull();
    });

    it('returns all indexes for a table', () => {
      const c = makeCatalog();
      c.registerIndex('users', 'ID', { type: 'pk' });
      c.registerIndex('users', 'EMAIL', { type: 'unique' });
      c.registerIndex('orders', 'ID', { type: 'pk' });

      const userIndexes = c.getIndexesForTable('users');
      expect(userIndexes).toHaveLength(2);
      expect(userIndexes.map(i => i.columnName).sort()).toEqual(['EMAIL', 'ID']);
    });

    it('returns empty array for table with no indexes', () => {
      expect(makeCatalog().getIndexesForTable('users')).toEqual([]);
    });
  });

  describe('registerTableStorage / getTableStorage', () => {
    it('stores and retrieves storage engine', () => {
      const c = makeCatalog();
      const mockStorage = { scan: () => {} };
      c.registerTableStorage('users', mockStorage);
      expect(c.getTableStorage('users')).toBe(mockStorage);
    });

    it('returns null for table without storage', () => {
      expect(makeCatalog().getTableStorage('users')).toBeNull();
    });

    it('is case-insensitive', () => {
      const c = makeCatalog();
      c.registerTableStorage('USERS', { type: 'mock' });
      expect(c.getTableStorage('users')).not.toBeNull();
    });
  });
});
