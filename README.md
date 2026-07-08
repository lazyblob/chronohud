# iRaceHUD 🏁

Trackmania-inspired telemetry HUD overlay for **iRacing** — a live world-record delta bar, pro-scouting consistency grades, and an input-painted track map, streamed from the sim's shared memory to a transparent browser overlay at 60 Hz.

> **The long game:** a decentralized talent-scouting pipeline that surfaces "closet alien" pace from private practice sessions, backed by global / regional / club leaderboards.

<!-- demo GIF goes here — run `npm run demo`, press B for the backdrop, and screen-record -->

## Features

- **Live ghost delta bar** — compares your elapsed lap time against a reference ghost at your exact `LapDistPct`, interpolated between 21 milestone splits. In live mode the ghost is **your own personal best for that exact track + car**, captured automatically and saved between sessions — your first clean lap sets the target, every lap after races it. Snaps **neon green** when you're gaining, **crimson** when you're losing. (Demo mode races a built-in 1:20.4 reference.)
- **Rotational rank tower** — auto-cycles Global → Regional → Club standings every 5 s, with a mini-leaderboard centered on you, by name (competitor rows are labeled sample data until the cloud API lands).
- **Real track map, learned from GPS** — while you drive, the agent samples your Lat/Lon along the lap and builds the actual circuit outline; it's saved per track, so the map shows the real layout from then on. A glowing dot laps it, trailing a path colored by pedal dominance: green under throttle, crimson under braking, slate when coasting. (Demo mode shows a stylized loop.)
- **Per-widget layout** — every HUD card is an independent widget: enter edit mode (**Ctrl+Shift+M** in game, **E** in a browser) to drag, resize, hide, or restore each one; your layout is remembered.
- **Inputs widget** — live throttle/brake bars plus gear + RPM readout.
- **Pro Scout grade** — rolling σ of your last 5 valid laps, graded S *"Alien Pace"* (< 0.12 s) down to D.
- **PB ripple** — a full-viewport green pulse whenever you beat your session best.
- **Demo mode** — the entire HUD runs without iRacing (`npm run demo`), driven by a synthetic car with sector-level pace wobble.

## Quick start

```bash
npm install          # ws is required; irsdk-node is optional (Windows-only native module)
npm run demo         # simulated car — works on any OS, no sim needed
```

Then open `overlay.html` in a browser. The background is genuinely transparent — press **B** to toggle a dark test backdrop. The status pill flips to **DEMO** within a second; the first lap completes after ~80 s.

### Live mode (race PC)

```bash
node agent.js        # auto-detects a running iRacing instance
```

Requires Windows with iRacing open. The pill flips to **LIVE**; everything else is identical.

### In-game overlay (floats over the sim)

```bash
npm run game         # LIVE — transparent, always-on-top, click-through window + agent
npm run game:demo    # same window, synthetic car
```

One command boots the whole stack: a full-screen transparent Electron window floats the HUD widgets over iRacing while clicks pass straight through to the sim. Run iRacing in **borderless windowed** mode (exclusive fullscreen paints over every OS window). Hotkeys: **Ctrl+Shift+Q** quits, **Ctrl+Shift+M** toggles edit mode (drag widgets, resize via the yellow corner, ✕ hides, DONE locks), **Ctrl+Shift+ +/−** zooms the whole HUD. On Windows, the `Start iRaceHUD - *.bat` launchers wrap these commands for double-click startup.

### OBS / streaming

Add `overlay.html` as a **Browser Source** → check *Local file* → size ≈ 420 × 920. Transparency carries over automatically. To float it over the sim itself, run iRacing in borderless windowed mode.

## Architecture

```
┌─────────────────────┐    60 Hz frames    ┌──────────────────┐    ws://localhost:8080    ┌───────────────┐
│ iRacing shared mem  │ ─────────────────▶ │ agent.js         │ ────────────────────────▶ │ overlay.html  │
│ (irsdk-node)        │                    │ TelemetryEngine: │      JSON payloads        │ transparent   │
│  · or SimSource ─── │ ─────────────────▶ │ delta · σ · laps │                           │ HUD viewport  │
└─────────────────────┘                    └──────────────────┘                           └───────────────┘
```

Both telemetry sources (live SDK and demo simulator) emit identical frame shapes into one source-agnostic `TelemetryEngine`. The pure math (`refTimeAtPct`, `stdDev`, `gradeFromSigma`) is exported from `agent.js` for unit tests and the future centralized API server.

### Payload contract

Broadcast every tick as `{ type: "telemetry", ... }`:

```json
{
  "currentLapTime": 38.412,
  "lapDistPct": 0.4938,
  "liveDelta": -0.145,
  "throttleInput": 0.82,
  "brakeInput": 0.0,
  "currentSpeed": 224.6,
  "driverClub": "Midwest",
  "driverCountry": "US",
  "consistencyVariance": 0.2,
  "consistencyGrade": { "tier": "A", "label": "Factory Pro" },
  "lastLapTime": 80.6,
  "sessionBestTime": 80.6,
  "lap": 3
}
```

Delta convention: `liveDelta = yourElapsed − recordProfileTime` → **negative = faster = green**. On lap completion a one-shot `{ type: "lap", isSessionBest, ... }` event fires the PB ripple.

## Roadmap

- [x] Per-track ghost profiles — your personal best per track + car, persisted (real WR ghosts arrive with the cloud API)
- [x] Real track shapes learned from iRacing GPS telemetry
- [ ] Cloud lap ingestion — wire `uploadLapToCloud()` (already called on every completed lap) to the central API
- [ ] Real global / regional / club leaderboards replacing the sample tiers
- [ ] More widgets: fuel calculator, relative/standings, lap-time history graph
- [ ] Scouting dashboard: flag high-consistency, high-pace drivers across private sessions

## Notes

- `irsdk-node`'s API surface has shifted between majors, so telemetry is read through a defensive `readVar()` that tolerates both `{value:[x]}` wrappers and raw numbers.
- Driver strings fall back gracefully from `ClubName`/`CountryCode` to the newer `FlairName`/`FlairShortName` session fields.
- The newest launcher wins: a stale iRaceHUD agent still holding port 8080 (yesterday's forgotten demo window) is evicted automatically on startup. Only node/electron processes are ever touched.
- Port 8080 taken by something else? Set the `IRACEHUD_PORT` env var (agent) and open `overlay.html?ws=ws://localhost:<port>`.
- PB ghosts and learned track shapes live in `%APPDATA%\iRaceHUD\` (`pb-profiles.json`, `track-shapes.json`) — delete a file to reset.
- Speed shows **mph** automatically for US/UK drivers, km/h otherwise; press **U** in a browser to flip it.

## License

MIT — see [LICENSE](LICENSE).
