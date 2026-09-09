import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  geoDistance,
  geoGraticule10,
  geoOrthographic,
  geoPath,
  type GeoPermissibleObjects,
} from 'd3-geo';
import type { FeatureCollection, Geometry } from 'geojson';
import { useFeatureReport, ReportStatus } from './feature-report';
import { useSitePreferences } from './site-preferences';
import { CountryLabel, countryName } from './country-label';
import { Button } from './ui/button';
import { ArrowLeft, ArrowRight, User, X } from './ui/icons';
import './visitor-globe.css';
type World = FeatureCollection<Geometry, { code: string; center: [number, number] }>;
type GlobeReport = {
  active: number;
  countries: { code: string; visitors: number }[];
  recent: {
    id: string;
    country: string;
    path: string;
    at: string;
    name: string | null;
    type: string;
  }[];
  referrers: { value: string; count: number }[];
  devices: { value: string; count: number }[];
};
export default function VisitorGlobe({ path }: { path: string }) {
  const { t, locale } = useSitePreferences();
  const { data, error } = useFeatureReport<GlobeReport>(path, 0, 30000);
  const [world, setWorld] = useState<World>(),
    [mapError, setMapError] = useState(false),
    [rotation, setRotation] = useState<[number, number]>([-15, -25]),
    [zoom, setZoom] = useState(1),
    [full, setFull] = useState(false),
    [selected, setSelected] = useState('');
  const drag = useRef<{ x: number; y: number; rotation: [number, number] } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = new AbortController();
    fetch('/world-countries.json', { signal: c.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setWorld)
      .catch(() => {
        if (!c.signal.aborted) setMapError(true);
      });
    return () => c.abort();
  }, []);
  useEffect(() => {
    if (!full) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = old;
      window.removeEventListener('keydown', escape);
    };
  }, [full]);
  const projection = useMemo(
    () =>
      geoOrthographic()
        .translate([450, 335])
        .scale(280 * zoom)
        .rotate(rotation)
        .clipAngle(90)
        .precision(0.5),
    [rotation, zoom],
  );
  const draw = geoPath(projection);
  const center = projection.invert?.([450, 335]) ?? [0, 0];
  const countries = world?.features ?? [];
  const counts = new Map(data?.countries.map((c) => [c.code, c.visitors]));
  const points = countries.filter(
    (f) =>
      (counts.get(f.properties.code) ?? 0) > 0 &&
      geoDistance(f.properties.center, center) < Math.PI / 2 - 0.04,
  );
  const total = data?.countries.reduce((sum, c) => sum + c.visitors, 0) ?? 0;
  function focus(code: string) {
    const f = countries.find((f) => f.properties.code === code);
    if (f) setRotation([-f.properties.center[0], -f.properties.center[1]]);
    setSelected(code);
  }
  const view = (
    <div ref={root} className={`visitor-globe ${full ? 'visitor-globe-full' : ''}`}>
      <div className="globe-controls">
        <Button size="sm" variant="outline" onClick={() => setFull(!full)}>
          {full ? (
            <>
              <X size={14} />
              {t('Close')}
            </>
          ) : (
            t('Fullscreen')
          )}
        </Button>
      </div>
      <section className="globe-summary">
        <h2 className="text-sm font-medium">{t('Visitors around the world')}</h2>
        <p className="mt-2 text-xl font-medium tabular-nums">
          {total.toLocaleString(locale)}{' '}
          <span className="text-xs font-normal text-slate-400">{t('Last 24 hours')}</span>
        </p>
        <p className="mt-2 text-xs text-slate-300">
          <span className="mr-2 inline-block size-1.5 rounded-full bg-emerald-400" />
          {t('{count} active in the last 5 minutes', { count: String(data?.active ?? 0) })}
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-white/10 pt-3">
          {data?.referrers.map((r) => (
            <span key={r.value} className="rounded bg-white/5 px-2 py-1 text-[10px] text-slate-300">
              {r.value || t('Direct')} <span className="text-slate-500">{r.count}</span>
            </span>
          ))}
        </div>
      </section>
      {mapError ? (
        <p role="alert" className="p-10 text-sm">
          {t('The map could not be loaded. Refresh to try again.')}
        </p>
      ) : (
        <svg
          viewBox="0 0 900 650"
          className="globe-canvas"
          role="img"
          aria-label={t('Interactive visitor globe')}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, rotation };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const scale = 900 / e.currentTarget.getBoundingClientRect().width;
            setRotation([
              drag.current.rotation[0] + (e.clientX - drag.current.x) * 0.25 * scale,
              Math.max(
                -85,
                Math.min(
                  85,
                  drag.current.rotation[1] - (e.clientY - drag.current.y) * 0.25 * scale,
                ),
              ),
            ]);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              e.preventDefault();
              setRotation(([x, y]) => [
                x + (e.key === 'ArrowLeft' ? -12 : e.key === 'ArrowRight' ? 12 : 0),
                Math.max(
                  -85,
                  Math.min(85, y + (e.key === 'ArrowUp' ? 10 : e.key === 'ArrowDown' ? -10 : 0)),
                ),
              ]);
            }
          }}
        >
          <defs>
            <radialGradient id="globe-air">
              <stop offset="80%" stopColor="#315b96" stopOpacity="0" />
              <stop offset="91%" stopColor="#3e6fc5" stopOpacity=".2" />
              <stop offset="100%" stopColor="#345491" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="globe-shade" cx="35%" cy="25%" r="80%">
              <stop offset="20%" stopColor="#000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000" stopOpacity=".62" />
            </radialGradient>
          </defs>
          {Array.from({ length: 65 }, (_, i) => (
            <circle
              key={i}
              cx={(i * 137.5) % 900}
              cy={(i * 89.7) % 650}
              r={i % 3 === 0 ? 1 : 0.55}
              fill="white"
              opacity={0.12 + (i % 4) * 0.07}
            />
          ))}
          <circle cx="450" cy="335" r={330 * zoom} fill="url(#globe-air)" />
          <circle
            cx="450"
            cy="335"
            r={280 * zoom}
            fill="#151e2b"
            stroke="#61789b"
            strokeOpacity=".2"
          />
          <path
            d={draw(geoGraticule10()) ?? ''}
            fill="none"
            stroke="#7489a7"
            strokeOpacity=".09"
            strokeWidth=".6"
          />
          {countries.map((country, i) => (
            <path
              key={country.properties.code + i}
              d={draw(country as GeoPermissibleObjects) ?? ''}
              fill={
                selected === country.properties.code
                  ? '#415875'
                  : counts.has(country.properties.code)
                    ? '#334255'
                    : '#28323f'
              }
              stroke="#718098"
              strokeOpacity=".3"
              strokeWidth=".6"
            />
          ))}
          <circle cx="450" cy="335" r={280 * zoom} fill="url(#globe-shade)" />
          {countries
            .filter((f) => geoDistance(f.properties.center, center) < 1.05)
            .map((f) => {
              const p = projection(f.properties.center)!;
              return (
                <text
                  key={f.properties.code}
                  x={p[0]}
                  y={p[1] + 17}
                  textAnchor="middle"
                  fontSize="7"
                  fill="#aab5c6"
                  opacity=".6"
                >
                  {countryName(f.properties.code, locale) ?? ''}
                </text>
              );
            })}
          {points.map((country) => {
            const code = country.properties.code,
              p = projection(country.properties.center)!;
            const count = counts.get(code) ?? 0;
            return (
              <g key={code} transform={`translate(${p[0]},${p[1]})`}>
                <title>
                  {countryName(code, locale)} · {count}
                </title>
                <circle
                  r={14 + Math.min(7, Math.log2(count + 1))}
                  fill="#162132"
                  stroke={selected === code ? '#e3b980' : '#8290a7'}
                  strokeWidth="1.2"
                />
                <circle cy="-3" r="4" fill="#d3ae84" />
                <path d="M-7,7 C-7,0 7,0 7,7" fill="#81a497" />
                <rect
                  x="8"
                  y="-18"
                  width={count >= 100 ? 27 : 21}
                  height="15"
                  rx="7"
                  fill="#dae2ee"
                />
                <text
                  x={count >= 100 ? 21.5 : 18.5}
                  y="-7.5"
                  textAnchor="middle"
                  fontSize="8"
                  fill="#182338"
                  fontWeight="600"
                >
                  {count}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="globe-rotation">
        <button aria-label={t('Rotate left')} onClick={() => setRotation(([x, y]) => [x - 25, y])}>
          <ArrowLeft size={15} />
        </button>
        <button aria-label={t('Zoom out')} onClick={() => setZoom((z) => Math.max(0.75, z - 0.15))}>
          −
        </button>
        <button
          onClick={() => {
            setRotation([-15, -25]);
            setZoom(1);
            setSelected('');
          }}
        >
          {t('Reset')}
        </button>
        <button aria-label={t('Zoom in')} onClick={() => setZoom((z) => Math.min(1.8, z + 0.15))}>
          +
        </button>
        <button aria-label={t('Rotate right')} onClick={() => setRotation(([x, y]) => [x + 25, y])}>
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="globe-bottom">
        <section className="globe-activity">
          <h2>{t('Recent activity')}</h2>
          {data?.recent.slice(0, 4).map((event, i) => (
            <div key={event.id + event.at + i} className="mt-3 flex items-start gap-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-700">
                <User size={13} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs text-slate-300">
                  {event.country ? <CountryLabel code={event.country} /> : t('Unknown location')}{' '}
                  <span className="text-slate-500">·</span> {event.name || event.path}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {new Date(event.at).toLocaleTimeString(locale, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
          ))}
          {!data?.recent.length && (
            <p className="mt-3 text-xs text-slate-400">{t('Waiting for visitors')}</p>
          )}
        </section>
        <section className="globe-countries">
          <h2>{t('Countries')}</h2>
          <div className="mt-2 max-h-36 overflow-y-auto">
            {data?.countries.map((c) => (
              <button
                key={c.code}
                className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-xs hover:bg-white/5"
                aria-pressed={selected === c.code}
                onClick={() => focus(c.code)}
              >
                <CountryLabel code={c.code} />
                <span className="tabular-nums text-slate-400">{c.visitors}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <p className="globe-note">
        {t('Country-level locations · Last 24 hours · Refreshes every 30 seconds')}
      </p>
    </div>
  );
  return (
    <ReportStatus error={error} loading={!data}>
      {full ? createPortal(view, document.body) : view}
    </ReportStatus>
  );
}
