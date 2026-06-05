import { DataType, dateToEpochDays, DECIMAL_SCALE } from '../../src/storage/data-type.js';
import { Table } from '../../src/storage/table.js';
import { createTPCHCatalog, TPCH_TABLES } from '../../src/catalog/tpch-schema.js';
import { TempDirectoryManager } from '../../src/storage/temp-directory-manager.js';

const SF = 0.01;

const REGIONS = ['AFRICA', 'AMERICA', 'ASIA', 'EUROPE', 'MIDDLE EAST'];

const NATIONS = [
  ['ALGERIA', 0], ['ARGENTINA', 1], ['BRAZIL', 1], ['CANADA', 1], ['EGYPT', 4],
  ['ETHIOPIA', 0], ['FRANCE', 3], ['GERMANY', 3], ['INDIA', 2], ['INDONESIA', 2],
  ['IRAN', 4], ['IRAQ', 4], ['JAPAN', 2], ['JORDAN', 4], ['KENYA', 0],
  ['MOROCCO', 0], ['MOZAMBIQUE', 0], ['PERU', 1], ['CHINA', 2], ['ROMANIA', 3],
  ['SAUDI ARABIA', 4], ['VIETNAM', 2], ['RUSSIA', 3], ['UNITED KINGDOM', 3],
  ['UNITED STATES', 1],
];

const SEGMENTS = ['AUTOMOBILE', 'BUILDING', 'FURNITURE', 'HOUSEHOLD', 'MACHINERY'];
const PRIORITIES = ['1-URGENT', '2-HIGH', '3-MEDIUM', '4-NOT SPECIFIED', '5-LOW'];
const SHIP_MODES = ['REG AIR', 'AIR', 'RAIL', 'SHIP', 'TRUCK', 'MAIL', 'FOB'];
const SHIP_INSTRUCT = ['DELIVER IN PERSON', 'COLLECT COD', 'NONE', 'TAKE BACK RETURN'];
const CONTAINERS = [];
const CONTAINER_SYL1 = ['SM', 'LG', 'MED', 'JUMBO', 'WRAP'];
const CONTAINER_SYL2 = ['CASE', 'BOX', 'BAG', 'JAR', 'PKG', 'PACK', 'CAN', 'DRUM'];
for (const s1 of CONTAINER_SYL1) for (const s2 of CONTAINER_SYL2) CONTAINERS.push(`${s1} ${s2}`);

const BRANDS = [];
for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) BRANDS.push(`Brand#${i}${j}`);

const TYPES_SYL1 = ['STANDARD', 'SMALL', 'MEDIUM', 'LARGE', 'ECONOMY', 'PROMO'];
const TYPES_SYL2 = ['ANODIZED', 'BURNISHED', 'PLATED', 'POLISHED', 'BRUSHED'];
const TYPES_SYL3 = ['TIN', 'NICKEL', 'BRASS', 'STEEL', 'COPPER'];

