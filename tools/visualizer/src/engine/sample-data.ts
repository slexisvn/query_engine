import { dateToEpochDays } from '@engine/storage/data-type.js';
import type { ColumnValue } from '@engine/storage/data-type.js';

export type SampleRow = Record<string, ColumnValue>;

const SEED = 0x5eed1e;

const REGION_NAMES = ['AFRICA', 'AMERICA', 'ASIA', 'EUROPE', 'MIDDLE EAST'] as const;

const NATIONS: readonly (readonly [string, number])[] = [
  ['ALGERIA', 0], ['ARGENTINA', 1], ['BRAZIL', 1], ['CANADA', 1], ['EGYPT', 4],
  ['ETHIOPIA', 0], ['FRANCE', 3], ['GERMANY', 3], ['INDIA', 2], ['INDONESIA', 2],
  ['IRAN', 4], ['IRAQ', 4], ['JAPAN', 2], ['JORDAN', 4], ['KENYA', 0],
  ['MOROCCO', 0], ['MOZAMBIQUE', 0], ['PERU', 1], ['CHINA', 2], ['ROMANIA', 3],
  ['SAUDI ARABIA', 4], ['VIETNAM', 2], ['RUSSIA', 3], ['UNITED KINGDOM', 3], ['UNITED STATES', 1],
];

const MARKET_SEGMENTS = ['AUTOMOBILE', 'BUILDING', 'FURNITURE', 'HOUSEHOLD', 'MACHINERY'] as const;
const ORDER_PRIORITIES = ['1-URGENT', '2-HIGH', '3-MEDIUM', '4-NOT SPECIFIED', '5-LOW'] as const;
const SHIP_MODES = ['REG AIR', 'AIR', 'RAIL', 'SHIP', 'TRUCK', 'MAIL', 'FOB'] as const;
const SHIP_INSTRUCTIONS = ['DELIVER IN PERSON', 'COLLECT COD', 'NONE', 'TAKE BACK RETURN'] as const;
const CONTAINERS = ['SM CASE', 'SM BOX', 'MED BAG', 'MED BOX', 'LG CASE', 'LG BOX', 'JUMBO PACK', 'WRAP PKG'] as const;
const PART_COLOURS = ['almond', 'antique', 'azure', 'blush', 'cornsilk', 'cream', 'dim', 'forest', 'ivory', 'khaki'] as const;
const PART_SHAPES = ['ANODIZED', 'BRUSHED', 'BURNISHED', 'PLATED', 'POLISHED'] as const;
const PART_METALS = ['BRASS', 'COPPER', 'NICKEL', 'STEEL', 'TIN'] as const;

const SHIPPED_FLAGS = ['R', 'A'] as const;

const SAMPLE_SCALE = {
  REGION: REGION_NAMES.length,
  NATION: NATIONS.length,
  SUPPLIER: 120,
  PART: 500,
  PARTSUPP: 2000,
  CUSTOMER: 400,
  ORDERS: 2000,
} as const;

const SUPPLIERS_PER_PART = SAMPLE_SCALE.PARTSUPP / SAMPLE_SCALE.PART;
const MAX_LINES_PER_ORDER = 6;
const CALENDAR_FIRST = dateToEpochDays(1992, 1, 1);
const CALENDAR_LAST = dateToEpochDays(1998, 8, 2);
const MAX_SHIP_LAG_DAYS = 121;
const MAX_COMMIT_LAG_DAYS = 90;
const MAX_RECEIPT_LAG_DAYS = 30;
const PART_SIZES = 50;
const BRANDS_PER_MANUFACTURER = 5;
const MANUFACTURERS = 5;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4294967296;
  };
}

interface Random {
  next(): number;
  int(lowest: number, highest: number): number;
  money(lowest: number, highest: number): number;
  pick<T>(values: readonly T[]): T;
}

function randomOf(seed: number): Random {
  const next = mulberry32(seed);
  const int = (lowest: number, highest: number) => lowest + Math.floor(next() * (highest - lowest + 1));
  return {
    next,
    int,
    money: (lowest, highest) => Math.round((lowest + next() * (highest - lowest)) * 100) / 100,
    pick: values => values[int(0, values.length - 1)],
  };
}

