import { TPCH_TABLES, createTPCHCatalog } from '../../src/catalog/tpch-schema.js';
import { DataType } from '../../src/storage/data-type.js';

describe('TPCH_TABLES', () => {
  it('defines all 8 TPC-H tables', () => {
    const expected = ['REGION', 'NATION', 'SUPPLIER', 'PART', 'PARTSUPP', 'CUSTOMER', 'ORDERS', 'LINEITEM'];
    expect(Object.keys(TPCH_TABLES).sort()).toEqual(expected.sort());
  });

  it('REGION has 3 columns with R_ prefix', () => {
    const cols = TPCH_TABLES.REGION.columns;
    expect(cols).toHaveLength(3);
    expect(cols.every(c => c.name.startsWith('R_'))).toBe(true);
    expect(cols[0]).toEqual({ name: 'R_REGIONKEY', dataType: DataType.INT32 });
  });

  it('LINEITEM has 16 columns', () => {
    expect(TPCH_TABLES.LINEITEM.columns).toHaveLength(16);
  });

  it('LINEITEM has composite primary key', () => {
    expect(TPCH_TABLES.LINEITEM.primaryKey).toEqual(['L_ORDERKEY', 'L_LINENUMBER']);
  });

  it('PARTSUPP has composite primary key and 2 foreign keys', () => {
    expect(TPCH_TABLES.PARTSUPP.primaryKey).toEqual(['PS_PARTKEY', 'PS_SUPPKEY']);
    expect(TPCH_TABLES.PARTSUPP.foreignKeys).toHaveLength(2);
  });

  it('ORDERS foreign key references CUSTOMER', () => {
    const fk = TPCH_TABLES.ORDERS.foreignKeys[0];
    expect(fk.columns).toEqual(['O_CUSTKEY']);
    expect(fk.refTable).toBe('CUSTOMER');
    expect(fk.refColumns).toEqual(['C_CUSTKEY']);
  });

  it('NATION foreign key references REGION', () => {
    const fk = TPCH_TABLES.NATION.foreignKeys[0];
    expect(fk.refTable).toBe('REGION');
  });

  it('LINEITEM composite FK references PARTSUPP', () => {
    const fk = TPCH_TABLES.LINEITEM.foreignKeys.find(f => f.refTable === 'PARTSUPP');
    expect(fk).toBeDefined();
    expect(fk.columns).toEqual(['L_PARTKEY', 'L_SUPPKEY']);
  });

  it('all columns have valid DataType', () => {
    const validTypes = new Set(Object.values(DataType));
    for (const [, def] of Object.entries(TPCH_TABLES)) {
      for (const col of def.columns) {
        expect(validTypes.has(col.dataType)).toBe(true);
      }
    }
  });

  it('ORDERS has DATE columns', () => {
    const dateCols = TPCH_TABLES.ORDERS.columns.filter(c => c.dataType === DataType.DATE);
    expect(dateCols).toHaveLength(1);
    expect(dateCols[0].name).toBe('O_ORDERDATE');
  });

  it('LINEITEM has DECIMAL columns for money fields', () => {
    const decimalCols = TPCH_TABLES.LINEITEM.columns.filter(c => c.dataType === DataType.DECIMAL);
    expect(decimalCols.map(c => c.name).sort()).toEqual(['L_DISCOUNT', 'L_EXTENDEDPRICE', 'L_QUANTITY', 'L_TAX']);
  });
});

describe('createTPCHCatalog', () => {
  it('returns a Catalog with all 8 tables', () => {
    const catalog = createTPCHCatalog();
    expect(catalog.listTables()).toHaveLength(8);
    expect(catalog.hasTable('REGION')).toBe(true);
    expect(catalog.hasTable('LINEITEM')).toBe(true);
  });

  it('tables are queryable by name', () => {
    const catalog = createTPCHCatalog();
    const orders = catalog.getTable('ORDERS');
    expect(orders.columns).toHaveLength(9);
    expect(orders.primaryKey).toEqual(['O_ORDERKEY']);
  });

  it('columns are resolvable', () => {
    const catalog = createTPCHCatalog();
    const col = catalog.getColumn('NATION', 'N_NAME');
    expect(col).not.toBeNull();
    expect(col.dataType).toBe(DataType.VARCHAR);
  });

  it('column indexes are correct', () => {
    const catalog = createTPCHCatalog();
    expect(catalog.getColumnIndex('LINEITEM', 'L_ORDERKEY')).toBe(0);
    expect(catalog.getColumnIndex('LINEITEM', 'L_COMMENT')).toBe(15);
  });
});
