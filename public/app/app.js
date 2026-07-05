// app.js — application root: window.API fetch helpers, same-origin WebSocket client
// with 1s→30s backoff and a "reconnecting…" banner, hash-based tab router
// (#/overview #/control #/history #/settings), and the shared React context provider.
(() => {
  const { useState, useEffect, useCallback } = React;

  // ---- fetch helpers ----
  async function request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body */ }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || `${method} ${path} → HTTP ${res.status}`);
    return data;
  }
  window.API = {
    get: (p) => request('GET', p),
    put: (p, b) => request('PUT', p, b),
    post: (p, b) => request('POST', p, b === undefined ? {} : b),
  };

  // ---- tabs ----
  const icon = (d) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
  const TABS = [
    { id: 'overview', label: 'Overview', icon: icon('M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10') },
    { id: 'control', label: 'Control', icon: icon('M4 8h10M18 8h2M14 8a2 2 0 104 0 2 2 0 00-4 0zM4 16h2M10 16h10M6 16a2 2 0 104 0 2 2 0 00-4 0z') },
    { id: 'history', label: 'History', icon: icon('M3 20h18M5 20V12M10 20V7M15 20v-9M20 20V4') },
    { id: 'settings', label: 'Settings', icon: icon('M12 9a3 3 0 100 6 3 3 0 000-6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.5-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.5 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z') },
  ];
  const parseHash = () => {
    const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return TABS.some((t) => t.id === h) ? h : 'overview';
  };

  function App() {
    const [snapshot, setSnapshot] = useState(null);
    const [config, setConfig] = useState(null);
    const [wsStatus, setWsStatus] = useState('connecting'); // connecting | open | reconnecting
    const [route, setRoute] = useState(parseHash());

    const reloadConfig = useCallback(() => window.API.get('/api/config').then(setConfig).catch(() => {}), []);

    // hash router
    useEffect(() => {
      const onHash = () => setRoute(parseHash());
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, []);

    // initial REST load (WS takes over once connected)
    useEffect(() => {
      window.API.get('/api/state').then((s) => setSnapshot((prev) => prev || s)).catch(() => {});
      reloadConfig();
    }, [reloadConfig]);

    // WebSocket with 1s→30s exponential backoff
    useEffect(() => {
      let ws = null, stopped = false, delay = 1000, timer = null;
      const retry = () => {
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
      const connect = () => {
        if (stopped) return;
        try {
          ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        } catch (e) { setWsStatus('reconnecting'); retry(); return; }
        ws.onopen = () => { delay = 1000; setWsStatus('open'); };
        ws.onmessage = (ev) => { try { setSnapshot(JSON.parse(ev.data)); } catch (e) { /* ignore bad frame */ } };
        ws.onclose = () => { if (!stopped) { setWsStatus('reconnecting'); retry(); } };
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
      };
      connect();
      return () => { stopped = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} };
    }, []);

    // REST polling fallback while the socket is down
    useEffect(() => {
      if (wsStatus === 'open') return;
      const t = setInterval(() => window.API.get('/api/state').then(setSnapshot).catch(() => {}), 15000);
      return () => clearInterval(t);
    }, [wsStatus]);

    const ctx = { snapshot, config, setConfig, reloadConfig, wsStatus };
    const Body = { overview: window.Overview, control: window.Control, history: window.History, settings: window.Settings }[route] || window.Overview;
    const alertCount = (snapshot && snapshot.alerts && snapshot.alerts.length) || 0;

    return (
      <window.AppContext.Provider value={ctx}>
        <nav className="tabbar">
          {TABS.map((t) => (
            <button key={t.id} className={route === t.id ? 'active' : ''} onClick={() => { location.hash = `#/${t.id}`; }}>
              {t.icon}<span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="shell">
          <header className="topbar">
            <h1>Mining <span>Heater</span></h1>
            {alertCount > 0 && (
              <a href="#/history" className="badge warn" title="Recent alerts — see History tab">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a4 4 0 00-4 4v3L2.5 11v1h11v-1L12 8V5a4 4 0 00-4-4zM6.5 13a1.5 1.5 0 003 0h-3z" /></svg>
                {alertCount}
              </a>
            )}
            <span className={`ws-dot ${wsStatus === 'open' ? 'open' : ''}`} title={`live feed: ${wsStatus}`} />
          </header>
          {wsStatus !== 'open' && (
            <div className="banner grey">
              <span className="spin" />
              <span className="msg">{wsStatus === 'connecting' ? 'connecting…' : 'reconnecting…'} — live feed is down, showing last known data</span>
            </div>
          )}
          <Body />
          <footer className="muted" style={{ fontSize: 11, textAlign: 'center', padding: '18px 0 8px' }}>
            {snapshot && snapshot.version ? `mining-heater v${snapshot.version}` : ''}
          </footer>
        </div>
      </window.AppContext.Provider>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
