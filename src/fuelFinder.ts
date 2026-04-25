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
  success: boolean;
  data?: {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  };
  message?: string;
}

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'hull-fuel-daily/1.0',
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    const headerSummary = ['content-type', 'server', 'cf-ray', 'x-amz-cf-id', 'www-authenticate']
      .map((h) => `${h}=${res.headers.get(h) ?? ''}`)
      .join(' ');
    throw new Error(
      `Token request failed: ${res.status} ${res.statusText} | headers: ${headerSummary} | body: ${text.slice(0, 500)}`,
    );
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Token response was not JSON: ${text.slice(0, 500)}`);
  }
  const token = body.data?.access_token;
  if (!token) throw new Error(`Token response missing access_token: ${text.slice(0, 500)}`);
  return token;
}

const BATCH_TIMEOUT_MS = 90_000;
const BATCH_RETRIES = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

async function fetchBatch(url: string, token: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BATCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (RETRYABLE_STATUS.has(res.status) && attempt < BATCH_RETRIES) {
        const backoff = 5000 * (attempt + 1);
        console.log(`  ${res.status} from API, retrying in ${backoff}ms (attempt ${attempt + 1}/${BATCH_RETRIES})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status)) {
        throw new ApiUnavailableError(`API returned ${res.status} after ${BATCH_RETRIES} retries`);
      }
      return res;
    } catch (err) {
      if (err instanceof ApiUnavailableError) throw err;
      lastErr = err;
      if (attempt < BATCH_RETRIES) {
        const backoff = 5000 * (attempt + 1);
        console.log(`  fetch failed (${(err as Error).message}), retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchAllBatches<T>(baseUrl: string, token: string, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const res = await fetchBatch(`${baseUrl}?batch-number=${batch}`, token);
    if (res.status === 404) {
      console.log(`[${label}] finished at batch ${batch - 1} (${out.length} records)`);
      break;
    }
    if (!res.ok) {
      throw new Error(`[${label}] batch ${batch} failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as T[];
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (batch % 5 === 0) console.log(`[${label}] batch ${batch} done (${out.length} records so far)`);
  }
  return out;
}

export function fetchAllStationInfo(token: string): Promise<StationInfo[]> {
  return fetchAllBatches<StationInfo>(INFO_URL, token, 'info');
}

export function fetchAllStationPrices(token: string): Promise<StationPrices[]> {
  return fetchAllBatches<StationPrices>(PRICES_URL, token, 'prices');
}
