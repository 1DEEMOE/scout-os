/**
 * Auto column mapping for CSV lead import during onboarding.
 * Preview-only helper — never writes without an explicit import call.
 */

export type LeadField =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'addressLine1'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'county'
  | 'notes'
  | 'ignore';

const ALIASES: Record<Exclude<LeadField, 'ignore'>, string[]> = {
  fullName: [
    'fullname', 'full_name', 'full name', 'name', 'contact', 'contact_name',
    'contact name', 'owner', 'owner_name', 'homeowner', 'customer', 'customer_name',
  ],
  email: ['email', 'e-mail', 'email_address', 'email address', 'mail'],
  phone: ['phone', 'phone_number', 'phone number', 'mobile', 'cell', 'telephone', 'tel'],
  addressLine1: [
    'address', 'address1', 'address_line1', 'address line 1', 'street',
    'street_address', 'street address', 'addr',
  ],
  city: ['city', 'town'],
  state: ['state', 'st', 'province', 'region'],
  postalCode: ['zip', 'zipcode', 'zip_code', 'zip code', 'postal', 'postal_code', 'postal code'],
  county: ['county', 'parish'],
  notes: ['notes', 'note', 'comment', 'comments', 'memo', 'description'],
};

function norm(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function matchField(header: string): LeadField {
  const n = norm(header);
  const spaced = header.trim().toLowerCase();
  for (const [field, aliases] of Object.entries(ALIASES) as Array<[Exclude<LeadField, 'ignore'>, string[]]>) {
    for (const a of aliases) {
      const an = a.replace(/[\s-]+/g, '_');
      if (n === an || spaced === a) return field;
    }
  }
  return 'ignore';
}

export interface CsvMappingResult {
  headers: string[];
  mapping: Record<string, LeadField>; // header → field
  /** Fields that got a non-ignore mapping. */
  mappedFields: LeadField[];
  missingRequired: LeadField[];
  previewRows: Array<Record<string, string>>;
  rowCount: number;
}

const REQUIRED: LeadField[] = ['fullName'];

/**
 * Parse a small CSV string (header + rows) and propose a column mapping.
 * Does not call the database. Caps preview at `previewLimit` rows.
 */
export function proposeCsvMapping(
  csvText: string,
  opts: { previewLimit?: number } = {},
): CsvMappingResult {
  const previewLimit = opts.previewLimit ?? 5;
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      headers: [],
      mapping: {},
      mappedFields: [],
      missingRequired: [...REQUIRED],
      previewRows: [],
      rowCount: 0,
    };
  }

  const headers = splitCsvLine(lines[0]!);
  const mapping: Record<string, LeadField> = {};
  const used = new Set<LeadField>();
  for (const h of headers) {
    let field = matchField(h);
    // First-wins: don't map two columns to the same field.
    if (field !== 'ignore' && used.has(field)) field = 'ignore';
    if (field !== 'ignore') used.add(field);
    mapping[h] = field;
  }

  const dataLines = lines.slice(1);
  const previewRows: Array<Record<string, string>> = [];
  for (const line of dataLines.slice(0, previewLimit)) {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? '').trim();
    });
    previewRows.push(row);
  }

  const mappedFields = [...used];
  const missingRequired = REQUIRED.filter((f) => !used.has(f));

  return {
    headers,
    mapping,
    mappedFields,
    missingRequired,
    previewRows,
    rowCount: dataLines.length,
  };
}

/** Apply a confirmed mapping to produce import-shaped rows (fullName required). */
export function applyCsvMapping(
  csvText: string,
  mapping: Record<string, LeadField>,
): Array<{
  fullName: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  county: string | null;
  notes: string | null;
}> {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  const out: Array<{
    fullName: string;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    county: string | null;
    notes: string | null;
  }> = [];

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const bucket: Partial<Record<LeadField, string>> = {};
    headers.forEach((h, i) => {
      const field = mapping[h] ?? 'ignore';
      if (field === 'ignore') return;
      const v = (cols[i] ?? '').trim();
      if (v) bucket[field] = v;
    });
    const fullName = (bucket.fullName ?? '').trim();
    if (!fullName) continue;
    out.push({
      fullName,
      email: bucket.email ?? null,
      phone: bucket.phone ?? null,
      addressLine1: bucket.addressLine1 ?? null,
      city: bucket.city ?? null,
      state: bucket.state ?? null,
      postalCode: bucket.postalCode ?? null,
      county: bucket.county ?? null,
      notes: bucket.notes ?? null,
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