let _seed = 42;
function rand() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function randInt(min, max) { return min + Math.floor(rand() * (max - min + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }
function randDate(minYear, maxYear) {
  return dateToEpochDays(randInt(minYear, maxYear), randInt(1, 12), randInt(1, 28));
}
function randString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz ';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[randInt(0, chars.length - 1)];
  return s;
}
function randPhone() {
  const cc = randInt(10, 34);
  return `${cc}-${randInt(100, 999)}-${randInt(100, 999)}-${randInt(1000, 9999)}`;
}
function dec(val) {
  return BigInt(val);
}

export async function generateTPCHData() {
  _seed = 42;
  const catalog = createTPCHCatalog();
  const tempManager = new TempDirectoryManager();
  const tables = {};

  const regionTable = createTable('REGION', catalog, tempManager);
  const regionRows = REGIONS.map((name, i) => [i, name, randString(40)]);
  await regionTable.insertRows(regionRows);
  tables.REGION = regionTable;

  const nationTable = createTable('NATION', catalog, tempManager);
  const nationRows = NATIONS.map(([name, regionKey], i) => [i, name, regionKey, randString(60)]);
  await nationTable.insertRows(nationRows);
  tables.NATION = nationTable;

  const supplierCount = Math.max(10, Math.round(10000 * SF));
  const supplierTable = createTable('SUPPLIER', catalog, tempManager);
  const supplierRows = [];
  for (let i = 1; i <= supplierCount; i++) {
    supplierRows.push([
      i, `Supplier#${String(i).padStart(9, '0')}`, randString(25),
      randInt(0, 24), randPhone(), dec(randInt(-99999, 999999)), randString(60),
    ]);
  }
  await supplierTable.insertRows(supplierRows);
  tables.SUPPLIER = supplierTable;

  const partCount = Math.max(20, Math.round(200000 * SF));
  const partTable = createTable('PART', catalog, tempManager);
  const partRows = [];
  for (let i = 1; i <= partCount; i++) {
    partRows.push([
      i, `${pick(TYPES_SYL1).toLowerCase()} ${pick(TYPES_SYL3).toLowerCase()} ${pick(TYPES_SYL2).toLowerCase()} ${pick(TYPES_SYL1).toLowerCase()} ${pick(TYPES_SYL3).toLowerCase()}`,
      `Manufacturer#${randInt(1, 5)}`, pick(BRANDS),
      `${pick(TYPES_SYL1)} ${pick(TYPES_SYL2)} ${pick(TYPES_SYL3)}`,
      randInt(1, 50), pick(CONTAINERS), dec(randInt(100, 200000)), randString(20),
    ]);
  }
  await partTable.insertRows(partRows);
  tables.PART = partTable;

  const partsuppTable = createTable('PARTSUPP', catalog, tempManager);
  const partsuppRows = [];
  for (let p = 1; p <= partCount; p++) {
    for (let s = 0; s < 4; s++) {
      const suppKey = ((p + s * (Math.floor(supplierCount / 4) + Math.floor((p - 1) / supplierCount))) % supplierCount) + 1;
      partsuppRows.push([p, suppKey, randInt(1, 9999), dec(randInt(100, 100000)), randString(80)]);
    }
  }
  await partsuppTable.insertRows(partsuppRows);
  tables.PARTSUPP = partsuppTable;

  const customerCount = Math.max(15, Math.round(150000 * SF));
  const customerTable = createTable('CUSTOMER', catalog, tempManager);
  const customerRows = [];
  for (let i = 1; i <= customerCount; i++) {
    customerRows.push([
      i, `Customer#${String(i).padStart(9, '0')}`, randString(25),
      randInt(0, 24), randPhone(), dec(randInt(-99999, 999999)), pick(SEGMENTS), randString(60),
    ]);
  }
  await customerTable.insertRows(customerRows);
  tables.CUSTOMER = customerTable;

  const orderCount = Math.max(60, Math.round(1500000 * SF));
  const ordersTable = createTable('ORDERS', catalog, tempManager);
  const ordersRows = [];
  for (let i = 1; i <= orderCount; i++) {
    const custKey = (((i - 1) * 3) % customerCount) + 1;
    ordersRows.push([
      i, custKey, pick(['F', 'O', 'P']), dec(randInt(100000, 50000000)),
      randDate(1992, 1998), pick(PRIORITIES),
      `Clerk#${String(randInt(1, Math.max(1, Math.round(1000 * SF)))).padStart(9, '0')}`,
      randInt(0, 7), randString(40),
    ]);
  }
  await ordersTable.insertRows(ordersRows);
  tables.ORDERS = ordersTable;

  const lineitemTable = createTable('LINEITEM', catalog, tempManager);
  const lineitemRows = [];
  for (let o = 1; o <= orderCount; o++) {
    const lineCount = randInt(1, 7);
    for (let l = 1; l <= lineCount; l++) {
      const partKey = randInt(1, partCount);
      const suppIdx = randInt(0, 3);
      const suppKey = ((partKey + suppIdx * (Math.floor(supplierCount / 4))) % supplierCount) + 1;
      const quantity = dec(randInt(1, 50));
      const price = dec(randInt(90000, 200000));
      const discount = dec(randInt(0, 10));
      const tax = dec(randInt(0, 8));
      const shipDate = randDate(1992, 1998);
      const commitDate = shipDate + randInt(-30, 30);
      const receiptDate = shipDate + randInt(1, 30);

      lineitemRows.push([
        o, partKey, suppKey, l, quantity, price, discount, tax,
        pick(['A', 'R', 'N']), pick(['F', 'O']),
        shipDate, commitDate, receiptDate,
        pick(SHIP_INSTRUCT), pick(SHIP_MODES), randString(25),
      ]);
    }
  }
  await lineitemTable.insertRows(lineitemRows);
  tables.LINEITEM = lineitemTable;

  for (const [name, table] of Object.entries(tables)) {
    catalog.registerTableStorage(name, table);
  }

  return { catalog, tables, tempManager };
}

function createTable(name, catalog, tempManager) {
  const tableDef = catalog.getTable(name);
  const bufferPath = tempManager.allocate('buffer', name);
  return new Table(name, tableDef.columns, bufferPath);
}
