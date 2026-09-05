import { useMemo, useState } from "react";
import { useTheme } from "../lib/theme.js";

/**
 * Quick chart over a result set. Pure SVG — no library — with the categorical
 * palette validated for colour-vision deficiency (see the dataviz skill's
 * reference palette): fixed slot order, one axis, hover tooltips, legend for
 * ≥2 series, thin marks anchored to the baseline.
 */
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const MAX_SERIES = 8;
const MAX_POINTS = 500;

type ChartType = "bar" | "line" | "area" | "pie";

interface Props {
  fields: string[];
  rows: unknown[][];
}

export function ResultChart({ fields, rows }: Props) {
  const { theme } = useTheme();
  const palette = theme === "dark" ? DARK : LIGHT;

  const numeric = useMemo(() => fields.filter((_, i) => rows.slice(0, 50).some((r) => isNum(r[i])) && rows.slice(0, 50).every((r) => r[i] === null || isNum(r[i]))), [fields, rows]);
  const [type, setType] = useState<ChartType>("bar");
  const [xField, setXField] = useState<string>(() => fields.find((f) => !numeric.includes(f)) ?? fields[0] ?? "");
  const [yFields, setYFields] = useState<string[]>(() => numeric.filter((f) => f !== xField).slice(0, 1));
  const [hover, setHover] = useState<{ i: number; s: number; x: number; y: number } | null>(null);

  const xi = fields.indexOf(xField);
  const series = yFields.slice(0, MAX_SERIES).map((f) => ({ name: f, idx: fields.indexOf(f) }));
  const data = useMemo(() => rows.slice(0, MAX_POINTS).map((r) => ({ label: labelOf(r[xi]), values: series.map((s) => toNum(r[s.idx])) })), [rows, xi, series]);

  const W = 900;
  const H = 360;
  const pad = { l: 56, r: 16, t: 16, b: 48 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(1e-9, ...data.flatMap((d) => d.values.map((v) => v ?? 0)));
  const min = Math.min(0, ...data.flatMap((d) => d.values.map((v) => v ?? 0)));
  const range = max - min || 1;
  const yOf = (v: number) => pad.t + ih - ((v - min) / range) * ih;
  const ticks = niceTicks(min, max, 5);

  const toggleY = (f: string) => setYFields((ys) => (ys.includes(f) ? ys.filter((y) => y !== f) : [...ys, f].slice(0, MAX_SERIES)));

  if (fields.length === 0) return <div className="muted result-loading">No columns to chart.</div>;

  return (
    <div className="chart-shell">
      <div className="chart-toolbar">
        <div className="seg" role="group">
          {(["bar", "line", "area", "pie"] as ChartType[]).map((t) => (
            <button key={t} type="button" className={`seg-btn ${type === t ? "active" : ""}`} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </div>
        <label className="inline">
          <span className="muted">X</span>
          <select value={xField} onChange={(e) => setXField(e.target.value)}>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <span className="muted hint">Y:</span>
        <div className="chart-yfields">
          {(numeric.length ? numeric : fields).filter((f) => f !== xField).map((f, i) => (
            <label key={f} className="inline chart-ychip" style={{ borderColor: yFields.includes(f) ? palette[yFields.indexOf(f) % MAX_SERIES] : undefined }}>
              <input type="checkbox" checked={yFields.includes(f)} onChange={() => toggleY(f)} /> {f}
              {i >= 0 && yFields.includes(f) && <span className="swatch" style={{ background: palette[yFields.indexOf(f) % MAX_SERIES] }} />}
            </label>
          ))}
        </div>
        <div className="grow" />
        <span className="muted hint">
          {data.length} point{data.length === 1 ? "" : "s"}
          {rows.length > MAX_POINTS ? ` (first ${MAX_POINTS})` : ""}
        </span>
      </div>

      {series.length === 0 ? (
        <div className="muted result-loading">Pick at least one numeric Y column.</div>
      ) : type === "pie" ? (
        <Pie data={data} palette={palette} seriesName={series[0]!.name} />
      ) : (
        <div className="chart-plot">
          <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={yOf(t)} y2={yOf(t)} className="chart-grid" />
                <text x={pad.l - 8} y={yOf(t) + 4} textAnchor="end" className="chart-tick">
                  {fmt(t)}
                </text>
              </g>
            ))}
            <line x1={pad.l} x2={W - pad.r} y1={yOf(0)} y2={yOf(0)} className="chart-axis" />

            {type === "bar" &&
              data.map((d, i) => {
                const gw = iw / data.length;
                const bw = Math.max(1, (gw - 2) / series.length - 2);
                return d.values.map((v, s) => {
                  if (v === null) return null;
                  const x = pad.l + i * gw + 1 + s * (bw + 2);
                  const y0 = yOf(0);
                  const y1 = yOf(v);
                  const top = Math.min(y0, y1);
                  const h = Math.max(1, Math.abs(y1 - y0));
                  return (
                    <rect
                      key={`${i}-${s}`}
                      x={x}
                      y={top}
                      width={bw}
                      height={h}
                      rx={Math.min(4, bw / 2)}
                      fill={palette[s]}
                      opacity={hover && (hover.i !== i || hover.s !== s) ? 0.55 : 1}
                      onMouseEnter={() => setHover({ i, s, x: x + bw / 2, y: top })}
                    />
                  );
                });
              })}

            {(type === "line" || type === "area") &&
              series.map((_, s) => {
                const pts = data.map((d, i) => ({ x: pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw), y: d.values[s] === null ? null : yOf(d.values[s]!) }));
                const path = pts.map((p, i) => (p.y === null ? "" : `${i === 0 || pts[i - 1]!.y === null ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)).join(" ");
                const area = `${path} L${pts[pts.length - 1]!.x.toFixed(1)},${yOf(0)} L${pts[0]!.x.toFixed(1)},${yOf(0)} Z`;
                return (
                  <g key={s}>
                    {type === "area" && <path d={area} fill={palette[s]} opacity={0.18} />}
                    <path d={path} fill="none" stroke={palette[s]} strokeWidth={2} strokeLinejoin="round" />
                    {pts.map((p, i) =>
                      p.y === null ? null : (
                        <circle
                          key={i}
                          cx={p.x}
                          cy={p.y}
                          r={hover?.i === i && hover.s === s ? 5 : data.length > 60 ? 0 : 3.5}
                          fill={palette[s]}
                          className="chart-dot"
                          onMouseEnter={() => setHover({ i, s, x: p.x, y: p.y! })}
                        />
                      ),
                    )}
                    {/* wide invisible hit targets so hovering is easy */}
                    {pts.map((p, i) =>
                      p.y === null ? null : <rect key={`h${i}`} x={p.x - Math.max(4, iw / data.length / 2)} y={pad.t} width={Math.max(8, iw / data.length)} height={ih} fill="transparent" onMouseEnter={() => setHover({ i, s, x: p.x, y: p.y! })} />,
                    )}
                  </g>
                );
              })}

            {data.map((d, i) => {
              const every = Math.ceil(data.length / 14);
              if (i % every !== 0) return null;
              const x = type === "bar" ? pad.l + (i + 0.5) * (iw / data.length) : pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
              return (
                <text key={i} x={x} y={H - pad.b + 18} textAnchor="middle" className="chart-tick">
                  {d.label.length > 14 ? d.label.slice(0, 13) + "…" : d.label}
                </text>
              );
            })}

            {hover && data[hover.i] && (
              <g transform={`translate(${Math.min(W - 180, Math.max(pad.l, hover.x + 8))}, ${Math.max(pad.t, hover.y - 44)})`} className="chart-tip">
                <rect width={170} height={36} rx={5} />
                <text x={8} y={14}>{data[hover.i]!.label}</text>
                <text x={8} y={29}>
                  {series[hover.s]!.name}: {fmt(data[hover.i]!.values[hover.s] ?? 0)}
                </text>
              </g>
            )}
          </svg>
          {series.length > 1 && (
            <div className="chart-legend">
              {series.map((s, i) => (
                <span key={s.name}>
                  <span className="swatch" style={{ background: palette[i] }} /> {s.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Pie({ data, palette, seriesName }: { data: { label: string; values: (number | null)[] }[]; palette: string[]; seriesName: string }) {
  const items = data.map((d) => ({ label: d.label, v: Math.max(0, d.values[0] ?? 0) })).filter((d) => d.v > 0);
  const top = items.sort((a, b) => b.v - a.v);
  const shown = top.slice(0, 7);
  const rest = top.slice(7).reduce((s, d) => s + d.v, 0);
  if (rest > 0) shown.push({ label: "Other", v: rest });
  const total = shown.reduce((s, d) => s + d.v, 0) || 1;
  const [hover, setHover] = useState<number | null>(null);
  let angle = -Math.PI / 2;
  const R = 120;
  const cx = 160;
  const cy = 150;
  return (
    <div className="chart-plot chart-pie">
      <svg viewBox="0 0 320 300" className="chart-svg" style={{ maxWidth: 360 }}>
        {shown.map((d, i) => {
          const a0 = angle;
          const a1 = angle + (d.v / total) * Math.PI * 2;
          angle = a1;
          const large = a1 - a0 > Math.PI ? 1 : 0;
          const p = (a: number, r: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
          const path = `M${cx},${cy} L${p(a0, R)} A${R},${R} 0 ${large} 1 ${p(a1, R)} Z`;
          return <path key={i} d={path} fill={palette[i % palette.length]} stroke="var(--bg)" strokeWidth={2} opacity={hover !== null && hover !== i ? 0.5 : 1} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />;
        })}
        <text x={cx} y={cy + 4} textAnchor="middle" className="chart-tick">
          {hover !== null ? `${((shown[hover]!.v / total) * 100).toFixed(1)}%` : seriesName}
        </text>
      </svg>
      <div className="chart-legend vertical">
        {shown.map((d, i) => (
          <span key={i} className={hover === i ? "active" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: palette[i % palette.length] }} /> {d.label} <span className="muted">· {fmt(d.v)} ({((d.v / total) * 100).toFixed(1)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function isNum(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "bigint") return true;
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
  return false;
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function labelOf(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 16).replace("T", " ") : s;
}
function fmt(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(2);
}
function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Number(t.toFixed(10)));
  return out;
}
