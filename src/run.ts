import {
  fetchAllStationInfo,
  fetchAllStationPrices,
  getAccessToken,
  StationInfo,
} from './fuelFinder';
import { HULL_LAT, HULL_LON, haversineMiles } from './filter';
import { RankedStation, sendFuelEmail } from './email';
import { FuelDb, PriceRecord, todayIso, yesterdayIso } from './db';

const RADIUS_MILES = 15;
const FUELS_TO_REPORT = ['E10', 'E5', 'B7_STANDARD'] as const;
const TOP_N = 5;

interface Nearby {
  info: StationInfo;
  distance_miles: number;
}

async function main(): Promise<void> {
  const clientId = requireEnv('FUEL_CLIENT_ID');
  const clientSecret = requireEnv('FUEL_CLIENT_SECRET');
  const resendKey = requireEnv('RESEND_API_KEY');
  const mailFrom = requireEnv('MAIL_FROM');
  const mailTo = requireEnv('MAIL_TO');

  console.log('Requesting access token');
  const token = await getAccessToken(clientId, clientSecret);

  console.log('Fetching PFS info');
  const info = await fetchAllStationInfo(token);
  console.log('Fetching PFS prices');
  const prices = await fetchAllStationPrices(token);
  console.log(`Fetched ${info.length} forecourts, ${prices.length} price records`);

  const db = new FuelDb();
  try {
    db.upsertStations(info);
    const today = todayIso();
    const yesterday = yesterdayIso();

    const allPriceRows: PriceRecord[] = [];
    for (const rec of prices) {
      for (const fp of rec.fuel_prices ?? []) {
        if (typeof fp.price === 'number') {
          allPriceRows.push({
            node_id: rec.node_id,
            fuel_type: fp.fuel_type,
            price_pence: fp.price,
          });
        }
      }
    }
    const inserted = db.recordPrices(allPriceRows, today);
    console.log(`DB: upserted ${info.length} stations, recorded ${inserted} new price rows for ${today}`);

    const nearby = filterNearby(info);
    console.log(`${nearby.size} open forecourts within ${RADIUS_MILES} mi of Hull`);

    const priceByNode = new Map(prices.map((p) => [p.node_id, p]));

    const cheapestByFuel: Record<string, RankedStation[]> = {};
    for (const fuel of FUELS_TO_REPORT) {
      const rows: RankedStation[] = [];
      for (const { info: station, distance_miles } of nearby.values()) {
        const priceRec = priceByNode.get(station.node_id);
        const fp = priceRec?.fuel_prices?.find((x) => x.fuel_type === fuel);
        if (!fp || typeof fp.price !== 'number') continue;
        const yPrice = db.getPriceOn(station.node_id, fuel, yesterday);
        rows.push({
          trading_name: priceRec?.trading_name ?? station.trading_name,
          brand: station.brand_name,
          address: [
            station.location.address_line_1,
            station.location.address_line_2,
            station.location.city,
          ]
            .filter(Boolean)
            .join(', '),
          postcode: station.location.postcode,
          distance_miles,
          price_pence: fp.price,
          price_last_updated: fp.price_last_updated,
          delta_pence: yPrice != null ? fp.price - yPrice : null,
        });
      }
      rows.sort((a, b) => a.price_pence - b.price_pence);
      cheapestByFuel[fuel] = rows.slice(0, TOP_N);
    }

    await sendFuelEmail({
      apiKey: resendKey,
      from: mailFrom,
      to: mailTo,
      cheapestByFuel,
      generatedAt: new Date(),
    });
    console.log('Email sent');
  } finally {
    db.close();
  }
}

function filterNearby(info: StationInfo[]): Map<string, Nearby> {
  const out = new Map<string, Nearby>();
  for (const s of info) {
    if (s.permanent_closure || s.temporary_closure) continue;
    const { latitude, longitude } = s.location ?? {};
    if (typeof latitude !== 'number' || typeof longitude !== 'number') continue;
    const d = haversineMiles(HULL_LAT, HULL_LON, latitude, longitude);
    if (d <= RADIUS_MILES) out.set(s.node_id, { info: s, distance_miles: d });
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
