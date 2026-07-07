#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  iRaceHUD — Local Telemetry Agent (agent.js)
 * ───────────────────────────────────────────────────────────────────────────
 *  Hooks into the iRacing shared-memory telemetry stream via `irsdk-node`,
 *  runs the delta / consistency engine at 60 Hz, and pipes a compact JSON
 *  payload to the HUD overlay over a local WebSocket (ws://localhost:8080).
 *
 *  Run:
 *    node agent.js           → live mode (requires Windows + iRacing running)
 *    node agent.js --demo    → simulated car, works anywhere (test the HUD tonight)
 *
 *  Install:
 *    npm install irsdk-node ws
 * ═══════════════════════════════════════════════════════════════════════════
 */
'use strict';

const { WebSocketServer } = require('ws');

/* ─────────────────────────────── CONFIG ─────────────────────────────────── */

const CONFIG = {
  wsPort: 8080,             // Overlay connects to ws://localhost:8080
  tickHz: 60,               // Telemetry sample + broadcast rate
  sessionRefreshMs: 5000,   // How often we re-parse DriverInfo YAML (expensive)
  rollingWindow: 5,         // Laps used for the consistency (σ) calculation
  trackLengthMeters: 3860,  // Used only by demo mode to synthesize speed
};

/* ──────────────── MOCK "WORLD RECORD" REFERENCE PROFILE ─────────────────
 * 21 milestone coordinates along LapDistPct (0.0 → 1.0). Each row carries the
 * WR cumulative split time plus the reference throttle/brake trace at that
 * point on track. The live delta engine linearly interpolates between rows.
 * Swap this array for a real ghost lap once the cloud API is online.        */

const WORLD_RECORD_PROFILE = [
  { pct: 0.00, t:  0.000, thr: 1.00, brk: 0.00 }, // S/F straight — flat out
  { pct: 0.05, t:  3.100, thr: 1.00, brk: 0.00 },
  { pct: 0.10, t:  6.350, thr: 0.20, brk: 0.85 }, // T1 heavy brake
  { pct: 0.15, t: 10.900, thr: 0.60, brk: 0.00 },
  { pct: 0.20, t: 15.200, thr: 1.00, brk: 0.00 },
  { pct: 0.25, t: 18.700, thr: 1.00, brk: 0.00 }, // back straight
  { pct: 0.30, t: 21.900, thr: 0.10, brk: 0.90 }, // chicane entry
  { pct: 0.35, t: 26.900, thr: 0.45, brk: 0.15 },
  { pct: 0.40, t: 31.600, thr: 0.90, brk: 0.00 },
  { pct: 0.45, t: 35.300, thr: 1.00, brk: 0.00 },
  { pct: 0.50, t: 38.600, thr: 0.30, brk: 0.70 }, // T5 medium stop
  { pct: 0.55, t: 43.300, thr: 0.70, brk: 0.00 },
  { pct: 0.60, t: 47.300, thr: 1.00, brk: 0.00 }, // flat kink
  { pct: 0.65, t: 50.800, thr: 1.00, brk: 0.00 },
  { pct: 0.70, t: 54.300, thr: 0.15, brk: 0.95 }, // hairpin
  { pct: 0.75, t: 60.100, thr: 0.50, brk: 0.00 },
  { pct: 0.80, t: 64.600, thr: 0.95, brk: 0.00 },
  { pct: 0.85, t: 68.300, thr: 1.00, brk: 0.00 },
  { pct: 0.90, t: 71.900, thr: 0.40, brk: 0.55 }, // final complex
  { pct: 0.95, t: 76.600, thr: 0.85, brk: 0.00 },
  { pct: 1.00, t: 80.400, thr: 1.00, brk: 0.00 }, // WR lap: 1:20.400
];
const WORLD_RECORD_LAP = WORLD_RECORD_PROFILE[WORLD_RECORD_PROFILE.length - 1].t;

/* ─────────────────────────── PURE ENGINE MATH ───────────────────────────── */

/** WR cumulative time at an arbitrary LapDistPct (linear interpolation). */
function refTimeAtPct(pct) {
  const P = WORLD_RECORD_PROFILE;
  const x = Math.min(Math.max(pct, 0), 1);
  for (let i = 1; i < P.length; i++) {
    if (x <= P[i].pct) {
      const a = P[i - 1], b = P[i];
      const f = (x - a.pct) / (b.pct - a.pct);
      return a.t + f * (b.t - a.t);
    }
  }
  return WORLD_RECORD_LAP;
}

/** Reference throttle/brake trace at pct — handy for demo mode + future UI. */
function refInputsAtPct(pct) {
  const P = WORLD_RECORD_PROFILE;
  const x = Math.min(Math.max(pct, 0), 1);
  for (let i = 1; i < P.length; i++) {
    if (x <= P[i].pct) {
      const a = P[i - 1], b = P[i];
      const f = (x - a.pct) / (b.pct - a.pct);
      return { thr: a.thr + f * (b.thr - a.thr), brk: a.brk + f * (b.brk - a.brk) };
    }
  }
  return { thr: 1, brk: 0 };
}

/** Population standard deviation, in seconds. */
function stdDev(arr) {
  if (!arr || arr.length < 2) return null;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/** Pro-scouting grade from lap-time σ over the rolling window. */
function gradeFromSigma(sigma) {
  if (sigma == null) return { tier: '—', label: 'Warming up' };
  if (sigma < 0.12)  return { tier: 'S', label: 'Alien Pace' };
  if (sigma < 0.25)  return { tier: 'A', label: 'Factory Pro' };
  if (sigma < 0.45)  return { tier: 'B', label: 'Academy' };
  if (sigma < 0.80)  return { tier: 'C', label: 'Club Racer' };
  return { tier: 'D', label: 'Send-It Merchant' };
}

/* ────────────────────────── TELEMETRY ENGINE ─────────────────────────────
 * Consumes raw frames from either source (live SDK or demo simulator) and
 * derives: elapsed lap time, live WR delta, rolling consistency, lap events.
 * Both sources emit the same frame shape, so this logic is source-agnostic. */

class TelemetryEngine {
  constructor({ onLap }) {
    this.onLap = onLap;
    this.lapStartSessionTime = null; // set at each S/F crossing
    this.deltaValid = false;         // no delta until we've seen a crossing
    this.prevPct = null;
    this.prevLastLapTime = null;
    this.rollingLaps = [];           // last N valid lap times
    this.sessionBest = null;
    this.lapCount = 0;
  }

  /** @param frame {sessionTime,lapDistPct,throttle,brake,speedMs,lastLapTime,lap} */
  update(frame) {
    const { sessionTime, lapDistPct } = frame;

    // ── Start/finish crossing → (re)arm the delta comparison loop
    if (this.prevPct != null) {
      const jump = lapDistPct - this.prevPct;
      if (jump < -0.5) {
        // Wrapped 0.99 → 0.01: new lap begins
        this.lapStartSessionTime = sessionTime;
        this.deltaValid = true;
      } else if (jump < -0.05) {
        // Teleport backwards (car reset / tow) → distrust timing until next S/F
        this.deltaValid = false;
      }
    }
    this.prevPct = lapDistPct;

    // ── Elapsed time on the current lap
    //    Prefer the sim's authoritative LapCurrentLapTime (valid ≥ 0, so the
    //    delta is live even on lap 1); fall back to S/F-crossing derivation.
    const timingTrusted = frame.currentLapTime != null && frame.currentLapTime >= 0;
    let elapsed = null;
    if (timingTrusted) {
      elapsed = frame.currentLapTime;
    } else if (this.deltaValid && this.lapStartSessionTime != null) {
      elapsed = sessionTime - this.lapStartSessionTime;
    }

    // ── Live delta vs the WR profile at this exact distance
    //    Convention: delta = you − record → NEGATIVE = faster = green.
    let liveDelta = null;
    if (elapsed != null && (timingTrusted || this.deltaValid)) {
      liveDelta = elapsed - refTimeAtPct(lapDistPct);
    }

    // ── Completed-lap detection: official time lands in LapLastLapTime
    if (
      frame.lastLapTime != null && frame.lastLapTime > 0 &&
      frame.lastLapTime !== this.prevLastLapTime
    ) {
      this.prevLastLapTime = frame.lastLapTime;
      this._registerLap(frame.lastLapTime);
    }

    const sigma = stdDev(this.rollingLaps);
    const grade = gradeFromSigma(sigma);

    return {
      currentLapTime: elapsed,
      lapDistPct,
      liveDelta,
      throttleInput: frame.throttle,
      brakeInput: frame.brake,
      currentSpeed: frame.speedMs != null ? frame.speedMs * 3.6 : null, // km/h
      driverClub: frame.driverClub,
      driverCountry: frame.driverCountry,
      consistencyVariance: sigma,       // σ of last N laps, seconds
      consistencyGrade: grade,
      lastLapTime: this.prevLastLapTime,
      sessionBestTime: this.sessionBest,
      lap: frame.lap ?? this.lapCount,
    };
  }

  _registerLap(lapTime) {
    this.lapCount += 1;
    this.rollingLaps.push(lapTime);
    if (this.rollingLaps.length > CONFIG.rollingWindow) this.rollingLaps.shift();

    const isSessionBest = this.sessionBest == null || lapTime < this.sessionBest;
    if (isSessionBest) this.sessionBest = lapTime;

    const sigma = stdDev(this.rollingLaps);
    const grade = gradeFromSigma(sigma);

    console.log(
      `🏁 LAP ${this.lapCount}  ${fmt(lapTime)}` +
      (isSessionBest ? '  ★ SESSION BEST' : `  (best ${fmt(this.sessionBest)})`) +
      (sigma != null ? `  σ ${sigma.toFixed(3)}s → ${grade.tier}` : '')
    );

    this.onLap({
      type: 'lap',
      lap: this.lapCount,
      lapTime,
      isSessionBest,
      sessionBestTime: this.sessionBest,
      consistencyVariance: sigma,
      consistencyGrade: grade,
    });
  }
}

/* ─────────────────────── SOURCE 1 · LIVE iRACING ────────────────────────── */

/** Defensive reader — tolerates both `{value:[x]}` objects and raw numbers. */
function readVar(t, name) {
  const v = t?.[name];
  if (v == null) return null;
  if (typeof v === 'object') {
    if (Array.isArray(v.value)) return v.value[0];
    if (Array.isArray(v)) return v[0];
  }
  return typeof v === 'number' ? v : null;
}

class IRacingSource {
  constructor(sdk) {
    this.sdk = sdk;
    this.driverClub = 'Unknown Club';
    this.driverCountry = '??';
    this._timers = [];
  }

  /** Attempts to load irsdk-node and attach to a running sim. */
  static async detect() {
    let mod;
    try {
      mod = require('irsdk-node');
    } catch {
      return { ok: false, reason: '`irsdk-node` not installed (Windows-only native module)' };
    }
    const { IRacingSDK } = mod;
    try {
      if (typeof IRacingSDK.IsSimRunning === 'function' && !(await IRacingSDK.IsSimRunning())) {
        return { ok: false, reason: 'iRacing is not running' };
      }
      const sdk = new IRacingSDK();
      sdk.autoEnableTelemetry = true;
      if (typeof sdk.startSDK === 'function' && !sdk.startSDK()) {
        return { ok: false, reason: 'could not attach to the iRacing shared memory map' };
      }
      return { ok: true, source: new IRacingSource(sdk) };
    } catch (err) {
      return { ok: false, reason: `SDK init failed: ${err.message}` };
    }
  }

  start(onFrame) {
    this._refreshDriverInfo();
    this._timers.push(setInterval(() => this._refreshDriverInfo(), CONFIG.sessionRefreshMs));

    const tickMs = 1000 / CONFIG.tickHz;
    this._timers.push(setInterval(() => {
      // waitForData briefly blocks for a fresh 60 Hz frame; on a dedicated
      // local agent process this is an acceptable trade for zero-lag samples.
      if (!this.sdk.waitForData(Math.floor(tickMs / 2))) return;
      const t = this.sdk.getTelemetry();
      if (!t) return;
      onFrame({
        sessionTime:    readVar(t, 'SessionTime'),
        lapDistPct:     readVar(t, 'LapDistPct'),
        throttle:       readVar(t, 'Throttle'),
        brake:          readVar(t, 'Brake'),
        speedMs:        readVar(t, 'Speed'),
        lastLapTime:    readVar(t, 'LapLastLapTime'),
        currentLapTime: readVar(t, 'LapCurrentLapTime'),
        lap:            readVar(t, 'Lap'),
        driverClub:     this.driverClub,
        driverCountry:  this.driverCountry,
      });
    }, tickMs));
  }

  _refreshDriverInfo() {
    try {
      const session = this.sdk.getSessionData();
      const di = session?.DriverInfo;
      if (!di) return;
      const me =
        (di.Drivers || []).find((d) => d.CarIdx === di.DriverCarIdx) || (di.Drivers || [])[0];
      if (!me) return;
      // 2024+ builds moved country flags to "Flair" fields; fall back gracefully.
      this.driverClub = me.ClubName || me.FlairName || this.driverClub;
      this.driverCountry =
        me.CountryCode || me.FlairShortName || me.FlairCountryCode || this.driverCountry;
    } catch {
      /* session YAML occasionally mid-write — retry on the next refresh */
    }
  }

  stop() { this._timers.forEach(clearInterval); }
}

/* ─────────────────── SOURCE 2 · DEMO SIMULATOR ───────────────────────────
 * Synthesizes a believable car lapping the WR profile: sector-level pace
 * wobble makes the delta breathe green/red, laps land ~0.3–1.2s off the
 * record, and roughly every 3rd–4th lap improves to fire the PB ripple.    */

class SimulatedSource {
  constructor() {
    this.pct = 0;
    this.elapsed = 0;
    this.sessionTime = 0;
    this.lastLapTime = 0;
    this.lap = 1;
    this.pace = 1.012;                       // 1.2% off the record to start
    this.phase = Math.random() * Math.PI * 2;
    this._timer = null;
  }

  start(onFrame) {
    const dt = 1 / CONFIG.tickHz;
    this._timer = setInterval(() => {
      // pct/sec from the WR profile slope, scaled by lap pace + sector wobble
      const seg = this._segmentAt(this.pct);
      const slope = (seg.b.t - seg.a.t) / (seg.b.pct - seg.a.pct); // sec per pct
      const wobble = 1 + 0.035 * Math.sin(2 * Math.PI * (3 * this.pct) + this.phase);
      const rate = 1 / (slope * this.pace * wobble);

      this.pct += rate * dt;
      this.elapsed += dt;
      this.sessionTime += dt;

      if (this.pct >= 1) {
        this.lastLapTime = this.elapsed;
        this.pct -= 1;
        this.elapsed = 0;
        this.lap += 1;
        this.phase = Math.random() * Math.PI * 2;
        // Random-walk the pace; occasionally throw a genuine hot lap.
        const hot = Math.random() < 0.3;
        this.pace = Math.max(
          1.001,
          (hot ? this.pace - 0.004 : 1.010 + (Math.random() - 0.5) * 0.008)
        );
      }

      const ref = refInputsAtPct(this.pct);
      const jitter = () => (Math.random() - 0.5) * 0.06;
      const throttle = clamp01(ref.thr + jitter());
      const brake = clamp01(ref.brk + (ref.brk > 0.05 ? jitter() : 0));
      const speedMs = rate * CONFIG.trackLengthMeters;

      onFrame({
        sessionTime: this.sessionTime,
        lapDistPct: this.pct,
        throttle,
        brake,
        speedMs,
        lastLapTime: this.lastLapTime > 0 ? this.lastLapTime : null,
        currentLapTime: this.elapsed,
        lap: this.lap,
        driverClub: 'Midwest',
        driverCountry: 'US',
      });
    }, 1000 / CONFIG.tickHz);
  }

  _segmentAt(pct) {
    const P = WORLD_RECORD_PROFILE;
    for (let i = 1; i < P.length; i++) {
      if (pct <= P[i].pct) return { a: P[i - 1], b: P[i] };
    }
    return { a: P[P.length - 2], b: P[P.length - 1] };
  }

  stop() { clearInterval(this._timer); }
}

/* ─────────────────────────── CLOUD HOOK (FUTURE) ─────────────────────────
 * Extension point for the scouting pipeline: POST every completed lap
 * (time, σ, delta trace) to the central iRaceHUD API for global/regional/
 * club leaderboard ingestion. Intentionally a no-op in the local build.    */
async function uploadLapToCloud(lapRecord) {
  // TODO: await fetch('https://api.iracehud.example/v1/laps', {method:'POST', body: JSON.stringify(lapRecord)})
  void lapRecord;
}

/* ────────────────────────────── UTILITIES ───────────────────────────────── */

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function fmt(sec) {
  if (sec == null) return '--:--.---';
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, '0');
  return m > 0 ? `${m}:${s}` : `${s}s`;
}

/* Windows: find a stale iRaceHUD process (node/electron only — never anything
   else) still listening on the port, and kill it so the newest launcher wins.
   Returns true if a stale instance was terminated. */
function killStaleAgentOnPort(port) {
  if (process.platform !== 'win32') return false;
  const { execSync } = require('child_process');
  const run = (cmd) => {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); }
    catch { return ''; }
  };
  let killed = false;
  for (const line of run('netstat -ano').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    if (!cols[1].endsWith(':' + port)) continue;
    const pid = cols[4];
    if (!pid || pid === String(process.pid)) continue;
    const image = run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toLowerCase();
    if (image.includes('node.exe') || image.includes('electron.exe')) {
      run(`taskkill /PID ${pid} /F`);
      killed = true;
    }
  }
  return killed;
}

