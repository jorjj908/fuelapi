import Database from 'better-sqlite3';
import path from 'path';
import { StationInfo } from './fuelFinder';

const DEFAULT_DB = path.join(process.env.HOME ?? '.', 'fuel.db');

export interface PriceRecord {
  node_id: string;
  fuel_type: string;
  price_pence: number;
}

export class FuelDb {
  private db: Database.Database;

  constructor(dbPath = process.env.FUEL_DB_PATH ?? DEFAULT_DB) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stations (
        node_id TEXT PRIMARY KEY,
        trading_name TEXT,
        brand_name TEXT,
        postcode TEXT,
        city TEXT,
        address_line_1 TEXT,
        address_line_2 TEXT,
        latitude REAL,
        longitude REAL,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS prices (
        node_id TEXT NOT NULL,
        fuel_type TEXT NOT NULL,
        date TEXT NOT NULL,
        price_pence REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (node_id, fuel_type, date)
      );
      CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
      CREATE INDEX IF NOT EXISTS idx_prices_node_fuel ON prices(node_id, fuel_type);
    `);
  }

  upsertStations(stations: StationInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO stations (node_id, trading_name, brand_name, postcode, city,
                            address_line_1, address_line_2, latitude, longitude, updated_at)
      VALUES (@node_id, @trading_name, @brand_name, @postcode, @city,
              @address_line_1, @address_line_2, @latitude, @longitude, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        trading_name = excluded.trading_name,
        brand_name = excluded.brand_name,
        postcode = excluded.postcode,
        city = excluded.city,
        address_line_1 = excluded.address_line_1,
        address_line_2 = excluded.address_line_2,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    const tx = this.db.transaction((rows: StationInfo[]) => {
      for (const s of rows) {
        stmt.run({
          node_id: s.node_id,
          trading_name: s.trading_name ?? null,
          brand_name: s.brand_name ?? null,
          postcode: s.location?.postcode ?? null,
          city: s.location?.city ?? null,
          address_line_1: s.location?.address_line_1 ?? null,
          address_line_2: s.location?.address_line_2 ?? null,
          latitude: s.location?.latitude ?? null,
          longitude: s.location?.longitude ?? null,
          updated_at: now,
        });
      }
    });
    tx(stations);
  }

  recordPrices(records: PriceRecord[], date: string): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO prices (node_id, fuel_type, date, price_pence, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    let inserted = 0;
    const tx = this.db.transaction((rows: PriceRecord[]) => {
      for (const r of rows) {
        const res = stmt.run(r.node_id, r.fuel_type, date, r.price_pence, now);
        inserted += res.changes;
      }
    });
    tx(records);
    return inserted;
  }

  getPriceOn(nodeId: string, fuelType: string, date: string): number | null {
    const row = this.db
      .prepare('SELECT price_pence FROM prices WHERE node_id = ? AND fuel_type = ? AND date = ?')
      .get(nodeId, fuelType, date) as { price_pence: number } | undefined;
    return row?.price_pence ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function yesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