function padded(prefix: string, value: number, width: number): string {
  return `${prefix}${String(value).padStart(width, '0')}`;
}

function phoneFor(nationKey: number, random: Random): string {
  return `${String(10 + nationKey).padStart(2, '0')}-${random.int(100, 999)}-${random.int(100, 999)}-${random.int(1000, 9999)}`;
}

function comment(random: Random, words: number): string {
  const parts: string[] = [];
  for (let index = 0; index < words; index++) parts.push(random.pick(PART_COLOURS));
  return parts.join(' ');
}

function regionRows(): SampleRow[] {
  return REGION_NAMES.map((name, key) => ({
    R_REGIONKEY: key,
    R_NAME: name,
    R_COMMENT: `${name.toLowerCase()} trading region`,
  }));
}

function nationRows(): SampleRow[] {
  return NATIONS.map(([name, regionKey], key) => ({
    N_NATIONKEY: key,
    N_NAME: name,
    N_REGIONKEY: regionKey,
    N_COMMENT: `${name.toLowerCase()} accounts`,
  }));
}

function supplierRows(random: Random): SampleRow[] {
  const rows: SampleRow[] = [];
  for (let key = 1; key <= SAMPLE_SCALE.SUPPLIER; key++) {
    const nationKey = random.int(0, NATIONS.length - 1);
    rows.push({
      S_SUPPKEY: key,
      S_NAME: padded('Supplier#', key, 9),
      S_ADDRESS: `${random.int(1, 9999)} ${random.pick(PART_COLOURS)} street`,
      S_NATIONKEY: nationKey,
      S_PHONE: phoneFor(nationKey, random),
      S_ACCTBAL: random.money(-999.99, 9999.99),
      S_COMMENT: comment(random, 6),
    });
  }
  return rows;
}

function partRows(random: Random): SampleRow[] {
  const rows: SampleRow[] = [];
  for (let key = 1; key <= SAMPLE_SCALE.PART; key++) {
    const manufacturer = random.int(1, MANUFACTURERS);
    rows.push({
      P_PARTKEY: key,
      P_NAME: `${random.pick(PART_COLOURS)} ${random.pick(PART_COLOURS)} ${random.pick(PART_METALS).toLowerCase()}`,
      P_MFGR: `Manufacturer#${manufacturer}`,
      P_BRAND: `Brand#${manufacturer}${random.int(1, BRANDS_PER_MANUFACTURER)}`,
      P_TYPE: `${random.pick(PART_SHAPES)} ${random.pick(PART_METALS)}`,
      P_SIZE: random.int(1, PART_SIZES),
      P_CONTAINER: random.pick(CONTAINERS),
      P_RETAILPRICE: random.money(901, 2098.99),
      P_COMMENT: comment(random, 3),
    });
  }
  return rows;
}

function partsuppRows(random: Random): SampleRow[] {
  const rows: SampleRow[] = [];
  for (let partKey = 1; partKey <= SAMPLE_SCALE.PART; partKey++) {
    const stride = Math.floor(SAMPLE_SCALE.SUPPLIER / SUPPLIERS_PER_PART);
    for (let slot = 0; slot < SUPPLIERS_PER_PART; slot++) {
      const suppKey = ((partKey + slot * stride) % SAMPLE_SCALE.SUPPLIER) + 1;
      rows.push({
        PS_PARTKEY: partKey,
        PS_SUPPKEY: suppKey,
        PS_AVAILQTY: random.int(1, 9999),
        PS_SUPPLYCOST: random.money(1, 1000),
        PS_COMMENT: comment(random, 8),
      });
    }
  }
  return rows;
}