/* ─────────────────────────────── BOOTSTRAP ──────────────────────────────── */

async function main() {
  const forceDemo = process.argv.includes('--demo');

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  iRaceHUD Agent · WR target ' + fmt(WORLD_RECORD_LAP).padEnd(15) + ' │');
  console.log('└──────────────────────────────────────────────┘');

  // ── Pick a telemetry source
  let source; let mode;
  if (forceDemo) {
    source = new SimulatedSource(); mode = 'demo';
    console.log('▶ Mode: DEMO (simulated car — no iRacing required)');
  } else {
    const live = await IRacingSource.detect();
    if (live.ok) {
      source = live.source; mode = 'live';
      console.log('▶ Mode: LIVE (attached to iRacing shared memory)');
    } else {
      source = new SimulatedSource(); mode = 'demo';
      console.log(`▶ Live SDK unavailable → ${live.reason}`);
      console.log('▶ Falling back to DEMO mode. (Run on Windows with iRacing open for live data.)');
    }
  }

  // ── WebSocket server — newest agent wins: if a stale iRaceHUD instance is
  //    still holding the port (e.g. yesterday's demo window), evict it.
  let wss;
  const broadcast = (obj) => {
    const json = JSON.stringify(obj);
    for (const client of wss.clients) if (client.readyState === 1) client.send(json);
  };

  let tookOver = false;
  const bind = () => {
    wss = new WebSocketServer({ port: CONFIG.wsPort });

    wss.on('connection', (ws) => {
      console.log(`● Overlay connected (${wss.clients.size} client${wss.clients.size === 1 ? '' : 's'})`);
      ws.send(JSON.stringify({
        type: 'config',
        source: mode,
        hz: CONFIG.tickHz,
        targetLapTime: WORLD_RECORD_LAP,
        profile: WORLD_RECORD_PROFILE,
      }));
      ws.on('close', () => console.log('○ Overlay disconnected'));
    });
    wss.on('listening', () =>
      console.log(`▶ WebSocket live on ws://localhost:${CONFIG.wsPort} — open overlay.html`)
    );
    wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && !tookOver && killStaleAgentOnPort(CONFIG.wsPort)) {
        tookOver = true;
        console.log(`▶ Port ${CONFIG.wsPort} was held by a stale iRaceHUD agent — taking over…`);
        setTimeout(bind, 700);
        return;
      }
      if (err.code === 'EADDRINUSE') {
        console.error(`✖ Port ${CONFIG.wsPort} is already in use and could not be freed.`);
        console.error('  Close any other iRaceHUD windows and try again.');
        process.exit(1);
      }
      throw err;
    });
  };
  bind();

  // ── Engine wiring: frames in → payload out at 60 Hz
  const engine = new TelemetryEngine({
    onLap: (lapEvent) => {
      broadcast(lapEvent);
      uploadLapToCloud(lapEvent); // future scouting pipeline hook (no-op today)
    },
  });

  source.start((frame) => {
    const payload = engine.update(frame);
    broadcast({ type: 'telemetry', source: mode, ...payload });
  });

  // ── Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n▼ Shutting down iRaceHUD agent…');
    source.stop?.();
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

// Pure pieces exported for unit tests + the future centralized API server.
module.exports = {
  CONFIG,
  WORLD_RECORD_PROFILE,
  WORLD_RECORD_LAP,
  refTimeAtPct,
  refInputsAtPct,
  stdDev,
  gradeFromSigma,
  TelemetryEngine,
  SimulatedSource,
};
