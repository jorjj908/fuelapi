const TOKEN_URL = 'https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token';
const INFO_URL = 'https://www.fuel-finder.service.gov.uk/api/v1/pfs';
const PRICES_URL = 'https://www.fuel-finder.service.gov.uk/api/v1/pfs/fuel-prices';

const MAX_BATCHES = 100;

export interface FuelPrice {
  fuel_type: string;
  price: number;
  price_last_updated?: string;
  price_change_effective_timestamp?: string;
}

export interface StationPrices {
  node_id: string;
  trading_name: string;
  public_phone_number?: string | null;
  fuel_prices: FuelPrice[];
}

export interface StationInfo {
  node_id: string;
  trading_name: string;
  brand_name?: string;
  temporary_closure?: boolean;
  permanent_closure?: boolean;
  is_motorway_service_station?: boolean;
  is_supermarket_service_station?: boolean;
  location: {
    address_line_1?: string;
    address_line_2?: string;
    city?: string;
    country?: string;
    county?: string;
    postcode?: string;
    latitude: number;
    longitude: number;
  };
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'fuelfinder.read',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error('Token response missing access_token');
  return data.access_token;
}

async function fetchAllBatches<T>(baseUrl: string, token: string): Promise<T[]> {
  const out: T[] = [];
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const res = await fetch(`${baseUrl}?batch-number=${batch}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Batch ${batch} from ${baseUrl} failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as T[];
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
  }
  return out;
}

export function fetchAllStationInfo(token: string): Promise<StationInfo[]> {
  return fetchAllBatches<StationInfo>(INFO_URL, token);
}

export function fetchAllStationPrices(token: string): Promise<StationPrices[]> {
  return fetchAllBatches<StationPrices>(PRICES_URL, token);
}
