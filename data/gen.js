import { writeFileSync } from 'fs';

const SEED = 42;
let state = SEED;
function rng() {
  state = (state * 1103515245 + 12345) & 0x7fffffff;
  return state / 0x7fffffff;
}
function randInt(lo, hi) { return lo + Math.floor(rng() * (hi - lo)); }
function pick(arr) { return arr[randInt(0, arr.length)]; }
function randDate(startYear, endYear) {
  const y = randInt(startYear, endYear);
  const m = String(randInt(1, 13)).padStart(2, '0');
  const d = String(randInt(1, 29)).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DEPARTMENTS = ['Engineering', 'Sales', 'Marketing', 'Finance', 'HR', 'Operations', 'Legal', 'Support'];
const CITIES = ['New York', 'San Francisco', 'Chicago', 'Austin', 'Seattle', 'Boston', 'Denver', 'Miami', 'Portland', 'Atlanta'];
const FIRST = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Hank', 'Ivy', 'Jack', 'Kate', 'Leo', 'Mia', 'Nick', 'Olivia', 'Pete', 'Quinn', 'Rosa', 'Sam', 'Tina'];
const LAST = ['Smith', 'Johnson', 'Lee', 'Brown', 'Davis', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Garcia', 'Martinez', 'Clark', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Hill', 'Scott'];
const CATEGORIES = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys', 'Sports', 'Home', 'Garden', 'Auto', 'Health'];
const STATUSES = ['pending', 'shipped', 'delivered', 'returned', 'cancelled'];
const PRODUCTS = [
  'Laptop', 'Phone', 'Tablet', 'Monitor', 'Keyboard', 'Mouse', 'Headphones', 'Speaker', 'Camera', 'Watch',
  'Shirt', 'Pants', 'Shoes', 'Jacket', 'Hat', 'Socks', 'Belt', 'Scarf', 'Gloves', 'Bag',
  'Rice', 'Pasta', 'Bread', 'Cheese', 'Milk', 'Eggs', 'Chicken', 'Beef', 'Fish', 'Apples',
  'Novel', 'Textbook', 'Comic', 'Manual', 'Guide', 'Atlas', 'Dictionary', 'Cookbook', 'Journal', 'Planner',
];

function csv(headers, rows) {
  return [headers.join(','), ...rows.map(r => r.map(v => {
    const s = String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','))].join('\n') + '\n';
}

// employees.csv — 500 rows
const employees = [];
for (let i = 1; i <= 500; i++) {
  const dept = pick(DEPARTMENTS);
  const city = pick(CITIES);
  const salary = randInt(40, 200) * 1000;
  const bonus = Math.round(salary * (rng() * 0.2) * 100) / 100;
  const hireDate = randDate(2010, 2025);
  const age = randInt(22, 65);
  const rating = Math.round((1 + rng() * 4) * 10) / 10;
  employees.push([i, `${pick(FIRST)} ${pick(LAST)}`, dept, city, salary, bonus, hireDate, age, rating]);
}
writeFileSync('data/employees.csv', csv(
  ['id', 'name', 'department', 'city', 'salary', 'bonus', 'hire_date', 'age', 'rating'],
  employees
));

// products.csv — 200 rows
const products = [];
for (let i = 1; i <= 200; i++) {
  const name = pick(PRODUCTS);
  const cat = pick(CATEGORIES);
  const price = Math.round((5 + rng() * 995) * 100) / 100;
  const cost = Math.round(price * (0.3 + rng() * 0.4) * 100) / 100;
  const stock = randInt(0, 5000);
  const weight = Math.round((0.1 + rng() * 50) * 100) / 100;
  const active = rng() > 0.1 ? 1 : 0;
  products.push([i, name, cat, price, cost, stock, weight, active]);
}
writeFileSync('data/products.csv', csv(
  ['id', 'name', 'category', 'price', 'cost', 'stock', 'weight_kg', 'active'],
  products
));

// orders.csv — 10000 rows
const orders = [];
for (let i = 1; i <= 10000; i++) {
  const customerId = randInt(1, 2001);
  const productId = randInt(1, 201);
  const qty = randInt(1, 20);
  const prod = products[productId - 1];
  const unitPrice = prod[3];
  const total = Math.round(qty * unitPrice * 100) / 100;
  const discount = rng() > 0.7 ? Math.round(rng() * 30 * 100) / 100 : 0;
  const status = pick(STATUSES);
  const orderDate = randDate(2022, 2026);
  orders.push([i, customerId, productId, qty, unitPrice, discount, total, status, orderDate]);
}
writeFileSync('data/orders.csv', csv(
  ['id', 'customer_id', 'product_id', 'quantity', 'unit_price', 'discount', 'total', 'status', 'order_date'],
  orders
));

// customers.csv — 2000 rows
const COUNTRIES = ['US', 'UK', 'CA', 'DE', 'FR', 'JP', 'AU', 'BR', 'IN', 'MX'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum'];
const customers = [];
for (let i = 1; i <= 2000; i++) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const email = `${name.toLowerCase().replace(' ', '.')}${i}@example.com`;
  const country = pick(COUNTRIES);
  const city = pick(CITIES);
  const tier = pick(TIERS);
  const signupDate = randDate(2018, 2026);
  const totalSpent = Math.round(rng() * 50000 * 100) / 100;
  customers.push([i, name, email, country, city, tier, signupDate, totalSpent]);
}
writeFileSync('data/customers.csv', csv(
  ['id', 'name', 'email', 'country', 'city', 'tier', 'signup_date', 'total_spent'],
  customers
));

// metrics.csv — 50000 rows (for parallel perf testing)
const metrics = [];
for (let i = 1; i <= 50000; i++) {
  const sensorId = randInt(1, 101);
  const ts = `2025-${String(randInt(1, 13)).padStart(2, '0')}-${String(randInt(1, 29)).padStart(2, '0')} ${String(randInt(0, 24)).padStart(2, '0')}:${String(randInt(0, 60)).padStart(2, '0')}:${String(randInt(0, 60)).padStart(2, '0')}`;
  const value = Math.round((rng() * 1000 - 200) * 1000) / 1000;
  const quality = randInt(0, 101);
  const flag = rng() > 0.95 ? 1 : 0;
  metrics.push([i, sensorId, ts, value, quality, flag]);
}
writeFileSync('data/metrics.csv', csv(
  ['id', 'sensor_id', 'timestamp', 'value', 'quality', 'flag'],
  metrics
));

console.log('employees.csv  — 500 rows');
console.log('products.csv   — 200 rows');
console.log('orders.csv     — 10,000 rows');
console.log('customers.csv  — 2,000 rows');
console.log('metrics.csv    — 50,000 rows');
