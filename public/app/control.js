// control.js — Control tab: mode selector (with confirm), heat-demand editor
// (off / manual kW / paintable 7×24 weekly schedule with presets, copy-day and
// weekday/weekend fill), manual panel (board toggles + envelope-predicted power
// slider + Low/Med/High presets, pause/resume), and the dry-run toggle.
(() => {
  const { useState, useContext, useRef } = React;
  const { Card, Badge, Button, Toggle, NumberField, Modal, useApi, predictEnvelope, fmtNum, fmtThs } = window.UI;

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // schedule slot = day*24+hour, Monday first
  const POWER_PRESETS = [{ name: 'Low', w: 2000 }, { name: 'Med', w: 3250 }, { name: 'High', w: 3500 }];

  const savePartial = async (app, partial) => {
    const res = await window.API.put('/api/config', partial);
    if (res && res.version != null) app.setConfig(res); else app.reloadConfig();
  };

  // ---- mode selector ----
  function ModeSelector({ app, cfgMiner, liveMiner }) {
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const mode = liveMiner ? liveMiner.mode : cfgMiner.mode;
    const apply = async () => {
      setBusy(true); setErr(null);
      try {
        const miners = app.config.miners.map((m) => m.id === cfgMiner.id ? { ...m, mode: pending } : m);
        await savePartial(app, { miners });
        setPending(null);
      } catch (e) { setErr(e.message); }
      setBusy(false);
    };
    const desc = { auto: 'the engine picks the best operating point every tick (safety always supervises)',
      manual: 'you set boards and power target; the engine only enforces safety',
      off: 'the controller keeps the miner paused (safety still monitored)' };
    return (
      <Card title={`Mode — ${cfgMiner.name}`}>
        <div className="btn-row">
          {['auto', 'manual', 'off'].map((m) => (
            <Button key={m} tone={mode === m ? 'accent' : ''} onClick={() => m !== mode && setPending(m)}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </Button>
          ))}
        </div>
        {err && <div className="err-text mt">{err}</div>}
        {pending && (
          <Modal title={`Switch to ${pending.toUpperCase()}?`} onClose={() => setPending(null)}
            actions={<>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button tone="accent" disabled={busy} onClick={apply}>{busy ? 'Saving…' : `Switch to ${pending}`}</Button>
            </>}>
            <p>In <b>{pending}</b> mode, {desc[pending]}.</p>
          </Modal>
        )}
      </Card>
    );
  }

  // ---- weekly paint grid ----
  function WeekGrid({ schedule, presets, onPaint }) {
    const painting = useRef(false);
    const maxKW = Math.max(0.5, ...presets.map((p) => p.kw || 0), ...schedule);
    const paintAt = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (el && el.dataset && el.dataset.idx != null) onPaint(Number(el.dataset.idx));
    };
    return (
      <div className="paint-grid mt"
        onPointerDown={(e) => { painting.current = true; paintAt(e.clientX, e.clientY); }}
        onPointerMove={(e) => { if (painting.current) paintAt(e.clientX, e.clientY); }}
        onPointerUp={() => { painting.current = false; }}
        onPointerLeave={() => { painting.current = false; }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="hlab">{h % 6 === 0 ? h : ''}</span>)}
        {DAYS.map((d, day) => (
          <React.Fragment key={d}>
            <span className="dlab">{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const idx = day * 24 + h, kw = schedule[idx] || 0;
              return <span key={h} className="cell" data-idx={idx} title={`${d} ${h}:00 — ${kw} kW`}
                style={kw > 0 ? { background: `rgba(247,147,26,${0.25 + 0.75 * Math.min(1, kw / maxKW)})` } : null} />;
            })}
          </React.Fragment>
        ))}
      </div>
    );
  }

  // ---- heat demand editor ----
  function HeatDemand({ app }) {
    const heating = app.config.heating || {};
    const [draft, setDraft] = useState(() => ({
      demandSource: heating.demandSource || 'off',
      manualKW: heating.manualKW || 0,
      schedule: Array.isArray(heating.schedule) && heating.schedule.length === 168 ? [...heating.schedule] : new Array(168).fill(0),
      presets: (heating.presets && heating.presets.length ? heating.presets : [{ name: 'Off', kw: 0 }, { name: 'Eco', kw: 1.0 }, { name: 'Comfort', kw: 2.5 }]).slice(0, 4).map((p) => ({ ...p })),
    }));
    const [sel, setSel] = useState(1);
    const [copyDay, setCopyDay] = useState(0);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    if (!draft) return null;
    const set = (patch) => setDraft({ ...draft, ...patch });
    const paint = (idx) => {
      const kw = draft.presets[sel] ? (Number(draft.presets[sel].kw) || 0) : 0;
      if (draft.schedule[idx] === kw) return;
      const schedule = [...draft.schedule]; schedule[idx] = kw;
      set({ schedule });
    };
    const copyTo = (days) => {
      const schedule = [...draft.schedule];
      const src = draft.schedule.slice(copyDay * 24, copyDay * 24 + 24);
      for (const d of days) for (let h = 0; h < 24; h++) schedule[d * 24 + h] = src[h];
      set({ schedule });
    };
    const save = async () => {
      setBusy(true); setMsg(null);
      try {
        await savePartial(app, { heating: { demandSource: draft.demandSource, manualKW: Number(draft.manualKW) || 0, schedule: draft.demandSource === 'schedule' ? draft.schedule : (heating.schedule || null), presets: draft.presets.map((p) => ({ name: p.name, kw: Number(p.kw) || 0 })) } });
        setMsg({ ok: true, text: 'Saved.' });
      } catch (e) { setMsg({ ok: false, text: e.message }); }
      setBusy(false);
    };
    return (
      <Card className="wide" title="Heat demand" actions={<Button small tone="accent" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>}>
        <div className="btn-row mb">
          {[['off', 'Off'], ['manual', 'Manual kW'], ['schedule', 'Weekly schedule']].map(([v, l]) => (
            <Button key={v} small tone={draft.demandSource === v ? 'accent' : ''} onClick={() => set({ demandSource: v })}>{l}</Button>
          ))}
        </div>
        {draft.demandSource === 'off' && <div className="muted">No heat demand — the engine mines only when profitable.</div>}
        {draft.demandSource === 'manual' && (
          <div style={{ maxWidth: 220 }}>
            <NumberField label="Constant heat demand" unit="kW" step={0.1} min={0} value={draft.manualKW} onChange={(v) => set({ manualKW: v })} />
          </div>
        )}
        {draft.demandSource === 'schedule' && (
          <div>
            <div className="chips">
              {draft.presets.map((p, i) => (
                <span key={i} className={`chip ${sel === i ? 'sel' : ''}`} onClick={() => setSel(i)}>
                  {p.name}
                  <input type="number" step="0.1" min="0" value={p.kw} onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { const presets = draft.presets.map((q, j) => j === i ? { ...q, kw: e.target.value === '' ? 0 : Number(e.target.value) } : q); set({ presets }); }} /> kW
                </span>
              ))}
              <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>pick a preset, then click-drag to paint</span>
            </div>
            <WeekGrid schedule={draft.schedule} presets={draft.presets} onPaint={paint} />
            <div className="btn-row mt">
              <select className="btn small" value={copyDay} onChange={(e) => setCopyDay(Number(e.target.value))} style={{ background: 'var(--card2)' }}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
              <Button small onClick={() => copyTo([0, 1, 2, 3, 4, 5, 6])}>Copy to all days</Button>
              <Button small onClick={() => copyTo([0, 1, 2, 3, 4])}>Copy to weekdays</Button>
              <Button small onClick={() => copyTo([5, 6])}>Copy to weekend</Button>
            </div>
          </div>
        )}
        {msg && <div className={`mt ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</div>}
      </Card>
    );
  }

  // ---- manual panel (per miner) ----
  function ManualPanel({ cfgMiner, liveMiner }) {
    const id = cfgMiner.id;
    const env = useApi(`/api/miners/${id}/envelope`, [id]);
    const limits = cfgMiner.limits || {};
    const minW = limits.minTargetW || 944, maxW = limits.maxTargetW || 3500;
    const liveBoards = (liveMiner && liveMiner.hw && liveMiner.hw.boards) || [];
    const [targetW, setTargetW] = useState(() => (liveMiner && liveMiner.power && liveMiner.power.targetW) || minW);
    const [pending, setPending] = useState(null); // {id: bool} — lazily seeded from live state
    const [force, setForce] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const boardState = pending || Object.fromEntries(liveBoards.map((b) => [b.id, !!b.enabled]));
    const enabledCount = Object.values(boardState).filter(Boolean).length;
    const pred = predictEnvelope(env.data, Math.max(1, enabledCount), targetW);
    const isAuto = (liveMiner ? liveMiner.mode : cfgMiner.mode) === 'auto';
    const disabled = isAuto && !force;
    const act = async (body, okText) => {
      setBusy(true); setMsg(null);
      try {
        await window.API.post(`/api/miners/${id}/action`, isAuto ? { ...body, force: true } : body);
        setMsg({ ok: true, text: okText });
      } catch (e) { setMsg({ ok: false, text: e.message }); }
      setBusy(false);
    };
    const applyBoards = () => {
      const enableIds = [], disableIds = [];
      for (const b of liveBoards) {
        const want = !!boardState[b.id];
        if (want && !b.enabled) enableIds.push(String(b.id));
        if (!want && b.enabled) disableIds.push(String(b.id));
      }
      if (!enableIds.length && !disableIds.length) { setMsg({ ok: true, text: 'Boards already match.' }); return; }
      act({ type: 'setBoards', enableIds, disableIds }, `Boards updated (${enableIds.length} on, ${disableIds.length} off).`);
    };
    return (
      <Card title={`Manual control — ${cfgMiner.name}`}
        actions={isAuto && <Badge tone="warn">auto mode</Badge>}>
        {isAuto && (
          <div className="mb">
            <Toggle checked={force} onChange={setForce} label="Force manual changes while in Auto (the engine may adjust again next tick)" />
          </div>
        )}
        <div className="mb">
          <div className="flabel muted mb" style={{ fontSize: 12 }}>Hashboards</div>
          <div className="btn-row">
            {liveBoards.map((b) => (
              <Toggle key={b.id} disabled={disabled || busy} checked={!!boardState[b.id]} label={`Board ${b.id}`}
                onChange={(v) => setPending({ ...boardState, [b.id]: v })} />
            ))}
            {!liveBoards.length && <span className="muted">no board data (miner offline?)</span>}
            <Button small disabled={disabled || busy || !liveBoards.length} onClick={applyBoards}>Apply boards</Button>
          </div>
        </div>
        <div className="mb">
          <div className="flabel muted" style={{ fontSize: 12 }}>Power target: <b className="mono" style={{ color: 'var(--text)' }}>{targetW} W</b>
            <span className="muted"> → predicted {fmtThs(pred.hashrateThs)}, ~{fmtNum(pred.wallW / 1000, 2)} kW heat{pred.source === 'model' ? ' (model est.)' : ''}</span>
          </div>
          <input type="range" min={minW} max={maxW} step={50} value={targetW} disabled={disabled || busy}
            onChange={(e) => setTargetW(Number(e.target.value))} />
          <div className="btn-row">
            {POWER_PRESETS.map((p) => (
              <Button key={p.name} small disabled={disabled || busy}
                onClick={() => setTargetW(Math.min(maxW, Math.max(minW, p.w)))}>{p.name} {p.w} W</Button>
            ))}
            <Button small tone="accent" disabled={disabled || busy} onClick={() => act({ type: 'setPower', targetW }, `Power target set to ${targetW} W.`)}>Apply power</Button>
          </div>
        </div>
        <div className="btn-row">
          <Button small disabled={disabled || busy} onClick={() => act({ type: 'pause' }, 'Pause requested.')}>Pause</Button>
          <Button small disabled={disabled || busy} onClick={() => act({ type: 'resume' }, 'Resume requested.')}>Resume</Button>
        </div>
        {msg && <div className={`mt ${msg.ok ? 'ok-text' : 'err-text'}`}>{msg.text}</div>}
      </Card>
    );
  }

  // ---- dry-run toggle ----
  function DryRunCard({ cfgMiner, liveMiner }) {
    const dryRun = liveMiner ? liveMiner.dryRun : cfgMiner.dryRun;
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const post = async (body) => {
      setBusy(true); setErr(null);
      try { await window.API.post(`/api/miners/${cfgMiner.id}/action`, body); setConfirming(false); }
      catch (e) { setErr(e.message); }
      setBusy(false);
    };
    return (
      <Card title={`Dry run — ${cfgMiner.name}`} actions={dryRun ? <Badge tone="accent">observing only</Badge> : <Badge tone="ok">live</Badge>}>
        <p className="muted mb" style={{ fontSize: 13 }}>
          In dry run the controller logs every decision and what it <i>would have</i> done, but never touches the miner.
        </p>
        <Toggle checked={!!dryRun} disabled={busy}
          label={dryRun ? 'Dry run enabled — flip to go live (asks to confirm)' : 'Live — flip to re-enter dry run'}
          onChange={(v) => { if (v) post({ type: 'dryRun', enabled: true }); else setConfirming(true); }} />
        {err && <div className="err-text mt">{err}</div>}
        {confirming && (
          <Modal title="Go live?" onClose={() => setConfirming(false)}
            actions={<>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button tone="accent" disabled={busy} onClick={() => post({ type: 'goLive' })}>{busy ? '…' : 'Go live'}</Button>
            </>}>
            <p>The controller will start actuating the miner according to its plan.</p>
          </Modal>
        )}
      </Card>
    );
  }

  function Control() {
    const app = useContext(window.AppContext);
    if (!app.config) return <div className="muted" style={{ padding: 30, textAlign: 'center' }}>Loading config…</div>;
    const liveById = {};
    for (const m of (app.snapshot && app.snapshot.miners) || []) liveById[m.id] = m;
    return (
      <div className="grid">
        {(app.config.miners || []).map((cm) => (
          <React.Fragment key={cm.id}>
            <ModeSelector app={app} cfgMiner={cm} liveMiner={liveById[cm.id]} />
            <DryRunCard cfgMiner={cm} liveMiner={liveById[cm.id]} />
            <ManualPanel cfgMiner={cm} liveMiner={liveById[cm.id]} />
          </React.Fragment>
        ))}
        <HeatDemand app={app} />
      </div>
    );
  }

  window.Control = Control;
})();
