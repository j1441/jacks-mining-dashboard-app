// history.js — History tab: 24h/7d/30d range picker, inline-SVG line charts
// (hashrate, power vs price on dual axes, net NOK/h) from /api/history samples,
// and the events feed with severity filter from /api/events.
(() => {
  const { useState, useContext, useMemo } = React;
  const { Card, Badge, Button, LineChart, useApi, fmtNum } = window.UI;

  const RANGES = [
    { key: '24h', label: '24h', ms: 24 * 3600e3, res: 'raw' },
    { key: '7d', label: '7 days', ms: 7 * 24 * 3600e3, res: 'hour' },
    { key: '30d', label: '30 days', ms: 30 * 24 * 3600e3, res: 'hour' },
  ];
  const SEVERITIES = ['all', 'info', 'warn', 'critical'];

  const sevIcon = (sev) => {
    if (sev === 'critical') return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--crit)"><path d="M8 1 15 14H1L8 1zm-.9 5h1.8l-.2 4h-1.4l-.2-4zM8 12.8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" /></svg>
    );
    if (sev === 'warn') return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--warn)"><circle cx="8" cy="8" r="7" opacity=".25" /><path d="M7.1 3.5h1.8l-.25 5.5h-1.3L7.1 3.5zM8 12.4a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z" /></svg>
    );
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--muted)"><circle cx="8" cy="8" r="7" opacity=".3" /><path d="M7.2 6.8h1.6V12H7.2V6.8zM8 5.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" /></svg>
    );
  };

  function EventsFeed() {
    const [sev, setSev] = useState('all');
    const ev = useApi(`/api/events?limit=100${sev !== 'all' ? `&severity=${sev}` : ''}`, [sev]);
    const rows = Array.isArray(ev.data) ? ev.data : (ev.data && ev.data.events) || [];
    return (
      <Card className="wide" title="Events" actions={
        <span className="btn-row">
          {SEVERITIES.map((s) => <Button key={s} small tone={sev === s ? 'accent' : 'ghost'} onClick={() => setSev(s)}>{s}</Button>)}
        </span>}>
        {ev.loading && <div className="muted">Loading…</div>}
        {ev.error && <div className="err-text">{ev.error.message}</div>}
        <div className="events">
          {rows.map((e, i) => (
            <div className="event" key={`${e.ts}-${i}`}>
              {sevIcon(e.severity)}
              <div style={{ flex: 1 }}>
                <div>{e.message || e.type}</div>
                <div className="when">{new Date(e.ts).toLocaleString()} · {e.type}{e.id ? ` · ${e.id}` : ''}</div>
              </div>
            </div>
          ))}
          {!ev.loading && !rows.length && <div className="muted">No events{sev !== 'all' ? ` at severity "${sev}"` : ''}.</div>}
        </div>
      </Card>
    );
  }

  function History() {
    const app = useContext(window.AppContext);
    const [range, setRange] = useState(RANGES[0]);
    const minerId = app.snapshot && app.snapshot.miners && app.snapshot.miners[0] ? app.snapshot.miners[0].id : '';
    // Memoized so the URL is stable per selection — Date.now() in the path would
    // otherwise re-trigger useApi on every render (infinite fetch loop).
    const { from, to } = React.useMemo(() => ({
      from: new Date(Date.now() - range.ms).toISOString(),
      to: new Date().toISOString(),
    }), [range.key, minerId]);
    const q = useApi(`/api/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&res=${range.res}${minerId ? `&id=${encodeURIComponent(minerId)}` : ''}`, [range.key, minerId]);
    const rows = Array.isArray(q.data) ? q.data : (q.data && (q.data.samples || q.data.rows)) || [];

    const series = useMemo(() => {
      const pt = (field) => rows.map((r) => ({ t: new Date(r.ts).getTime(), v: r[field] == null ? null : Number(r[field]) }));
      return {
        hr: pt('hr'), wallW: pt('wallW'), price: pt('priceMarginal'), net: pt('netNokH'),
      };
    }, [rows]);

    return (
      <div>
        <div className="btn-row mb">
          {RANGES.map((r) => <Button key={r.key} tone={range.key === r.key ? 'accent' : ''} onClick={() => setRange(r)}>{r.label}</Button>)}
          {q.loading && <span className="muted">loading…</span>}
          {q.error && <span className="err-text">{q.error.message}</span>}
        </div>
        <div className="grid">
          <Card className="wide" title="Hashrate (TH/s)">
            <LineChart series={[{ name: 'hashrate TH/s', color: 'var(--accent)', points: series.hr, area: true }]} yFormat={(v) => fmtNum(v, 0)} />
          </Card>
          <Card className="wide" title="Power vs price">
            <LineChart series={[
              { name: 'wall W', color: 'var(--ok)', points: series.wallW, area: true },
              { name: 'price kr/kWh', color: 'var(--warn)', points: series.price, axis: 'right' },
            ]} yFormat={(v) => fmtNum(v, 0)} yRightFormat={(v) => fmtNum(v, 2)} />
          </Card>
          <Card className="wide" title="Net (NOK/h)">
            <LineChart series={[{ name: 'net kr/h', color: 'var(--accent)', points: series.net }]} yFormat={(v) => fmtNum(v, 1)} />
            {rows.length > 0 && (
              <div className="legend">
                <span>range total: <b className="mono" style={{ color: 'var(--text)' }}>
                  {fmtNum(rows.reduce((a, r) => a + (Number(r.netNokH) || 0), 0) * (range.res === 'raw' ? (range.ms / 3600e3) / Math.max(1, rows.length) : 1), 1)} kr
                </b> {range.res === 'raw' ? '(approx.)' : ''}</span>
                <Badge tone="ok">{rows.length} samples</Badge>
              </div>
            )}
          </Card>
          <EventsFeed />
        </div>
      </div>
    );
  }

  window.History = History;
})();