function customerRows(random: Random): SampleRow[] {
  const rows: SampleRow[] = [];
  for (let key = 1; key <= SAMPLE_SCALE.CUSTOMER; key++) {
    const nationKey = random.int(0, NATIONS.length - 1);
    rows.push({
      C_CUSTKEY: key,
      C_NAME: padded('Customer#', key, 9),
      C_ADDRESS: `${random.int(1, 9999)} ${random.pick(PART_COLOURS)} avenue`,
      C_NATIONKEY: nationKey,
      C_PHONE: phoneFor(nationKey, random),
      C_ACCTBAL: random.money(-999.99, 9999.99),
      C_MKTSEGMENT: random.pick(MARKET_SEGMENTS),
      C_COMMENT: comment(random, 7),
    });
  }
  return rows;
}

interface OrderBuild {
  orders: SampleRow[];
  lineitems: SampleRow[];
}

function orderRows(random: Random): OrderBuild {
  const orders: SampleRow[] = [];
  const lineitems: SampleRow[] = [];

  for (let orderKey = 1; orderKey <= SAMPLE_SCALE.ORDERS; orderKey++) {
    const orderDate = random.int(CALENDAR_FIRST, CALENDAR_LAST - MAX_SHIP_LAG_DAYS);
    const lineCount = random.int(1, MAX_LINES_PER_ORDER);
    let totalPrice = 0;
    let anyOpen = false;

    for (let lineNumber = 1; lineNumber <= lineCount; lineNumber++) {
      const quantity = random.int(1, 50);
      const extendedPrice = random.money(901, 104_949.5);
      const shipDate = orderDate + random.int(1, MAX_SHIP_LAG_DAYS);
      const commitDate = orderDate + random.int(30, MAX_COMMIT_LAG_DAYS);
      const receiptDate = shipDate + random.int(1, MAX_RECEIPT_LAG_DAYS);
      const shipped = shipDate <= CALENDAR_LAST;
      if (!shipped) anyOpen = true;
      totalPrice += extendedPrice;

      lineitems.push({
        L_ORDERKEY: orderKey,
        L_PARTKEY: random.int(1, SAMPLE_SCALE.PART),
        L_SUPPKEY: random.int(1, SAMPLE_SCALE.SUPPLIER),
        L_LINENUMBER: lineNumber,
        L_QUANTITY: quantity,
        L_EXTENDEDPRICE: extendedPrice,
        L_DISCOUNT: random.int(0, 10) / 100,
        L_TAX: random.int(0, 8) / 100,
        L_RETURNFLAG: shipped ? random.pick(SHIPPED_FLAGS) : 'N',
        L_LINESTATUS: shipped ? 'F' : 'O',
        L_SHIPDATE: shipDate,
        L_COMMITDATE: commitDate,
        L_RECEIPTDATE: receiptDate,
        L_SHIPINSTRUCT: random.pick(SHIP_INSTRUCTIONS),
        L_SHIPMODE: random.pick(SHIP_MODES),
        L_COMMENT: comment(random, 4),
      });
    }

    orders.push({
      O_ORDERKEY: orderKey,
      O_CUSTKEY: random.int(1, SAMPLE_SCALE.CUSTOMER),
      O_ORDERSTATUS: anyOpen ? 'P' : 'F',
      O_TOTALPRICE: Math.round(totalPrice * 100) / 100,
      O_ORDERDATE: orderDate,
      O_ORDERPRIORITY: random.pick(ORDER_PRIORITIES),
      O_CLERK: padded('Clerk#', random.int(1, 100), 9),
      O_SHIPPRIORITY: 0,
      O_COMMENT: comment(random, 5),
    });
  }

  return { orders, lineitems };
}

export function buildSampleRows(): Record<string, SampleRow[]> {
  const random = randomOf(SEED);

  const suppliers = supplierRows(random);
  const parts = partRows(random);
  const partsupps = partsuppRows(random);
  const customers = customerRows(random);
  const { orders, lineitems } = orderRows(random);

  return {
    REGION: regionRows(),
    NATION: nationRows(),
    SUPPLIER: suppliers,
    PART: parts,
    PARTSUPP: partsupps,
    CUSTOMER: customers,
    ORDERS: orders,
    LINEITEM: lineitems,
  };
}
