# Solar Panel Gun — Design Notes

Working notes on how the current systems fit together, for picking this project
back up in a fresh chat. The code (`main.js` + `index.html`) is the source of
truth — this is a map of *why* things work the way they do, not a spec.

## Deployment

This repo is a plain static site (`index.html` + `main.js`, Three.js loaded
from a CDN via import map) hosted on **GitHub Pages** at:

```
https://industriesichanic-ctrl.github.io/Solar-Installer/
```

It auto-redeploys within a minute or two of any push to `main`. To push
changes, from a terminal opened in this folder (`solar_gun_prototype`):

```bash
git add index.html main.js
git commit -m "describe the change here"
git push
```

(Add other files, e.g. `NOTES.md`, to the `git add` line if they changed too.)
No build step, no `npm install` — it's served exactly as committed. The repo
already has its remote configured (`origin` → the GitHub repo above), so
`git push` alone is enough once there's a commit to send. If `git push` ever
fails with "repository not found" or similar, check `git remote -v` — the
remote URL must exactly match the repo name/owner on GitHub.

## World

Open-world Three.js FPS. Procedurally placed buildings on a road grid, plus a
market square, a park+lake, a "Solar Farm District" of large mega-roof
buildings, a train station, parked cars, and a fenced Salvage Yard with an NPC
("the cleric"). `worldMeshes` is a snapshot of every solid mesh, used for
general raycasting (cable/water-gun targeting, wall placement); `groundColliders`
is the ground-snap raycast set (walkable surfaces); `wallColliders` is
axis-aligned box data (not meshes) for horizontal player collision.

## Weapons (1–5)

1. **Solar Panel Gun** — places panels on any upward or near-vertical surface
   (roofs + walls). Grid-snaps to adjacent panels of the same size. Unlocks a
   drag-select **Area Tool** (hold RMB, look to far corner, release to fill a
   rectangle) at 100 panels placed. Unlocks a **large panel** variant (2×
   size, 350W vs 250W) at 1500 connected panels — toggle with `X`.
2. **Cable Gun** — connects panels and/or inverters. Routing auto-inserts
   right-angle elbows when consecutive waypoints sit on differently-oriented
   surfaces (`buildRoutedLegs`/`surfaceAxis`), so cable hugs roofs then walls
   like real conduit instead of cutting through empty space. Inverter-to-inverter
   links render as a single heavy orange "16mm flex" cylinder instead of the
   usual dual red/black strands (`heavy` flag in `buildCableSegment`).
3. **Cable Router** — grab-and-bend an existing run (hold LMB on it, look to a
   new point, release), or straighten a bend (RMB). Once the Salvage Yard is
   unlocked, RMB with nothing under the crosshair instead salvages the nearest
   panel (`salvagePanelUnderCrosshair`).
4. **Inverter Gun** — places wall-mounted inverters, wider grid spacing than
   panels. Tier 0 (3kW) units auto-combine by proximity, 3→1, into Tier 1
   (10kW); **Tier 1+ units do NOT auto-merge** — instead RMB *selects* a big
   unit (gold outline), and 3 same-tier selections combine (10→20→50kW),
   regardless of physical adjacency. `E` toggles a wired inverter's switch.
5. **Water Gun** — unlocked by donating 1000 cable-scrap + 500 panel-scrap to
   the salvage cleric (walk close; auto-donates on proximity, tracked on
   floating signs above its head). Hold LMB to spray. See Fire section below
   for what spraying actually does.

## Wattage & connectivity

- Every panel has `.watts` (250 or 350) and `.groupId` (which physically-
  touching cluster it's in — `groups` Map, built via `panelsAdjacent`).
  **Touching panels sum wattage as one block with no cable needed between
  them** — a single cable from anywhere in a 100-panel block carries the
  whole block's total downstream (`collectInverterNetwork`'s `admitPanel`
  expands to the whole `groups` entry, not just the one panel it found).
- `collectInverterNetwork(inv)` BFS's out from an inverter across cables,
  absorbing touching-panel blocks and **other inverters** (inverter-to-inverter
  cable links pool capacity — a chained pair of 20kW inverters can jointly
  carry 40kW). Returns `{panels, inverters, watts, capacityWatts}` for the
  whole connected network, not just one unit.
- Inverter capacity by tier: `INVERTER_CAPACITY_KW = [3, 10, 20, 50]`.
- Each inverter's sign shows live `connected/capacity` kW, color-banded by
  load %: green ≤50, yellow 51–85, red 86–97, flashing red 98–100
  (`refreshInverterSign`/`updateInverterSignFlash`). Overload triggers >100%.
- **Overload re-checks on every wiring change**, not just at power-on
  (`checkLiveOverloads`, called after `finishCable`/`destroyCable`/merges) —
  wiring more array into an already-running inverter can trip it live.
- Powered inverters tick `kwhProduced` +1 every 5s while healthy
  (`updateInverterProduction`); a global `totalKwhProduced` sums this,
  shown top-right.

## Fire, overload, and the water gun

**Overload no longer destroys instantly.** `triggerInverterOverload` sets the
whole connected network's inverters/panels/cables to `burning = true` and
keeps them `poweredOn = true` (still live/electrified) — the player has to
manually turn each inverter off (`E`) before it's safe to approach.

