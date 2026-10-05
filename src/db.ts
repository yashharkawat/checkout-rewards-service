import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Prices in paise. "limited-poster" is the deliberately scarce product.
const SEED_PRODUCTS = [
  { id: 'tshirt', name: 'Cotton T-Shirt', unitPriceMinor: 79900, stock: 100 },
  { id: 'hoodie', name: 'Zip Hoodie', unitPriceMinor: 199900, stock: 50 },
  { id: 'mug', name: 'Ceramic Mug', unitPriceMinor: 34900, stock: 200 },
  { id: 'notebook', name: 'Dotted Notebook', unitPriceMinor: 24999, stock: 150 },
  { id: 'sticker-pack', name: 'Sticker Pack', unitPriceMinor: 9900, stock: 500 },
  { id: 'limited-poster', name: 'Limited Edition Poster', unitPriceMinor: 149900, stock: 3 },
];

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // busy_timeout first: the other pragmas and the schema can themselves hit a lock
  // when several processes open the same file at once.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  write(db, () => {
    db.exec(SCHEMA);
    // OR IGNORE: a restart must not reset stock or prices that have since changed.
    const insert = db.prepare(
      'INSERT OR IGNORE INTO products (id, name, unit_price_minor, stock) VALUES (?, ?, ?, ?)',
    );
    for (const p of SEED_PRODUCTS) insert.run(p.id, p.name, p.unitPriceMinor, p.stock);
  });
  return db;
}

/**
 * Run fn in a write transaction. Throwing inside fn rolls everything back.
 *
 * BEGIN IMMEDIATE takes SQLite's write lock up front. A plain (deferred) BEGIN
 * that reads and then writes can fail with SQLITE_BUSY_SNAPSHOT when another
 * process commits in between, and busy_timeout does not retry that case.
 */
export function write<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/** Run fn in a read transaction so several SELECTs see one snapshot. */
export function read<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).deferred();
}
