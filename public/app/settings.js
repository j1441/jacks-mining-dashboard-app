// settings.js — Settings tab: forms bound to GET/PUT /api/config (sentinel-aware:
// secrets round-trip as '•••' and the server ignores unchanged sentinels), miner
// connection + test, electricity, alerts (+ test), and a collapsed Advanced tuning
// section showing defaults beside each field with one-click reset.
(() => {
  const { useState, useEffect, useContext } = React;
  const { Badge, Button, Toggle, NumberField, TextField, Select, Section, fmtNum } = window.UI;

  const SENTINEL = '•••';
  // Defaults mirror DESIGN §4.3 / configStore.defaults() — shown as hints and used by reset.
  const DEF = {
    economics: { poolFeePct: 0, startMarginNokH: 0.5, keepMarginNokH: 0.2, boardSwitch: { retuneMin: 45, wearNok: 2 } },
    alt: { type: 'heatpump', scop: 3.0 },
    gridFee: { dayWeekday: 0.50, nightWeekend: 0.30, dayStartHour: 6, nightStartHour: 22 },
    electricity: { householdBaseKWhMonth: 1500, subsidyCapKWhMonth: 5000, timezone: 'Europe/Oslo' },
    rules: { offlineAfterS: 300, hashrateLowPct: 25 },
    miner: {
      limits: { minTargetW: 944, maxTargetW: 3500 },
      dwell: { powerMin: 15, boardsMin: 120, offMin: 20, deadbandW: 100 },
      safety: { derateChipTemp: 80, pauseChipTemp: 90, maxBoardTemp: 75, maxFanRpm: 6100, safetyStepW: 250 },
      cooling: { manage: false, mode: 'auto', targetC: 60 },
      dpsManage: 'leave',
    },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const getIn = (o, path) => path.reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setIn = (o, path, v) => {
    const c = clone(o); let t = c;
    for (let i = 0; i < path.length - 1; i++) {
      if (t[path[i]] == null) t[path[i]] = typeof path[i + 1] === 'number' ? [] : {};
      t = t[path[i]];
    }
    t[path[path.length - 1]] = v;
    return c;
  };

  function Settings() {
    const app = useContext(window.AppContext);
    const [draft, setDraft] = useState(() => (app.config ? clone(app.config) : null));
    const [dirty, setDirty] = useState(false);
    const [saveMsg, setSaveMsg] = useState(null);
    const [busy, setBusy] = useState(false);
    const [tests, setTests] = useState({}); // minerId -> string, 'alerts' -> string
    useEffect(() => { if (app.config && !dirty) setDraft(clone(app.config)); }, [app.config]); // eslint-disable-line
    if (!draft) return <div className="muted" style={{ padding: 30, textAlign: 'center' }}>Loading config…</div>;

    const bind = (path) => ({ value: getIn(draft, path), onChange: (v) => { setDraft(setIn(draft, path, v)); setDirty(true); setSaveMsg(null); } });
    const save = async () => {
      setBusy(true); setSaveMsg(null);
      try {
        const res = await window.API.put('/api/config', draft);
        if (res && res.version != null) app.setConfig(res); else app.reloadConfig();
        setDirty(false);
        setSaveMsg({ ok: true, text: 'Saved.' });
      } catch (e) { setSaveMsg({ ok: false, text: e.message }); }
      setBusy(false);
    };

    const testMiner = async (id) => {
      setTests({ ...tests, [id]: 'testing…' });
      try {
        const st = await window.API.get('/api/state');
        const m = (st.miners || []).find((x) => x.id === id);
        setTests((t) => ({ ...t, [id]: m ? (m.online ? `OK — online (${(m.hw && m.hw.model) || 'miner'}, ${m.hw && m.hw.tunerState})` : 'reachable API, but miner is OFFLINE') : 'miner not found in state' }));
      } catch (e) { setTests((t) => ({ ...t, [id]: `failed: ${e.message}` })); }
    };
    const testAlerts = async () => {
      setTests({ ...tests, alerts: 'sending…' });
      try { await window.API.post('/api/alerts/test', {}); setTests((t) => ({ ...t, alerts: 'test alert sent — check your channels' })); }
      catch (e) { setTests((t) => ({ ...t, alerts: `failed: ${e.message}` })); }
    };

    const resetAdvanced = () => {
      let d = clone(draft);
      d.economics = clone(DEF.economics);
      d.heating = { ...(d.heating || {}), alt: clone(DEF.alt) };
      d.miners = (d.miners || []).map((m) => ({ ...m, limits: { ...m.limits, ...clone(DEF.miner.limits) }, dwell: clone(DEF.miner.dwell), safety: clone(DEF.miner.safety), cooling: clone(DEF.miner.cooling), dpsManage: DEF.miner.dpsManage }));
      setDraft(d); setDirty(true);
    };

    return (
      <div>
        <div className="banner grey">
          <span className="msg">Changes apply after <b>Save</b>. Secret fields showing {SENTINEL} are stored server-side and only overwritten if you type a new value.</span>
          <Button tone="accent" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</Button>
          {saveMsg && <span className={saveMsg.ok ? 'ok-text' : 'err-text'}>{saveMsg.text}</span>}
        </div>

        {(draft.miners || []).map((m, i) => (
          <Section key={m.id || i} title={`Miner — ${m.name || m.ip || `#${i + 1}`}`}>
            <div className="frow">
              <TextField label="Name" {...bind(['miners', i, 'name'])} />
              <TextField label="IP address" {...bind(['miners', i, 'ip'])} />
              <TextField label="Username" {...bind(['miners', i, 'username'])} />
              <TextField label="Password" type="password" placeholder={SENTINEL} {...bind(['miners', i, 'password'])} />
            </div>
            <div className="btn-row">
              <Button small onClick={() => testMiner(m.id)}>Test connection</Button>
              {tests[m.id] && <span className={tests[m.id].startsWith('OK') ? 'ok-text' : 'muted'} style={{ fontSize: 12 }}>{tests[m.id]}</span>}
            </div>
          </Section>
        ))}

        <Section title="Electricity">
          <div className="frow">
            <Select label="Price zone" options={['NO1', 'NO2', 'NO3', 'NO4', 'NO5'].map((z) => ({ value: z, label: z }))} {...bind(['electricity', 'zone'])} />
            <Select label="Price mode" options={[
              { value: 'spot_stromstotte', label: 'Spot + strømstøtte' },
              { value: 'norgespris', label: 'Norgespris (fixed)' },
              { value: 'spot', label: 'Raw spot' },
            ]} {...bind(['electricity', 'priceMode'])} />
            <TextField label="Timezone" defaultHint={DEF.electricity.timezone} {...bind(['electricity', 'timezone'])} />
            <NumberField label="Grid fee, day/weekday" unit="kr/kWh" step={0.01} defaultHint={DEF.gridFee.dayWeekday} {...bind(['electricity', 'gridFee', 'dayWeekday'])} />
            <NumberField label="Grid fee, night/weekend" unit="kr/kWh" step={0.01} defaultHint={DEF.gridFee.nightWeekend} {...bind(['electricity', 'gridFee', 'nightWeekend'])} />
            <NumberField label="Day rate starts" unit="hour" min={0} max={23} defaultHint={DEF.gridFee.dayStartHour} {...bind(['electricity', 'gridFee', 'dayStartHour'])} />
            <NumberField label="Night rate starts" unit="hour" min={0} max={23} defaultHint={DEF.gridFee.nightStartHour} {...bind(['electricity', 'gridFee', 'nightStartHour'])} />
            <NumberField label="Household baseline" unit="kWh/month" defaultHint={DEF.electricity.householdBaseKWhMonth} {...bind(['electricity', 'householdBaseKWhMonth'])} />
            <NumberField label="Subsidy cap" unit="kWh/month" defaultHint={DEF.electricity.subsidyCapKWhMonth} {...bind(['electricity', 'subsidyCapKWhMonth'])} />
          </div>
          <p className="muted" style={{ fontSize: 12 }}>Above the cap, miner kWh are priced at raw spot + VAT + grid fee — the dashboard shows an "over-cap" regime chip when this applies.</p>
        </Section>

        <Section title="Alerts">
          <div className="frow">
            <TextField label="ntfy URL" placeholder="https://ntfy.sh" {...bind(['alerts', 'ntfy', 'url'])} />
            <TextField label="ntfy topic" {...bind(['alerts', 'ntfy', 'topic'])} />
            <TextField label="Telegram bot token" type="password" placeholder={SENTINEL} {...bind(['alerts', 'telegram', 'botToken'])} />
            <TextField label="Telegram chat id" {...bind(['alerts', 'telegram', 'chatId'])} />
            <NumberField label="Offline alert after" unit="s" defaultHint={DEF.rules.offlineAfterS} {...bind(['alerts', 'rules', 'offlineAfterS'])} />
            <NumberField label="Hashrate-low threshold" unit="%" defaultHint={DEF.rules.hashrateLowPct} {...bind(['alerts', 'rules', 'hashrateLowPct'])} />
          </div>
          <div className="btn-row">
            <Button small onClick={testAlerts}>Send test alert</Button>
            {tests.alerts && <span className="muted" style={{ fontSize: 12 }}>{tests.alerts}</span>}
          </div>
        </Section>

        {draft.retentionMonths !== undefined && (
          <Section title="Data retention">
            <div style={{ maxWidth: 220 }}>
              <NumberField label="Keep history" unit="months" defaultHint={12} {...bind(['retentionMonths'])} />
            </div>
          </Section>
        )}

        <Section title="Advanced tuning" collapsed
          right={<Button small tone="ghost" onClick={(e) => { e.stopPropagation(); resetAdvanced(); }}>Reset to defaults</Button>}>
          <h4 className="mb" style={{ fontSize: 13 }}>Economics</h4>
          <div className="frow">
            <NumberField label="Pool fee" unit="%" step={0.1} defaultHint={DEF.economics.poolFeePct} {...bind(['economics', 'poolFeePct'])} />
            <NumberField label="Start margin" unit="kr/h" step={0.05} defaultHint={DEF.economics.startMarginNokH} {...bind(['economics', 'startMarginNokH'])} />
            <NumberField label="Keep margin" unit="kr/h" step={0.05} defaultHint={DEF.economics.keepMarginNokH} {...bind(['economics', 'keepMarginNokH'])} />
            <NumberField label="Board switch: retune time" unit="min" defaultHint={DEF.economics.boardSwitch.retuneMin} {...bind(['economics', 'boardSwitch', 'retuneMin'])} />
            <NumberField label="Board switch: wear cost" unit="kr" step={0.5} defaultHint={DEF.economics.boardSwitch.wearNok} {...bind(['economics', 'boardSwitch', 'wearNok'])} />
          </div>
          <h4 className="mb mt" style={{ fontSize: 13 }}>Alternative heat source</h4>
          <div className="frow">
            <Select label="Type" defaultHint={DEF.alt.type} options={[
              { value: 'heatpump', label: 'Heat pump' }, { value: 'resistive', label: 'Resistive (panel oven)' },
              { value: 'none', label: 'None — miner is the only heater' },
            ]} {...bind(['heating', 'alt', 'type'])} />
            {getIn(draft, ['heating', 'alt', 'type']) === 'heatpump' &&
              <NumberField label="SCOP" step={0.1} defaultHint={fmtNum(DEF.alt.scop, 1)} {...bind(['heating', 'alt', 'scop'])} />}
          </div>
          {(draft.miners || []).map((m, i) => (
            <div key={m.id || i}>
              <h4 className="mb mt" style={{ fontSize: 13 }}>{m.name || m.ip} — limits, dwell, safety, cooling</h4>
              <div className="frow">
                <NumberField label="Min power target" unit="W" defaultHint={DEF.miner.limits.minTargetW} {...bind(['miners', i, 'limits', 'minTargetW'])} />
                <NumberField label="Max power target" unit="W" defaultHint={DEF.miner.limits.maxTargetW} {...bind(['miners', i, 'limits', 'maxTargetW'])} />
                <NumberField label="Power dwell" unit="min" defaultHint={DEF.miner.dwell.powerMin} {...bind(['miners', i, 'dwell', 'powerMin'])} />
                <NumberField label="Boards dwell" unit="min" defaultHint={DEF.miner.dwell.boardsMin} {...bind(['miners', i, 'dwell', 'boardsMin'])} />
                <NumberField label="Off dwell" unit="min" defaultHint={DEF.miner.dwell.offMin} {...bind(['miners', i, 'dwell', 'offMin'])} />
                <NumberField label="Deadband" unit="W" defaultHint={DEF.miner.dwell.deadbandW} {...bind(['miners', i, 'dwell', 'deadbandW'])} />
                <NumberField label="Derate chip temp" unit="°C" defaultHint={DEF.miner.safety.derateChipTemp} {...bind(['miners', i, 'safety', 'derateChipTemp'])} />
                <NumberField label="Pause chip temp" unit="°C" defaultHint={DEF.miner.safety.pauseChipTemp} {...bind(['miners', i, 'safety', 'pauseChipTemp'])} />
                <NumberField label="Max board temp" unit="°C" defaultHint={DEF.miner.safety.maxBoardTemp} {...bind(['miners', i, 'safety', 'maxBoardTemp'])} />
                <NumberField label="Max fan speed" unit="rpm" defaultHint={DEF.miner.safety.maxFanRpm} {...bind(['miners', i, 'safety', 'maxFanRpm'])} />
                <NumberField label="Safety step" unit="W" defaultHint={DEF.miner.safety.safetyStepW} {...bind(['miners', i, 'safety', 'safetyStepW'])} />
                <Select label="Cooling mode" defaultHint={DEF.miner.cooling.mode} options={[
                  { value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Manual' }, { value: 'immersion', label: 'Immersion' },
                ]} {...bind(['miners', i, 'cooling', 'mode'])} />
                <NumberField label="Cooling target" unit="°C" defaultHint={DEF.miner.cooling.targetC} {...bind(['miners', i, 'cooling', 'targetC'])} />
                <Select label="DPS policy" defaultHint={DEF.miner.dpsManage} options={[
                  { value: 'leave', label: 'Leave as-is' }, { value: 'enable', label: 'Keep enabled' }, { value: 'disable', label: 'Keep disabled' },
                ]} {...bind(['miners', i, 'dpsManage'])} />
              </div>
              <div className="btn-row mb">
                <Toggle checked={!!getIn(draft, ['miners', i, 'cooling', 'manage'])}
                  onChange={(v) => { setDraft(setIn(draft, ['miners', i, 'cooling', 'manage'], v)); setDirty(true); }}
                  label="Let the controller manage cooling config" />
                <Badge>default: off</Badge>
              </div>
            </div>
          ))}
        </Section>
      </div>
    );
  }

  window.Settings = Settings;
})();
