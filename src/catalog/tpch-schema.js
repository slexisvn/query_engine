import { DataType } from '../storage/data-type.js';
import { Catalog } from './catalog.js';

function col(name, dataType) {
  return { name: name.toUpperCase(), dataType };
}

const D = DataType;

const REGION_COLUMNS = [
  col('R_REGIONKEY', D.INT32),
  col('R_NAME', D.VARCHAR),
  col('R_COMMENT', D.VARCHAR),
];

const NATION_COLUMNS = [
  col('N_NATIONKEY', D.INT32),
  col('N_NAME', D.VARCHAR),
  col('N_REGIONKEY', D.INT32),
  col('N_COMMENT', D.VARCHAR),
];

const SUPPLIER_COLUMNS = [
  col('S_SUPPKEY', D.INT32),
  col('S_NAME', D.VARCHAR),
  col('S_ADDRESS', D.VARCHAR),
  col('S_NATIONKEY', D.INT32),
  col('S_PHONE', D.VARCHAR),
  col('S_ACCTBAL', D.DECIMAL),
  col('S_COMMENT', D.VARCHAR),
];

const PART_COLUMNS = [
  col('P_PARTKEY', D.INT32),
  col('P_NAME', D.VARCHAR),
  col('P_MFGR', D.VARCHAR),
  col('P_BRAND', D.VARCHAR),
  col('P_TYPE', D.VARCHAR),
  col('P_SIZE', D.INT32),
  col('P_CONTAINER', D.VARCHAR),
  col('P_RETAILPRICE', D.DECIMAL),
  col('P_COMMENT', D.VARCHAR),
];

const PARTSUPP_COLUMNS = [
  col('PS_PARTKEY', D.INT32),
  col('PS_SUPPKEY', D.INT32),
  col('PS_AVAILQTY', D.INT32),
  col('PS_SUPPLYCOST', D.DECIMAL),
  col('PS_COMMENT', D.VARCHAR),
];

const CUSTOMER_COLUMNS = [
  col('C_CUSTKEY', D.INT32),
  col('C_NAME', D.VARCHAR),
  col('C_ADDRESS', D.VARCHAR),
  col('C_NATIONKEY', D.INT32),
  col('C_PHONE', D.VARCHAR),
  col('C_ACCTBAL', D.DECIMAL),
  col('C_MKTSEGMENT', D.VARCHAR),
  col('C_COMMENT', D.VARCHAR),
];

const ORDERS_COLUMNS = [
  col('O_ORDERKEY', D.INT32),
  col('O_CUSTKEY', D.INT32),
  col('O_ORDERSTATUS', D.VARCHAR),
  col('O_TOTALPRICE', D.DECIMAL),
  col('O_ORDERDATE', D.DATE),
  col('O_ORDERPRIORITY', D.VARCHAR),
  col('O_CLERK', D.VARCHAR),
  col('O_SHIPPRIORITY', D.INT32),
  col('O_COMMENT', D.VARCHAR),
];

const LINEITEM_COLUMNS = [
  col('L_ORDERKEY', D.INT32),
  col('L_PARTKEY', D.INT32),
  col('L_SUPPKEY', D.INT32),
  col('L_LINENUMBER', D.INT32),
  col('L_QUANTITY', D.DECIMAL),
  col('L_EXTENDEDPRICE', D.DECIMAL),
  col('L_DISCOUNT', D.DECIMAL),
  col('L_TAX', D.DECIMAL),
  col('L_RETURNFLAG', D.VARCHAR),
  col('L_LINESTATUS', D.VARCHAR),
  col('L_SHIPDATE', D.DATE),
  col('L_COMMITDATE', D.DATE),
  col('L_RECEIPTDATE', D.DATE),
  col('L_SHIPINSTRUCT', D.VARCHAR),
  col('L_SHIPMODE', D.VARCHAR),
  col('L_COMMENT', D.VARCHAR),
];

export const TPCH_TABLES = {
  REGION: { columns: REGION_COLUMNS, primaryKey: ['R_REGIONKEY'] },
  NATION: {
    columns: NATION_COLUMNS,
    primaryKey: ['N_NATIONKEY'],
    foreignKeys: [{ columns: ['N_REGIONKEY'], refTable: 'REGION', refColumns: ['R_REGIONKEY'] }],
  },
  SUPPLIER: {
    columns: SUPPLIER_COLUMNS,
    primaryKey: ['S_SUPPKEY'],
    foreignKeys: [{ columns: ['S_NATIONKEY'], refTable: 'NATION', refColumns: ['N_NATIONKEY'] }],
  },
  PART: { columns: PART_COLUMNS, primaryKey: ['P_PARTKEY'] },
  PARTSUPP: {
    columns: PARTSUPP_COLUMNS,
    primaryKey: ['PS_PARTKEY', 'PS_SUPPKEY'],
    foreignKeys: [
      { columns: ['PS_PARTKEY'], refTable: 'PART', refColumns: ['P_PARTKEY'] },
      { columns: ['PS_SUPPKEY'], refTable: 'SUPPLIER', refColumns: ['S_SUPPKEY'] },
    ],
  },
  CUSTOMER: {
    columns: CUSTOMER_COLUMNS,
    primaryKey: ['C_CUSTKEY'],
    foreignKeys: [{ columns: ['C_NATIONKEY'], refTable: 'NATION', refColumns: ['N_NATIONKEY'] }],
  },
  ORDERS: {
    columns: ORDERS_COLUMNS,
    primaryKey: ['O_ORDERKEY'],
    foreignKeys: [{ columns: ['O_CUSTKEY'], refTable: 'CUSTOMER', refColumns: ['C_CUSTKEY'] }],
  },
  LINEITEM: {
    columns: LINEITEM_COLUMNS,
    primaryKey: ['L_ORDERKEY', 'L_LINENUMBER'],
    foreignKeys: [
      { columns: ['L_ORDERKEY'], refTable: 'ORDERS', refColumns: ['O_ORDERKEY'] },
      { columns: ['L_PARTKEY', 'L_SUPPKEY'], refTable: 'PARTSUPP', refColumns: ['PS_PARTKEY', 'PS_SUPPKEY'] },
    ],
  },
};

export function createTPCHCatalog() {
  const catalog = new Catalog();
  for (const [name, def] of Object.entries(TPCH_TABLES)) {
    catalog.registerTable(name, def.columns, {
      primaryKey: def.primaryKey,
      foreignKeys: def.foreignKeys || [],
    });
  }
  return catalog;
}
