# Solar Panel Gun — Oct District

A browser-based open-world first-person job simulator built with Three.js. Pick a
trade at the Job Hut, get a loadout of tools specific to that job, and go build
things in a low-poly city (or one of three other maps).

**Play it live:** https://industriesichanic-ctrl.github.io/Solar-Installer/

## Running it locally

No build step — it's a single static page.

```bash
npx serve .
```

Then open `http://localhost:3000` (or whatever port `serve` picks). Any static
file server works; the only requirement is serving `index.html` and `main.js`
over HTTP (opening `index.html` directly via `file://` won't load the ES module).

## Controls

| Key | Action |
|---|---|
| `WASD` | Move |
| Mouse | Look |
| `Shift` (hold) | Sprint — drains a stamina meter, see below |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| `Left Click` | Fire the equipped tool |
| `Right Click` | Secondary action (varies by tool) |
| `1`–`8`, `0` | Switch weapon slot |
| `R` | Reload |
| `E` | Interact (toggle switches, pick up rubble, etc.) |
| `M` | Toggle full map (scroll wheel to zoom) |
| `X` | Toggle large panel size / cycle context options (Solar Panel Gun) |
| `Esc` | Release mouse |

**Sprint meter:** drains from 100% to 0% over 3 seconds of continuous
sprinting. Speed multiplier depends on the current band — green (>65%) is
4x walk speed, yellow (35–65%) is 3x, red (≤35%) is 2x. Refill time depends
on where you stopped: exhausted (0%) takes 10s, red 8s, yellow 6s, green 4s.

## Maps

Pick a map from the start screen's map panel:

1. **Oct District** — the main city. Salvage economy, weapon shop, full
   figure-8 Job Hut with all 25 trades listed (2 playable).
2. **Solar Farm — Open Range** — a fixed 1MW tilted array; goal is wiring
   500kW of player-placed inverters to it. Weapon 1 is a Tree Cutter here.
3. **The Swamp** — murky ponds, misshapen trees and shrubs, green fog. Its
   own 5-job Job Hut themed around landscaping/environmental work.
4. **The Badlands** — dusty mesas and rock spires, orange fog. Its own
   5-job Job Hut themed around site prep for future construction.

Each map is its own region of one shared 3D scene, offset far apart —
picking a map teleports your spawn point there rather than loading a
separate instance.

## Playable jobs

Selected at any Job Hut (walk up to a desk, aim and **RMB** to select,
**LMB** to confirm):

- **Solar Installer** — place and wire solar panels to inverters; area-fill
  tool unlocks at 100 panels placed.
- **Plumber** — place heat pumps, run pipes to a water main, wire
  electrical switches through an MSWB with a real activation order (get it
  wrong and the pipes blow out).
- **Demolition Contractor** — scan a building, arm charges, and bring it
  down with a real floor-by-floor collapse.
- **Landscaper** (Swamp) — dig, fill, shape terrain features, and cycle
  through planting trees/bushes/grass.
- **Structural Engineer** (Badlands) — place walls and lit lightposts.
- **Lift Mechanic/Electrician** — install a lift motor and pulleys, string
  steel hoist cable and AC power cable to an MSWB, place a control panel and
  pass its light-sequence test, then install the brakes.

The other 19 trades are visible at their desks (with a planned tool
loadout shown on selection) but aren't playable yet — "no need to code the
other jobs yet" is the standing rule for this project.

**Hot-swap loadout panel:** selecting a job shows a 3D readout of its
tools above the desk. Aim at any tool icon (from any job, including locked
ones) and **RMB** it to reskin the matching slot of your *own* current
job — cosmetic only, the underlying function doesn't change.

## Project files

- `index.html` — page shell, start-screen UI, map/job HUD markup and CSS.
- `main.js` — the entire game: world generation, physics, every weapon
  system, the Job Hut, and the debug hooks exposed at `window.__debug`.
- `NOTES.md` — a running dev log of *why* things work the way they do —
  read this before making further changes, it has a lot of hard-won
  context (known gotchas, deferred work, bug history).

## Known gotchas (see NOTES.md for the full list)

- Bump the cache-buster (`?v=N`) on `main.js`'s `<script>` tag in
  `index.html` on every deploy, or browsers (and GitHub Pages' CDN) can
  serve a stale copy.
- `camera.aspect` can read `null`/NaN in a freshly-created or backgrounded
  browser tab, which silently breaks all raycasting — front the tab and
  reload if placement/interaction stops working during testing.
