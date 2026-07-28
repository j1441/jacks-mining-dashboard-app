// overview.js — Overview tab: statusLine banner (dry-run / migration variants with
// Go-live flow), hero stats, 48h price strip with plan overlay + full plan table,
// per-miner hardware card with board slots, and the effective-SCOP stat.
(() => {
  const { useState, useContext } = React;
  const { Card, Stat, Badge, Button, Modal, BarStrip, fmtNum, fmtNok, fmtW, fmtThs, fmtHour, fmtDay } = window.UI;

  const describeChosen = (chosen) => {
    if (!chosen) return 'no action';
    if (chosen.off) return 'turn the miner OFF';
    return `run ${chosen.boards} board${chosen.boards === 1 ? '' : 's'} @ ${chosen.targetW} W`;
  };

  // ---- status banner (per miner) ----
  function StatusBanner({ miner }) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const ctl = miner.controller || {};
    const goLive = async () => {
      setBusy(true); setErr(null);
      try { await window.API.post(`/api/miners/${miner.id}/action`, { type: 'goLive' }); setConfirming(false); }
      catch (e) { setErr(e.message); }
      setBusy(false);
    };
    if (miner.dryRun) {
      return (
        <div className="banner dry">
          <Badge tone="accent">DRY RUN</Badge>
          <span className="msg">
            Observing only — {ctl.wouldHave ? <>would have: <b>{ctl.wouldHave}</b></> : 'no action needed right now'}.
            {ctl.dryRunActionCount > 0 && <span className="muted"> {ctl.dryRunActionCount} would-have action{ctl.dryRunActionCount === 1 ? '' : 's'} so far.</span>}
            {ctl.migrationNotice && <div className="muted mt" style={{ fontSize: 13 }}>
              v2 has a new control engine; it is planning but NOT adjusting your miner — review its plan below, then Go live.</div>}
          </span>
          <Button tone="accent" onClick={() => setConfirming(true)}>Go live</Button>
          {confirming && (
            <Modal title={`Go live — ${miner.name}`} onClose={() => setConfirming(false)}
              actions={<>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
                <Button tone="accent" disabled={busy} onClick={goLive}>{busy ? 'Going live…' : 'Confirm — go live'}</Button>
              </>}>
              <p>The controller will start actuating the miner. Its first action will be to <b>{describeChosen(ctl.trace && ctl.trace.chosen)}</b>.</p>
              <p className="muted mt" style={{ fontSize: 13 }}>Safety supervision stays active in every mode. You can re-enter dry run any time from the Control tab.</p>
              {err && <div className="err-text mt">{err}</div>}
            </Modal>
          )}
        </div>
      );
    }
    const sev = miner.statusSeverity === 'critical' ? 'critical' : miner.statusSeverity === 'warn' ? 'warn' : 'ok';
    return (
      <div className={`banner ${sev}`}>
        <Badge tone={sev === 'ok' ? 'ok' : sev === 'warn' ? 'warn' : 'crit'}>{miner.name}</Badge>
        <span className="msg">{miner.statusLine || (miner.online ? 'Running.' : 'Miner offline.')}</span>
      </div>
    );
  }

  // ---- 48h price strip + expandable plan table ----
  function PriceStrip({ market, miner }) {
    const [expanded, setExpanded] = useState(false);
    const plan = (miner && miner.plan) || [];
    const planBy = {};
    for (const r of plan) planBy[new Date(r.hourStartIso).getTime()] = r;
    const base = [...(market.today || []), ...(market.tomorrow || [])];
    const nowH = new Date(); nowH.setMinutes(0, 0, 0);
    const hours = base.map((h) => {
      const t = new Date(h.hourStartIso).getTime();
      const p = planBy[t];
      return {
        label: fmtHour(h.hourStartIso), iso: h.hourStartIso, isNow: t === nowH.getTime(),
        price: p ? p.marginalPrice : h.spotNok, regime: p ? p.regime : null,
        plannedW: p ? (p.off ? 0 : p.targetW) : null, off: p ? p.off : null, row: p,
      };
    }).slice(0, 48);
    const planRows = plan.filter((r) => new Date(r.hourStartIso).getTime() >= nowH.getTime());
    const totNet = planRows.reduce((a, r) => a + (r.expNetNokH || 0), 0);
    const totHeat = planRows.reduce((a, r) => a + (r.expHeatKW || 0), 0);
    return (
      <Card className="wide" title="Prices & plan — next 48h"
        actions={<Button small tone="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide plan table' : 'Full plan table'}</Button>}>
        <BarStrip hours={hours} />
        {expanded && (
          <div className="scroll-x mt">
            <table className="plain">
              <thead><tr><th>Hour</th><th>kr/kWh</th><th>Regime</th><th>Boards</th><th>Target</th><th>Heat kW</th><th>Net kr/h</th></tr></thead>
              <tbody>
                {planRows.map((r) => (
                  <tr key={r.hourStartIso} className={new Date(r.hourStartIso).getTime() === nowH.getTime() ? 'now' : ''}>
                    <td>{fmtDay(r.hourStartIso)} {fmtHour(r.hourStartIso)}</td>
                    <td>{fmtNum(r.marginalPrice, 2)}</td>
                    <td>{r.regime === 'over-cap' ? <Badge tone="crit">over-cap</Badge> : <Badge tone="ok">subsidised</Badge>}</td>
                    <td>{r.off ? '—' : r.boards}</td>
                    <td>{r.off ? 'OFF' : `${r.targetW} W`}</td>
                    <td>{fmtNum(r.expHeatKW, 1)}</td>
                    <td style={{ color: (r.expNetNokH || 0) >= 0 ? 'var(--ok)' : 'var(--crit)' }}>{fmtNum(r.expNetNokH, 2)}</td>
                  </tr>
                ))}
                <tr className="total"><td>Total ({planRows.length} h)</td><td /><td /><td /><td /><td>{fmtNum(totHeat, 1)} kWh</td><td>{fmtNum(totNet, 2)} kr</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  }

  // ---- miner hardware card ----
  function MinerCard({ miner }) {
    const hw = miner.hw || {};
    const boards = hw.boards || [];
    const slots = [...boards].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const tuner = (hw.tunerState || 'UNKNOWN').toUpperCase();
    // BOSer keeps reporting a stale TUNING/PREHEAT indefinitely when a pause
    // interrupts a re-tune (see the tuning-hold note in lib/engine.js, seen live
    // 2026-07-24), so a paused miner showed a spinning "tuning" badge forever.
    // The engine already ignores the tuner state while paused; so does this.
    const staleTune = miner.paused && (tuner === 'TUNING' || tuner === 'PREHEAT');
    const tuning = !miner.paused && (tuner === 'TUNING' || tuner === 'PREHEAT');
    const pool = miner.pool || {};

    // Board state, mirroring the dead-board rule in lib/alerts.js: a board is
    // only suspect when it is enabled AND not hashing AND the miner is neither
    // paused nor mid-tune. Previously any enabled non-hashing board rendered
    // "FAULT" in red, so every deliberate pause — setpoint reached, price too
    // high — looked like hardware failure.
    // Even the unexplained case says "idle", not "fault": the authoritative
    // signal is the dead-board alert, which also requires 10 minutes of it.
    const boardState = (b) => {
      if (!b.enabled) return { cls: 'off', label: 'off' };
      if (b.hashing) return { cls: 'hashing', label: fmtThs(b.hashrateThs) };
      if (miner.paused) return { cls: 'paused', label: 'paused' };
      if (tuning) return { cls: 'tuning', label: 'tuning' };
      if (!miner.online) return { cls: 'off', label: '–' };
      return { cls: 'idle', label: 'idle' };
    };
    return (
      <Card title={<>{miner.name} <span className="muted mono" style={{ textTransform: 'none' }}>{miner.ip}</span></>}
        actions={<>
          {miner.online ? <Badge tone="ok">online</Badge> : <Badge tone="crit">offline</Badge>}
          {miner.paused && <Badge>paused</Badge>}
          <Badge>{(miner.mode || '').toUpperCase()}</Badge>
          {!staleTune && (
            <Badge tone={tuning ? 'warn' : tuner === 'ERROR' ? 'crit' : ''} spin={tuning}>{tuner.toLowerCase()}</Badge>
          )}
        </>}>
        <div className="boards mb">
          {slots.map((b) => {
            const st = boardState(b);
            return (
              <div key={b.id} className={`board-slot ${st.cls}`}>
                <div className="bid">Board {b.id}</div>
                <div>{st.label}</div>
                <div className="muted">chip {b.chipTempC != null ? `${fmtNum(b.chipTempC, 0)}°` : '–'} · pcb {b.boardTempC != null ? `${fmtNum(b.boardTempC, 0)}°` : '–'}{b.inletTempC != null ? ` · in ${fmtNum(b.inletTempC, 0)}°` : ''}</div>
              </div>
            );
          })}
          {!slots.length && <div className="muted">no board data</div>}
        </div>
        {/* While paused the miner draws nothing, so the effective target is 0 —
            showing the tuner's configured 944 W beside a 0 W wall reading looked
            like a fault. The configured value is kept as a muted hint. */}
        <div className="kv"><span className="k">Power target / wall</span><span className="v mono">
          {miner.paused
            ? <>0 W / {fmtW(miner.power && miner.power.wallW)} <span className="muted">(tuner set {fmtW(miner.power && miner.power.targetW)})</span></>
            : <>{fmtW(miner.power && miner.power.targetW)} / {fmtW(miner.power && miner.power.wallW)}</>}
        </span></div>
        <div className="kv"><span className="k">Fans</span><span className="v mono">{(hw.fans || []).map((f) => `${f.rpm} rpm`).join(' · ') || '–'} <span className="muted">({hw.coolingMode || '?'})</span></span></div>
        <div className="kv"><span className="k">Hottest chip</span><span className="v mono">{hw.chipTempMax != null ? `${fmtNum(hw.chipTempMax, 0)} °C` : '–'}</span></div>
        <div className="kv"><span className="k">Pool</span>
          <span className="v">{pool.url || '–'} {pool.failoverActive && <Badge tone="warn">failover</Badge>}
            {pool.rejectRatePct != null && <span className="muted"> {fmtNum(pool.rejectRatePct, 1)}% rej</span>}</span>
        </div>
      </Card>
    );
  }

  // One compact card listing all offline miners instead of a full card + banner each.
  function OfflineMiners({ miners }) {
    if (!miners.length) return null;
    return (
      <Card title={`Offline miners (${miners.length})`}>
        {miners.map((m) => (
          <div key={m.id} className="rowline">
            <Badge tone="crit">offline</Badge>
            <span className="grow"><b>{m.name}</b> <span className="muted mono">{m.ip}</span></span>
            {m.dryRun && <Badge tone="accent">dry run</Badge>}
            <Badge>{(m.mode || '').toUpperCase()}</Badge>
          </div>
        ))}
        <p className="muted mt" style={{ fontSize: 12 }}>
          Unplugged or unreachable. They rejoin automatically when they come back on the network.
        </p>
      </Card>
    );
  }

  function Overview() {
    const app = useContext(window.AppContext);
    const snap = app.snapshot;
    if (!snap) return <div className="muted" style={{ padding: 30, textAlign: 'center' }}>Loading…</div>;
    const market = snap.market || {};
    const heating = snap.heating || {};
    const miners = snap.miners || [];
    const online = miners.filter((m) => m.online);
    const offline = miners.filter((m) => !m.online);
    const totalThs = miners.reduce((a, m) => a + ((m.hashrate && (m.hashrate.m15 ?? m.hashrate.m1)) || 0), 0);
    const totalW = miners.reduce((a, m) => a + ((m.power && m.power.wallW) || 0), 0);
    const totalNetDay = miners.reduce((a, m) => a + ((m.economics && m.economics.netNokDay) || 0), 0);
    const scop = miners.length ? miners[0].economics && miners[0].economics.effectiveScop : null;
    const thermoZones = (heating.zones || []).filter((z) => z.demandSource === 'thermostat');
    return (
      <div>
        {online.map((m) => <StatusBanner key={m.id} miner={m} />)}
        <div className="stats mb">
          <Stat label="Hashrate" value={fmtThs(totalThs)} sub="15 min avg" />
          <Stat label="Heat output" value={fmtW(totalW)} sub="wall power = heat into the room" />
          {thermoZones.map((z) => (
            <Stat key={z.id} label={`${z.name} — room`}
              value={z.roomTempC != null ? `${fmtNum(z.roomTempC, 1)} °C` : '–'}
              tone={z.roomTempC != null && z.thermostat && z.roomTempC < z.thermostat.targetC ? 'warn' : null}
              sub={z.thermostat ? `target ${fmtNum(z.thermostat.targetC, 1)} °C · asking ${fmtNum(z.demandKW, 1)} kW` : null} />
          ))}
          <Stat label="Net" value={fmtNok(totalNetDay, 0) + '/day'} tone={totalNetDay >= 0 ? 'ok' : 'crit'}
            sub={miners[0] && miners[0].economics ? `${fmtNum(miners[0].economics.netNokH, 2)} kr/h now` : null} />
          <Stat label="Price now" value={fmtNum(market.currentMarginal, 2) + ' kr'}
            sub={<Badge tone={market.regime === 'over-cap' ? 'crit' : 'ok'}>{market.regime || '?'}</Badge>} />
          <Stat label="Effective SCOP" value={scop != null ? fmtNum(scop, 1) : '–'} sub="heat cost vs heat pump" />
        </div>
        <div className="grid">
          {(online[0] || miners[0]) && <PriceStrip market={market} miner={online[0] || miners[0]} />}
          {online.map((m) => <MinerCard key={m.id} miner={m} />)}
          <OfflineMiners miners={offline} />
          {!miners.length && <Card title="No miners">Add a miner in Settings.</Card>}
        </div>
      </div>
    );
  }

  window.Overview = Overview;
})();