- **Extinguish**: spray a burning-but-switched-off inverter → it's finally,
  safely torn down (`extinguishInverter`: cables drop scrap, inverter
  removed). Spray a burning-but-safe panel → its fire goes out, it stays in
  place, permanently charred (`p.burnt` visual from `burnPanel`).
- **Still live**: spraying anything with `poweredOn === true` (or a panel
  whose network has any powered inverter — `isPanelElectrified`) destroys it
  outright *and* electrocutes the player (teleport to spawn,
  `electrocutePlayer`). Non-burning ("operational") cables are always safe to
  spray; a *burning* cable that's still electrified kills you too.
- **Spread**: every burning inverter/panel has a 15s repeating timer
  (`updateFireSpread`/`spreadTick`). Each tick: (a) instantly ignites anything
  directly cable-linked to it (regardless of power state — fire doesn't care
  if the circuit's on), and (b) lights 2 more of the building's pre-mapped
  fire blocks (`advanceBuildingFire`). `computeBuildingBlocks` lays out ~37
  real points (panel-sized spacing, shuffled order) across all 4 walls and
  the roof the first time a building starts burning — these are actual
  positions a fire effect spawns at, not decorative random spots, so the
  building visibly catches fire in a spreading pattern rather than one stray
  flame. `findBuildingContaining` maps a world (x,z) to whichever
  `buildingBoxes`/`megaBuildingBoxes` entry contains it (footprint/AABB
  check — buildings still aren't real destructible sub-meshes, "blocks" are
  just pre-computed points + a progress counter).
- **Collapse**: once every block is lit, the building disappears in
  `DEMOLISH_STEPS` (6) discrete steps, one every `SPREAD_INTERVAL` (15s) —
  not a continuous tween, so it visibly chunks down in sync with the same
  cadence fire spreads on. `finishDemolition` then removes the body mesh +
  wall collider and spawns a walkable rubble pile (10 `DodecahedronGeometry`
  chunks pushed into `groundColliders`). A fully cabled district really can
  burn building-to-building and end up as rubble.
- `finishDemolition` also calls `collapseInstalledEquipment(b)`, which tears
  down any panels/inverters/cables whose position falls within the building's
  footprint (with a small margin) and drops a scrap pile on the ground at
  each one's own `x,z` — so array mounted on a burned-down building ends up
  as debris at its install spot instead of floating in mid-air once the
  building mesh is gone.
- Flame/smoke meshes on a near fire (`buildFireDetail`) no longer
  re-randomize scale/opacity/position every frame — that was both the
  visible "flashing" and most of the per-fire per-frame cost. Each fire now
  holds a fixed pose and only rolls a new one on a random 1–2s timer
  (`f.flickerT`/`f.flickerInterval` in `updateFires`), like two alternating
  flame frames and two alternating smoke frames.

### Performance (fire LOD)

Fires beyond `FIRE_LOD_RADIUS` (16m) show a cheap static billboard sprite
(one shared canvas texture/material, `matFireBillboard`) and skip **all**
per-frame animation. The detailed group (5 flame cones + 4 smoke spheres + a
`PointLight` — the expensive part) is now built **lazily**, only the first
time a fire is actually near the player (`buildFireDetail`), not at ignition
— so a whole array catching fire far from the player costs almost nothing
until they go look at it. If a big fire still causes slowdown, the likely
next lever is capping simultaneous *near* fires or reducing per-fire mesh
count further, not the LOD radius itself.

## Progression

`upgrades` object gates most unlocks (`largePanelUnlocked`, `salvageUnlocked`,
`buildingJumpUnlocked`, `waterGunUnlocked`, `goldStars`, plus movement/ammo
multipliers). Driven by `totalConnected` (panels that have ever been a cable
endpoint — cumulative, never decreases) crossing `MILESTONES` thresholds
(100/200/500/1000/1200/1500/2000/3000/5000/10000). Each milestone pops a big
`showMilestoneBanner` (gold) or `showDangerBanner` (red, reused for overloads
and electrocution). 10000 unlocks a building-to-building boost-jump via the
Cable Gun (click your roof, click target roof).

## Known simplifications / open threads

- Building "fire blocks" are an abstract counter + random decorative fire
  placement, not real chunked/destructible geometry. A literal block-by-block
  demolition (real sub-meshes falling away) would be a much bigger rebuild.
- No repair/rebuild mechanic for burnt panels or demolished buildings.
- Credits (`credits`) are tracked but not yet spent on anything.
- The `matFireBillboard` texture is fairly small/simple; could be prettied up
  later without touching the LOD logic.
- Everything (people, cars, trains) is still static/frozen per the original
  ask — no movement/animation yet if that's ever wanted.

## Testing notes (for whoever picks this up)

`window.__debug` exposes most internals for console-driven testing — see the
big object at the bottom of `main.js`. Two recurring gotchas when testing via
`javascript_exec` against a fresh/backgrounded tab:
- `camera.aspect` can come back `null`/`NaN` if the tab was created in the
  background before it had real dimensions — front the tab and reload if
  raycasts mysteriously return zero hits.
- Objects created directly via debug calls (not through the normal
  build-at-load path) need `scene.updateMatrixWorld(true)` before raycasting
  against them, since they haven't been rendered yet.
