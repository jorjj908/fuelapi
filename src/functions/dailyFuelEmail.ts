import { app, InvocationContext, Timer } from '@azure/functions';
import {
  fetchAllStationInfo,
  fetchAllStationPrices,
  getAccessToken,
  StationInfo,
} from '../fuelFinder';
import { HULL_LAT, HULL_LON, haversineMiles } from '../filter';
import { RankedStation, sendFuelEmail } from '../email';

const RADIUS_MILES = 15;
const FUELS_TO_REPORT = ['E10', 'E5', 'B7_Standard'] as const;
const TOP_N = 5;

interface Nearby {
  info: StationInfo;
  distance_miles: number;
}

export async function dailyFuelEmail(_timer: Timer, context: InvocationContext): Promise<void> {
  const clientId = requireEnv('FUEL_CLIENT_ID');
  const clientSecret = requireEnv('FUEL_CLIENT_SECRET');
  const resendKey = requireEnv('RESEND_API_KEY');
  const mailFrom = requireEnv('MAIL_FROM');
  const mailTo = requireEnv('MAIL_TO');

  context.log('Requesting access token');
  const token = await getAccessToken(clientId, clientSecret);

  context.log('Fetching PFS info + prices');
  const [info, prices] = await Promise.all([
    fetchAllStationInfo(token),
    fetchAllStationPrices(token),
  ]);
  context.log(`Fetched ${info.length} forecourts, ${prices.length} price records`);

  const nearby = filterNearby(info);
  context.log(`${nearby.size} open forecourts within ${RADIUS_MILES} mi of Hull`);

  const priceByNode = new Map(prices.map((p) => [p.node_id, p]));

  const cheapestByFuel: Record<string, RankedStation[]> = {};
  for (const fuel of FUELS_TO_REPORT) {
    const rows: RankedStation[] = [];
    for (const { info: station, distance_miles } of nearby.values()) {
      const priceRec = priceByNode.get(station.node_id);
      const fp = priceRec?.fuel_prices?.find((x) => x.fuel_type === fuel);
      if (!fp || typeof fp.price !== 'number') continue;
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
  context.log('Email sent');
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

app.timer('dailyFuelEmail', {
  schedule: '0 0 7 * * *',
  handler: dailyFuelEmail,
  runOnStartup: false,
});
