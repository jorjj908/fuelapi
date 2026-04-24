import { Resend } from 'resend';

export interface RankedStation {
  trading_name: string;
  brand?: string;
  address: string;
  postcode?: string;
  distance_miles: number;
  price_pence: number;
  price_last_updated?: string;
  delta_pence?: number | null;
}

export async function sendFuelEmail(opts: {
  apiKey: string;
  from: string;
  to: string;
  cheapestByFuel: Record<string, RankedStation[]>;
  generatedAt: Date;
}): Promise<void> {
  const resend = new Resend(opts.apiKey);
  const { error } = await resend.emails.send({
    from: opts.from,
    to: opts.to,
    subject: buildSubject(opts.cheapestByFuel),
    html: renderHtml(opts.cheapestByFuel, opts.generatedAt),
  });
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
}

function buildSubject(byFuel: Record<string, RankedStation[]>): string {
  const e10 = byFuel['E10']?.[0];
  if (e10) return `Cheapest petrol near Hull: ${e10.price_pence.toFixed(1)}p at ${e10.trading_name}`;
  return 'Cheapest petrol near Hull';
}

const FUEL_LABELS: Record<string, string> = {
  E10: 'E10 (unleaded)',
  E5: 'E5 (super unleaded)',
  B7_STANDARD: 'Diesel (B7 standard)',
};

function renderHtml(byFuel: Record<string, RankedStation[]>, at: Date): string {
  const sections = Object.entries(byFuel)
    .map(([fuel, rows]) => {
      const label = FUEL_LABELS[fuel] ?? fuel;
      if (!rows.length) return `<h3>${escape(label)}</h3><p>No data within 15 miles.</p>`;
      const tr = rows
        .map(
          (r, i) => `
            <tr>
              <td align="right">${i + 1}</td>
              <td>${escape(r.trading_name)}${r.brand ? ` <span style="color:#666">(${escape(r.brand)})</span>` : ''}</td>
              <td>${escape(r.address)}${r.postcode ? `, ${escape(r.postcode)}` : ''}</td>
              <td align="right">${r.distance_miles.toFixed(1)} mi</td>
              <td align="right"><b>${r.price_pence.toFixed(1)}p</b>${renderDelta(r.delta_pence)}</td>
            </tr>`,
        )
        .join('');
      return `
        <h3>${escape(label)}</h3>
        <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd;font-size:14px">
          <thead>
            <tr style="background:#f5f5f5">
              <th>#</th><th align="left">Station</th><th align="left">Address</th><th>Distance</th><th>Price</th>
            </tr>
          </thead>
          <tbody>${tr}</tbody>
        </table>`;
    })
    .join('');
  return `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:720px">
      <h2 style="margin-bottom:4px">Cheapest fuel within 15 miles of Hull</h2>
      <p style="color:#666;margin-top:0">Generated ${at.toISOString()}</p>
      ${sections}
      <p style="color:#999;font-size:12px;margin-top:24px">Data: UK Gov Fuel Finder PFS feed.</p>
    </div>`;
}

function renderDelta(delta: number | null | undefined): string {
  if (delta == null) return '';
  if (Math.abs(delta) < 0.05) return ` <span style="color:#888;font-size:12px">(=)</span>`;
  if (delta > 0) return ` <span style="color:#c00;font-size:12px">(↑ ${delta.toFixed(1)}p)</span>`;
  return ` <span style="color:#0a7c3c;font-size:12px">(↓ ${Math.abs(delta).toFixed(1)}p)</span>`;
}

function escape(s: string | undefined): string {
  return (s ?? '').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}
