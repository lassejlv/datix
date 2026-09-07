const regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

export function countryName(code: string) {
  const region = code.toUpperCase();
  return /^[A-Z]{2}$/.test(region) && !['XX', 'ZZ'].includes(region)
    ? regionNames.of(region)
    : undefined;
}

export function CountryLabel({ code }: { code: string }) {
  const name = countryName(code);
  const flag = name
    ? String.fromCodePoint(
        ...Array.from(code.toUpperCase(), (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
      )
    : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {flag && (
        <span aria-hidden="true" className="shrink-0 text-base leading-none">
          {flag}
        </span>
      )}
      <span className="truncate">{name ?? 'Unknown location'}</span>
    </span>
  );
}
