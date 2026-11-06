/**
 * ZIP → US county/state helper for the setup wizard service-area step.
 *
 * Uses a compact built-in table of common metro ZIPs plus a deterministic
 * fallback that never invents a county name when unknown: callers must
 * supply county+state explicitly when ZIP is not in the table.
 *
 * This is NOT a full USPS database. Unknown ZIPs return null.
 */

export interface ZipCounty {
  zip: string;
  county: string;
  state: string; // 2-letter
  city?: string;
}

/** Curated set covering demo + common roofing pilot metros. Expand via data files later. */
const ZIP_TABLE: Record<string, Omit<ZipCounty, 'zip'>> = {
  // Denver metro (demo SPC sample area)
  '80202': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80203': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80204': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80205': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80206': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80209': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80210': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80211': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80218': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80220': { county: 'Denver', state: 'CO', city: 'Denver' },
  '80014': { county: 'Arapahoe', state: 'CO', city: 'Aurora' },
  '80015': { county: 'Arapahoe', state: 'CO', city: 'Aurora' },
  '80016': { county: 'Arapahoe', state: 'CO', city: 'Aurora' },
  '80134': { county: 'Douglas', state: 'CO', city: 'Parker' },
  '80401': { county: 'Jefferson', state: 'CO', city: 'Golden' },
  // Dallas / Fort Worth
  '75201': { county: 'Dallas', state: 'TX', city: 'Dallas' },
  '75202': { county: 'Dallas', state: 'TX', city: 'Dallas' },
  '76001': { county: 'Tarrant', state: 'TX', city: 'Arlington' },
  // Phoenix
  '85001': { county: 'Maricopa', state: 'AZ', city: 'Phoenix' },
  '85003': { county: 'Maricopa', state: 'AZ', city: 'Phoenix' },
  // Atlanta
  '30301': { county: 'Fulton', state: 'GA', city: 'Atlanta' },
  '30303': { county: 'Fulton', state: 'GA', city: 'Atlanta' },
  // Chicago
  '60601': { county: 'Cook', state: 'IL', city: 'Chicago' },
  '60602': { county: 'Cook', state: 'IL', city: 'Chicago' },
  // Houston
  '77001': { county: 'Harris', state: 'TX', city: 'Houston' },
  '77002': { county: 'Harris', state: 'TX', city: 'Houston' },
  // Miami
  '33101': { county: 'Miami-Dade', state: 'FL', city: 'Miami' },
  '33130': { county: 'Miami-Dade', state: 'FL', city: 'Miami' },
  // Oklahoma City (hail alley)
  '73101': { county: 'Oklahoma', state: 'OK', city: 'Oklahoma City' },
  '73102': { county: 'Oklahoma', state: 'OK', city: 'Oklahoma City' },
  // Kansas City
  '64101': { county: 'Jackson', state: 'MO', city: 'Kansas City' },
  '64108': { county: 'Jackson', state: 'MO', city: 'Kansas City' },
  // Minneapolis
  '55401': { county: 'Hennepin', state: 'MN', city: 'Minneapolis' },
  // NYC (generic SMB)
  '10001': { county: 'New York', state: 'NY', city: 'New York' },
  '10002': { county: 'New York', state: 'NY', city: 'New York' },
  // LA
  '90001': { county: 'Los Angeles', state: 'CA', city: 'Los Angeles' },
  '90012': { county: 'Los Angeles', state: 'CA', city: 'Los Angeles' },
};

export function normalizeZip(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

/** Lookup a 5-digit ZIP. Returns null when unknown — never fabricates a county. */
export function lookupZip(zipInput: string): ZipCounty | null {
  const zip = normalizeZip(zipInput);
  if (!zip) return null;
  const row = ZIP_TABLE[zip];
  if (!row) return null;
  return { zip, ...row };
}

export function knownZipCount(): number {
  return Object.keys(ZIP_TABLE).length;
}
