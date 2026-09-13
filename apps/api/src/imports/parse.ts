import { unzip } from './zip';
import { invalid } from '../shared/errors';

export type Day = {
  day: string;
  pageviews: number;
  visitors: number;
  custom: number;
};

export type Breakdown = {
  day: string;
  dimension: string;
  value: string;
  count: number;
};

export function csv(text: string): string[][];

export function csv(text: string, visit: (row: string[]) => void): void;

export function csv(text: string, visit?: (row: string[]) => void) {
  const rows: string[][] = [];

  let row: string[] = [],
    field = '',
    state: 'start' | 'bare' | 'quoted' | 'closed' = 'start',
    comment = false;

  const finishField = () => {
    if (field.length > 4096 || field.includes('\0')) throw invalid('Invalid CSV field.');
    row.push(field);
    field = '';
    state = 'start';
    if (row.length > 64) throw invalid('Too many CSV columns.');
  };

  const finishRow = () => {
    finishField();

    if (row.some((s) => s.trim())) {
      if (visit) visit(row);
      else rows.push(row);
      records++;
    }

    row = [];
    if (records > 100001) throw invalid('An import may contain at most 100,000 CSV records.');
  };

  let records = 0;

  for (const char of text.replace(/^\uFEFF/, '')) {
    if (comment) {
      if (char === '\n' || char === '\r') comment = false;
      continue;
    }

    if (state === 'start' && !row.length && !field && char === '#') {
      comment = true;
      continue;
    }

    if (state === 'quoted') {
      if (char === '"') state = 'closed';
      else field += char;
      continue;
    }

    if (state === 'closed' && char === '"') {
      field += '"';
      state = 'quoted';
      continue;
    }

    if (char === ',') {
      finishField();
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (row.length || field || state === 'closed') finishRow();
      continue;
    }

    if (state === 'closed') throw invalid('The CSV contains malformed quotes.');

    if (char === '"') {
      if (state !== 'start') throw invalid('The CSV contains malformed quotes.');
      state = 'quoted';
      continue;
    }

    state = 'bare';
    field += char;
  }

  if (state === 'quoted') throw invalid('The CSV contains malformed quotes.');
  if (row.length || field || state === 'closed') finishRow();

  if (!visit) return rows;
}

function number(value: string) {
  if (!/^\d+$/.test(value.trim()) || Number(value) > 1e12)
    throw invalid('Imported counts must be whole numbers between 0 and 1 trillion.');

  return Number(value);
}

function day(value: string, compact = false) {
  value = value.trim();
  if (compact && /^\d{8}$/.test(value))
    value = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw invalid('Every imported row must have a complete calendar date.');

  return value;
}

