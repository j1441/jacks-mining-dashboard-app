// ui.js — shared component kit: Card, Stat, Badge, Toggle, NumberField, Select,
// Button, Section, Modal, Sparkline, BarStrip, LineChart (all inline SVG, no libs),
// useApi hook, formatting helpers and the shared React context. Exposed on window.UI.
(() => {
  const { useState, useEffect, useCallback } = React;

  // Shared app context (defined here because ui.js loads first).
  window.AppContext = React.createContext(null);

  // ---- formatting ----
  const fmtNum = (v, d = 1) => (v == null || isNaN(v)) ? '–' : Number(v).toFixed(d);
  const fmtNok = (v, d = 2) => (v == null || isNaN(v)) ? '–' : `${Number(v).toFixed(d)} kr`;
  const fmtW = (v) => (v == null || isNaN(v)) ? '–' : `${Math.round(v)} W`;
  const fmtThs = (v) => (v == null || isNaN(v)) ? '–' : `${Number(v).toFixed(1)} TH/s`;
  const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '–' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  const fmtHour = (iso) => { const d = new Date(iso); return isNaN(d) ? '–' : `${String(d.getHours()).padStart(2, '0')}:00`; };
  const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '–' : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' }); };

  // ---- data hook ----
  function useApi(path, deps = []) {
    const [s, setS] = useState({ data: null, error: null, loading: !!path });
    const reload = useCallback(() => {
      if (!path) return;
      setS((p) => ({ ...p, loading: true }));
      window.API.get(path)
        .then((data) => setS({ data, error: null, loading: false }))
        .catch((error) => setS({ data: null, error, loading: false }));
    }, [path, ...deps]); // eslint-disable-line
    useEffect(() => { reload(); }, [reload]);
    return { ...s, reload };
  }

  // ---- primitives ----
  const Card = ({ title, actions, className = '', children }) => (
    <div className={`card ${className}`}>
      {title != null && <h3>{title}<span className="spacer" />{actions}</h3>}
      {children}
    </div>
  );

  const Stat = ({ label, value, sub, tone }) => (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : null}>{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );

  const Badge = ({ tone = '', spin = false, children }) => (
    <span className={`badge ${tone}`}>{spin && <span className="spin" />}{children}</span>
  );

  const Toggle = ({ checked, onChange, label, disabled }) => (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange && onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );

  const Button = ({ onClick, tone = '', small = false, disabled, children, title }) => (
    <button className={`btn ${tone} ${small ? 'small' : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>
  );

  const NumberField = ({ label, value, onChange, step = 1, min, max, unit, defaultHint, disabled }) => (
    <div className="field">
      {label && <span className="flabel">{label}{unit && <span className="hint">({unit})</span>}{defaultHint != null && <span className="hint">default {defaultHint}</span>}</span>}
      <input type="number" value={value ?? ''} step={step} min={min} max={max} disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    </div>
  );

  const TextField = ({ label, value, onChange, placeholder, type = 'text', defaultHint, disabled }) => (
    <div className="field">
      {label && <span className="flabel">{label}{defaultHint != null && <span className="hint">default {defaultHint}</span>}</span>}
      <input type={type} value={value ?? ''} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)} autoCapitalize="off" autoCorrect="off" />
    </div>
  );

  const Select = ({ label, value, onChange, options, defaultHint, disabled }) => (
    <div className="field">
      {label && <span className="flabel">{label}{defaultHint != null && <span className="hint">default {defaultHint}</span>}</span>}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  // Segmented control: options [{value, label}], one always selected.
  const Segmented = ({ value, onChange, options, small = false, disabled }) => (
    <div className={`seg ${small ? 'small' : ''}`} role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} disabled={disabled}
          className={value === o.value ? 'on' : ''}
          onClick={() => value !== o.value && onChange && onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );

  // Big +/- stepper for coarse numeric values (e.g. target temperature).
  const Stepper = ({ value, onChange, step = 0.5, min, max, unit, fmt = (v) => v, disabled }) => {
    const clamp = (v) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    const bump = (d) => onChange && onChange(clamp(Math.round((Number(value || 0) + d) * 10) / 10));
    return (
      <div className="stepper">
        <button aria-label="decrease" disabled={disabled || (min != null && value <= min)} onClick={() => bump(-step)}>−</button>
        <span className="val">{fmt(value)}{unit && <span className="unit"> {unit}</span>}</span>
        <button aria-label="increase" disabled={disabled || (max != null && value >= max)} onClick={() => bump(step)}>+</button>
      </div>
    );
  };

  const Section = ({ title, collapsed = false, right, children }) => {
    const [open, setOpen] = useState(!collapsed);
    return (
      <div className={`section ${open ? 'open' : ''}`}>
        <div className="shead" onClick={() => setOpen(!open)}>
          {title}{right}<span className="chev">▸</span>
        </div>
        {open && <div className="sbody">{children}</div>}
      </div>
    );
  };

  const Modal = ({ title, onClose, actions, children }) => (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {title && <h4>{title}</h4>}
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );

  // ---- charts (inline SVG in a 0-100 viewBox, non-scaling strokes; labels are HTML) ----
  const toXY = (points, t0, t1, min, max) => {
    const spanT = Math.max(1, t1 - t0), spanV = Math.max(1e-9, max - min);
    const segs = []; let cur = [];
    for (const p of points) {
      if (p.v == null || isNaN(p.v)) { if (cur.length) segs.push(cur); cur = []; continue; }
      cur.push(`${(((p.t - t0) / spanT) * 100).toFixed(2)},${(100 - ((p.v - min) / spanV) * 100).toFixed(2)}`);
    }
    if (cur.length) segs.push(cur);
    return segs;
  };

  const Sparkline = ({ values, height = 36, color = 'var(--accent)' }) => {
    const pts = (values || []).filter((v) => v != null && !isNaN(v));
    if (pts.length < 2) return <div className="muted" style={{ fontSize: 11 }}>no data</div>;
    const min = Math.min(...pts), max = Math.max(...pts);
    const str = pts.map((v, i) => `${(i / (pts.length - 1) * 100).toFixed(2)},${(100 - ((v - min) / Math.max(1e-9, max - min)) * 100).toFixed(2)}`).join(' ');
    return (
      <svg width="100%" height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={str} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  };

  // BarStrip: hourly price bars (colored by regime) + translucent planned-W overlay + now marker.
  const BarStrip = ({ hours, height = 110, onBarClick }) => {
    if (!hours || !hours.length) return <div className="muted">no price data</div>;
    const n = hours.length, bw = 100 / n;
    const maxP = Math.max(0.01, ...hours.map((h) => h.price ?? 0));
    const minP = Math.min(0, ...hours.map((h) => h.price ?? 0)); // negative prices are legal
    const spanP = Math.max(1e-9, maxP - minP);
    const maxW = Math.max(1, ...hours.map((h) => h.plannedW ?? 0));
    const y = (p) => 100 - ((p - minP) / spanP) * 92;
    const wOverlay = hours.some((h) => h.plannedW != null);
    let area = '';
    if (wOverlay) {
      const pts = hours.map((h, i) => `${(i * bw + bw / 2).toFixed(2)},${(100 - ((h.plannedW || 0) / maxW) * 92).toFixed(2)}`);
      area = `0,100 ${pts.join(' ')} 100,100`;
    }
    const labelEvery = n > 30 ? 6 : 3;
    return (
      <div>
        <svg width="100%" height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
          <line x1="0" x2="100" y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {hours.map((h, i) => (
            <rect key={i} x={(i * bw + bw * 0.12).toFixed(2)} width={(bw * 0.76).toFixed(2)}
              y={Math.min(y(h.price ?? 0), y(0)).toFixed(2)} height={Math.abs(y(h.price ?? 0) - y(0)).toFixed(2)}
              fill={h.regime === 'over-cap' ? 'var(--crit)' : 'var(--accent)'} opacity={h.isNow ? 1 : 0.55}
              style={onBarClick ? { cursor: 'pointer' } : null} onClick={onBarClick ? () => onBarClick(h, i) : null}>
              <title>{`${h.label} — ${fmtNum(h.price, 2)} kr/kWh${h.plannedW != null ? ` · plan ${h.off ? 'off' : Math.round(h.plannedW) + ' W'}` : ''}`}</title>
            </rect>
          ))}
          {wOverlay && <polygon points={area} fill="rgba(74,222,128,.16)" stroke="var(--ok)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          {hours.map((h, i) => h.isNow ? (
            <line key={`now${i}`} x1={(i * bw + bw / 2).toFixed(2)} x2={(i * bw + bw / 2).toFixed(2)} y1="0" y2="100"
              stroke="var(--text)" strokeWidth="1" strokeDasharray="3,3" vectorEffect="non-scaling-stroke" />
          ) : null)}
        </svg>
        <div className="xlabs">{hours.map((h, i) => i % labelEvery === 0 ? <span key={i}>{h.label}</span> : null)}</div>
        <div className="legend">
          <span><i style={{ background: 'var(--accent)' }} />price kr/kWh</span>
          <span><i style={{ background: 'var(--crit)' }} />over-cap hour</span>
          {wOverlay && <span><i style={{ background: 'var(--ok)' }} />planned W</span>}
        </div>
      </div>
    );
  };

  // LineChart: multi-series over time; series: [{name, color, points:[{t,v}], axis:'left'|'right', area}]
  const LineChart = ({ series, height = 190, yFormat = (v) => fmtNum(v, 1), yRightFormat = (v) => fmtNum(v, 2) }) => {
    const all = (series || []).filter((s) => s.points && s.points.length);
    if (!all.length) return <div className="muted" style={{ padding: '20px 0' }}>no data for this range</div>;
    const ts = all.flatMap((s) => s.points.map((p) => p.t));
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const axes = {};
    for (const s of all) {
      const ax = s.axis === 'right' ? 'right' : 'left';
      const vs = s.points.map((p) => p.v).filter((v) => v != null && !isNaN(v));
      if (!vs.length) continue;
      const a = axes[ax] || { min: Infinity, max: -Infinity };
      a.min = Math.min(a.min, ...vs); a.max = Math.max(a.max, ...vs);
      axes[ax] = a;
    }
    for (const a of Object.values(axes)) {
      if (a.max === a.min) { a.max += 1; a.min -= a.min === 0 ? 0 : 1; }
      const pad = (a.max - a.min) * 0.08; a.max += pad; a.min = a.min >= 0 && a.min - pad < 0 ? 0 : a.min - pad;
    }
    const span = t1 - t0;
    const fmtX = (t) => span <= 36 * 3600e3 ? fmtTime(new Date(t).toISOString()) : fmtDay(new Date(t).toISOString());
    const xlabs = [0, 0.25, 0.5, 0.75, 1].map((f) => fmtX(t0 + span * f));
    return (
      <div>
        <div className="linechart">
          <svg width="100%" height={height} viewBox="0 0 100 100" preserveAspectRatio="none">
            {[0, 25, 50, 75, 100].map((gy) => (
              <line key={gy} x1="0" x2="100" y1={gy} y2={gy} stroke="var(--border)" strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />
            ))}
            {all.map((s, si) => {
              const a = axes[s.axis === 'right' ? 'right' : 'left'];
              if (!a) return null;
              const segs = toXY(s.points, t0, t1, a.min, a.max);
              return segs.map((seg, gi) => (
                <React.Fragment key={`${si}-${gi}`}>
                  {s.area && seg.length > 1 && <polygon points={`${seg[0].split(',')[0]},100 ${seg.join(' ')} ${seg[seg.length - 1].split(',')[0]},100`} fill={s.color} opacity="0.12" />}
                  <polyline points={seg.join(' ')} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </React.Fragment>
              ));
            })}
          </svg>
          {axes.left && [0, 25, 50, 75, 100].map((gy) => (
            <span key={gy} className="ylab" style={{ top: `${gy}%` }}>{yFormat(axes.left.max - (axes.left.max - axes.left.min) * gy / 100)}</span>
          ))}
          {axes.right && [0, 50, 100].map((gy) => (
            <span key={gy} className="ylab right" style={{ top: `${gy}%` }}>{yRightFormat(axes.right.max - (axes.right.max - axes.right.min) * gy / 100)}</span>
          ))}
        </div>
        <div className="xlabs">{xlabs.map((x, i) => <span key={i}>{x}</span>)}</div>
        <div className="legend">{all.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}{s.axis === 'right' ? ' (right)' : ''}</span>)}</div>
      </div>
    );
  };

  // ---- client-side envelope prediction (interpolates /api/miners/:id/envelope data) ----
  const envelopePoints = (env) => {
    if (!env) return [];
    const raw = Array.isArray(env) ? env : (env.points || env.learned || env.curve || env.candidates || null);
    const out = [];
    if (Array.isArray(raw)) {
      for (const p of raw) {
        if (p && p.targetW != null) out.push({ boards: Number(p.boards ?? p.boardCount ?? 0), targetW: Number(p.targetW), hashrateThs: Number(p.hashrateThs ?? p.ths ?? 0), wallW: Number(p.wallW ?? p.targetW) });
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(k);
        if (m && v && typeof v === 'object') out.push({ boards: Number(m[1]), targetW: Number(m[2]), hashrateThs: Number(v.hashrateThs || 0), wallW: Number(v.wallW ?? m[2]) });
      }
    }
    return out;
  };

  const predictEnvelope = (env, boards, targetW) => {
    boards = Math.max(1, boards | 0);
    const pts = envelopePoints(env).filter((p) => p.boards === boards).sort((a, b) => a.targetW - b.targetW);
    if (pts.length >= 2) {
      const t = Math.min(Math.max(targetW, pts[0].targetW), pts[pts.length - 1].targetW);
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i].targetW) {
          const a = pts[i - 1], b = pts[i], f = b.targetW === a.targetW ? 0 : (t - a.targetW) / (b.targetW - a.targetW);
          return { hashrateThs: a.hashrateThs + f * (b.hashrateThs - a.hashrateThs), wallW: a.wallW + f * (b.wallW - a.wallW), source: 'learned' };
        }
      }
    }
    // Fallback model per DESIGN §3.1 (same seeds as lib/envelope.js).
    const st = (env && env.stats) || env || {};
    const overheadW = Number(st.overheadW ?? 80), minBW = Number(st.perBoardMinW ?? 397), maxBW = Number(st.perBoardMaxW ?? 996);
    const anchors = [{ boardW: 397, ths: 13.17 }, { boardW: 996, ths: 34.7 }];
    const boardW = Math.min(Math.max((targetW - overheadW) / boards, minBW), maxBW);
    const f = (boardW - anchors[0].boardW) / (anchors[1].boardW - anchors[0].boardW);
    const perBoardThs = anchors[0].ths + f * (anchors[1].ths - anchors[0].ths);
    return { hashrateThs: boards * perBoardThs, wallW: boards * boardW + overheadW, source: 'model' };
  };

  window.UI = {
    Card, Stat, Badge, Toggle, Button, NumberField, TextField, Select, Section, Modal,
    Segmented, Stepper,
    Sparkline, BarStrip, LineChart, useApi, predictEnvelope,
    fmtNum, fmtNok, fmtW, fmtThs, fmtTime, fmtHour, fmtDay,
  };
})();
