// control.js — Control tab: one panel per miner (mode + dry-run + manual controls
// in a single card, compact for offline miners) and the heat-demand editor
// (off / manual kW / thermostat with live room temp / paintable 7×24 weekly
// schedule with presets, copy-day and weekday/weekend fill).
(() => {
  const { useState, useContext, useRef } = React;
  const { Card, Badge, Button, Toggle, NumberField, Modal, Segmented, Stepper, useApi, predictEnvelope, fmtNum, fmtThs } = window.UI;

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // schedule slot = day*24+hour, Monday first
  const POWER_PRESETS = [{ name: 'Low', w: 2000 }, { name: 'Med', w: 3250 }, { name: 'High', w: 3500 }];

  const savePartial = async (app, partial) => {
    const res = await window.API.put('/api/config', partial);
    if (res && res.version != null) app.setConfig(res); else app.reloadConfig();
  };

  // ---- mode selector (inline segmented, confirm via modal) ----
  function ModeControl({ app, cfgMiner, liveMiner }) {
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
      <>
        <Segmented value={mode} onChange={(m) => setPending(m)}
          options={[{ value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }, { value: 'off', label: 'Off' }]} />
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
      </>
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
      thermostat: { targetC: 21, bandC: 2, maxKW: 3.5, idleOffsetC: 1.5, ...(heating.thermostat || {}) },
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
        await savePartial(app, { heating: {
          demandSource: draft.demandSource,
          manualKW: Number(draft.manualKW) || 0,
          thermostat: {
            targetC: Number(draft.thermostat.targetC) || 21,
            bandC: Number(draft.thermostat.bandC) || 2,
            maxKW: Number(draft.thermostat.maxKW) || 0,
            idleOffsetC: Number(draft.thermostat.idleOffsetC) || 0,
          },
          schedule: draft.demandSource === 'schedule' ? draft.schedule : (heating.schedule || null),
          presets: draft.presets.map((p) => ({ name: p.name, kw: Number(p.kw) || 0 })),
        } });
        setMsg({ ok: true, text: 'Saved.' });
      } catch (e) { setMsg({ ok: false, text: e.message }); }
      setBusy(false);
    };
    const liveHeating = (app.snapshot && app.snapshot.heating) || {};
    const roomC = liveHeating.roomTempC;
    const th = draft.thermostat;
    const setTh = (patch) => set({ thermostat: { ...th, ...patch } });
    // Same modulation formula as the server — preview what the saved settings would ask for.
    const previewKW = roomC == null ? null
      : Math.round(Math.min(1, Math.max(0, (Number(th.targetC) - roomC) / Math.max(0.5, Number(th.bandC)))) * (Number(th.maxKW) || 0) * 100) / 100;
    return (
      <Card className="wide" title="Heat demand" actions={<Button small tone="accent" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>}>
        <div className="mb">
          <Segmented small value={draft.demandSource} onChange={(v) => set({ demandSource: v })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'thermostat', label: 'Thermostat' },
              { value: 'manual', label: 'Manual kW' },
              { value: 'schedule', label: 'Weekly schedule' },
            ]} />
        </div>
        {draft.demandSource === 'off' && <div className="muted">No heat demand — the engine mines only when profitable.</div>}
        {draft.demandSource === 'manual' && (
          <div style={{ maxWidth: 220 }}>
            <NumberField label="Constant heat demand" unit="kW" step={0.1} min={0} value={draft.manualKW} onChange={(v) => set({ manualKW: v })} />
          </div>
        )}
        {draft.demandSource === 'thermostat' && (
          <div>
            <div className="thermo-now mb">
              <Stepper value={Number(th.targetC)} step={0.5} min={5} max={35} unit="°C"
                fmt={(v) => fmtNum(v, 1)} onChange={(v) => setTh({ targetC: v })} />
              <div>
                <div style={{ fontSize: 15 }}>
                  Room now: <b className="mono">{roomC != null ? `${fmtNum(roomC, 1)} °C` : 'no reading'}</b>
                  {previewKW != null && <span className="muted"> → would ask for <b>{fmtNum(previewKW, 1)} kW</b> of heat</span>}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  measured by the miner's hashboard intake sensors{roomC == null ? ' — miner must be online' : ''}
                </div>
              </div>
            </div>
            <div className="frow" style={{ maxWidth: 560 }}>
              <NumberField label="Full power when this far below target" unit="°C" step={0.5} min={0.5} max={10}
                value={th.bandC} onChange={(v) => setTh({ bandC: v })} defaultHint={2} />
              <NumberField label="Max heat demand" unit="kW" step={0.1} min={0}
                value={th.maxKW} onChange={(v) => setTh({ maxKW: v })} defaultHint={3.5} />
              <NumberField label="Idle sensor offset" unit="°C" step={0.5} min={0} max={10}
                value={th.idleOffsetC} onChange={(v) => setTh({ idleOffsetC: v })} defaultHint={1.5} />
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Demand ramps from 0 at the target down to full power {fmtNum(th.bandC, 1)} °C below it.
              The engine still weighs heat against electricity prices — with an alternative heat source configured,
              it only runs the miner when that is the cheaper way to make the heat.
            </p>
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

  // ---- manual controls (body of the per-miner panel) ----
  function ManualControls({ cfgMiner, liveMiner }) {
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
      <div className="mt">
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
      </div>
    );
  }

  // ---- dry-run toggle (inline) ----
  function DryRunControl({ cfgMiner, liveMiner }) {
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
      <div className="mt">
        <Toggle checked={!!dryRun} disabled={busy}
          label={dryRun
            ? 'Dry run — planning only, never touches the miner. Flip to go live.'
            : 'Live — the controller actuates the miner. Flip to re-enter dry run.'}
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
      </div>
    );
  }

  // ---- one panel per miner: status + mode + dry-run + manual controls ----
  function MinerPanel({ app, cfgMiner, liveMiner }) {
    const online = !!(liveMiner && liveMiner.online);
    const dryRun = liveMiner ? liveMiner.dryRun : cfgMiner.dryRun;
    const [showOffline, setShowOffline] = useState(false);
    if (!online && !showOffline) {
      return (
        <Card title={<>{cfgMiner.name} <span className="muted mono" style={{ textTransform: 'none' }}>{cfgMiner.ip}</span></>}
          actions={<>
            <Badge tone="crit">offline</Badge>
            {dryRun ? <Badge tone="accent">dry run</Badge> : <Badge tone="ok">live</Badge>}
            <Button small tone="ghost" onClick={() => setShowOffline(true)}>Show controls</Button>
          </>}>
          <div className="muted" style={{ fontSize: 13 }}>Unreachable — controls hidden until it comes back (or expand them).</div>
        </Card>
      );
    }
    return (
      <Card className="wide" title={<>{cfgMiner.name} <span className="muted mono" style={{ textTransform: 'none' }}>{cfgMiner.ip}</span></>}
        actions={<>
          {online ? <Badge tone="ok">online</Badge> : <Badge tone="crit">offline</Badge>}
          {dryRun ? <Badge tone="accent">dry run</Badge> : <Badge tone="ok">live</Badge>}
        </>}>
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <ModeControl app={app} cfgMiner={cfgMiner} liveMiner={liveMiner} />
        </div>
        <DryRunControl cfgMiner={cfgMiner} liveMiner={liveMiner} />
        <ManualControls cfgMiner={cfgMiner} liveMiner={liveMiner} />
      </Card>
    );
  }

  function Control() {
    const app = useContext(window.AppContext);
    if (!app.config) return <div className="muted" style={{ padding: 30, textAlign: 'center' }}>Loading config…</div>;
    const liveById = {};
    for (const m of (app.snapshot && app.snapshot.miners) || []) liveById[m.id] = m;
    const cfgMiners = app.config.miners || [];
    const online = cfgMiners.filter((m) => liveById[m.id] && liveById[m.id].online);
    const offline = cfgMiners.filter((m) => !liveById[m.id] || !liveById[m.id].online);
    return (
      <div className="grid">
        <HeatDemand app={app} />
        {online.map((cm) => <MinerPanel key={cm.id} app={app} cfgMiner={cm} liveMiner={liveById[cm.id]} />)}
        {offline.map((cm) => <MinerPanel key={cm.id} app={app} cfgMiner={cm} liveMiner={liveById[cm.id]} />)}
      </div>
    );
  }

  window.Control = Control;
})();