function label(dimension: string, value: string) {
  value = value.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters at the privacy boundary.
  if (value.length > 2048 || /[\x00-\x1f\x7f]/.test(value))
    throw invalid('Invalid imported label.');
  if (dimension === 'path') {
    value = /^https?:/.test(value) ? new URL(value).pathname : value.split(/[?#]/)[0]!;
    if (value && !value.startsWith('/')) throw invalid('Imported paths must start with /.');
  } else if (dimension === 'referrer' && value) {
    const u = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(u.protocol)) throw invalid('Invalid referrer URL.');
    value = u.hostname;
  } else if (dimension === 'country') {
    if (value && !/^[a-z]{2}$/i.test(value)) throw invalid('Countries must be two-letter codes.');
    value = value.toUpperCase();
  } else if (dimension === 'device')
    value = value.toLowerCase() === 'laptop' ? 'desktop' : value.toLowerCase();

  return value;
}

export function parse(provider: string, filename: string, bytes: Uint8Array) {
  if (!['plausible', 'ga4'].includes(provider))
    throw invalid('Choose Plausible or Google Analytics 4.');
  if (bytes.length > 10 * 1024 * 1024 || !bytes.length)
    throw invalid('Upload a file no larger than 10 MB.');
  let files: Record<string, Uint8Array>;
  if (/\.zip$/i.test(filename)) {
    if (provider !== 'plausible') throw invalid('Upload a GA4 CSV file.');
    files = unzip(bytes);
  } else files = { [filename]: bytes };

  const days = new Map<string, Day>(),
    breakdowns = new Map<string, Map<string, Breakdown>>(),
    custom = new Map<string, number>(),
    calendarDays = new Map<string, string>(),
    tables = new Set<string>(),
    warnings = new Set<string>();

  let records = 0;

  for (const [name, data] of Object.entries(files)) {
    if (!/\.csv$/i.test(name)) {
      warnings.add(`Ignored unsupported file: ${name}.`);
      continue;
    }

    let header: string[] | undefined,
      columns: string[] = [],
      match: RegExpExecArray | null,
      table = '',
      dimension: string[] | undefined,
      di = -1,
      ci = -1,
      vi = -1,
      li = -1,
      ignored = false;

    csv(new TextDecoder('utf-8', { fatal: true }).decode(data), (row) => {
      if (!header) {
        header = row;

        const normalized = header.map((s) =>
          provider === 'ga4' ? s.toLowerCase().replace(/[\s_]/g, '') : s.trim(),
        );

        if (new Set(normalized).size !== normalized.length || normalized.some((s) => !s))
          throw invalid('CSV column names must be nonempty and unique.');
        columns =
          provider === 'ga4'
            ? normalized.map((s) => (s === 'screenpageviews' ? 'views' : s))
            : normalized;
        if (
          provider === 'ga4' &&
          (columns.some((s) => !['date', 'views', 'totalusers'].includes(s)) ||
            columns.length !== 3)
        )
          throw invalid('The GA4 CSV must contain only Date, Views and Total users.');

        match =
          /(?:^|\/)imported_(visitors|pages|sources|devices|locations|custom_events)(?:_(\d{8})_(\d{8}))?\.csv$/i.exec(
            name,
          );

        if (provider === 'plausible' && !match) {
          if (/(?:^|\/)(visitors|pages|sources|devices|locations)(?:_|\.)/i.test(name))
            throw invalid(
              'Upload imported_visitors.csv or the full Plausible export ZIP from site settings. Dashboard exports are not supported.',
            );
          warnings.add(`Ignored unsupported file: ${name}.`);
          ignored = true;

          return;
        }

        table = provider === 'ga4' ? 'visitors' : match![1]!;
        if (tables.has(table)) throw invalid('Only one CSV per report is allowed.');
        tables.add(table);
        dimension = {
          pages: ['path', 'page'],
          sources: ['referrer', 'referrer'],
          devices: ['device', 'device'],
          locations: ['country', 'country'],
          custom_events: ['event', 'name'],
        }[table];

        const required = (key: string) => {
          const index = columns.indexOf(key);
          if (index < 0) throw invalid(`The CSV is missing its ${key} column.`);

          return index;
        };

        di = required('date');
        ci = required(
          provider === 'ga4' ? 'views' : table === 'custom_events' ? 'events' : 'pageviews',
        );
        vi = table === 'visitors' ? required(provider === 'ga4' ? 'totalusers' : 'visitors') : -1;
        li = dimension ? required(dimension[1]!) : -1;

        return;
      }

      records++;
      if (records > 100000) throw invalid('An import may contain at most 100,000 CSV records.');
      if (ignored) return;
      if (row.length !== header.length)
        throw invalid('CSV rows must have the same number of columns as the header.');
      if (provider === 'ga4' && /^(total|totals|grand total)$/i.test(row[di]!.trim())) return;

      const parsedDate = day(row[di]!, provider === 'ga4'),
        date = calendarDays.get(parsedDate) ?? parsedDate;

      calendarDays.set(date, date);
      if (match?.[2] && (date < day(match[2], true) || date > day(match[3]!, true)))
        throw invalid('A CSV date falls outside its filename range.');

      if (provider === 'plausible')
        for (const key of [
          'visitors',
          'visits',
          'pageviews',
          'bounces',
          'visit_duration',
          'entrances',
          'exits',
          'events',
        ]) {
          const index = columns.indexOf(key);
          if (index >= 0) number(row[index]!);
        }

      const count = number(row[ci]!);

      if (table === 'visitors') {
        if (days.has(date)) throw invalid('Each date must occur once in daily totals.');
        days.set(date, { day: date, pageviews: count, visitors: number(row[vi]!), custom: 0 });
      } else if (dimension) {
        const value = label(dimension[0]!, row[li]!),
          key = `${date}\0${dimension[0]}`,
          group = breakdowns.get(key) ?? new Map<string, Breakdown>(),
          existing = group.get(value);

        const sum = (existing?.count ?? 0) + count;
        if (sum > 1e12) throw invalid('An imported daily count exceeds 1 trillion.');
        group.set(value, { day: date, dimension: dimension[0]!, value, count: sum });
        breakdowns.set(key, group);
        if (table === 'custom_events') custom.set(date, (custom.get(date) ?? 0) + count);
      }
    });
    if (!header) throw invalid('The CSV is empty.');
  }

  if (!days.size || days.size > 730) throw invalid('Import 1–730 daily totals.');
  const breakdownRows = [...breakdowns.values()].flatMap((group) => [...group.values()]);
  for (const row of breakdownRows)
    if (!days.has(row.day)) throw invalid('A breakdown date has no daily total.');

  for (const row of days.values()) {
    row.custom = custom.get(row.day) ?? 0;
    if (row.custom > 1e12) throw invalid('An imported daily count exceeds 1 trillion.');
  }

  const sortKeys = new WeakMap<Breakdown, string>();

  const sortKey = (row: Breakdown) => {
    const existing = sortKeys.get(row);
    if (existing) return existing;
    const value = JSON.stringify([row.day, row.dimension, row.value]);
    sortKeys.set(row, value);

    return value;
  };

  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    breakdowns: breakdownRows.sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
    warnings: [...warnings],
    files: Object.keys(files),
    metrics: [
      'dailyUniqueVisitors',
      'pageviews',
      ...(tables.has('custom_events') ? ['customEvents'] : []),
    ].sort(),
  };
}
