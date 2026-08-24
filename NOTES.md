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

## Player / movement

Standard Half-Life/Crysis-style FPS controller: WASD move, Shift sprint,
Ctrl/C crouch (lowers eye height, slower move speed), Space jump, mouse-look
with pointer lock. Gravity + a downward raycast against `groundColliders`
ground-snaps every frame — this is also how the player stands on placed
panels, train-car roofs, rubble piles, etc.; anything pushed into that array
is walkable. World is bounded; falling below y = -20 respawns at the origin.
Sprint speed / jump power / eye height are all multiplied by
`upgrades.sprintMul` / `jumpMul` / `heightMul`, which increase via the
milestone system below.

## World

Open-world Three.js FPS map, built once at load:

- **Building grid**: procedurally placed buildings (some skyscraper-height),
  each with a flat roof, a parapet, and (most of them) an exterior staircase
  up one side so roofs are reachable on foot.
- **Solar Farm District**: a cluster of large mega-roof buildings at varying
  heights, purpose-built for big panel arrays (up to ~1000 panels combined).
- **Market square**: paved plaza with static silhouette NPCs in a few poses,
  lamp posts, benches, a fountain.
- **Park + lake**: scattered trees, benches, a lake, and a kite flyer.
- **Train station**: a static train (multiple walkable-roof cars) on rails,
  with a platform, canopy, and waiting NPCs.
- **Parked cars**: static vehicles scattered along the roads.
- **Salvage Yard**: a fenced yard with the salvage cleric NPC (see
  Progression/Salvage below).

Everything living (people, cars, the train) is currently **static/frozen** —
no movement or animation yet; that was an explicit "later" from the original
ask, not an oversight.

Three shared collision/registry arrays, populated as the world builds and
added to over time as things are placed/removed:
- `worldMeshes` — snapshot of every solid mesh, used for general raycasting
  (cable/water-gun targeting, wall placement). Panels/inverters push their
  body mesh into this when placed.
- `groundColliders` — the ground-snap raycast set (walkable surfaces).
- `wallColliders` — plain axis-aligned box **data** (not meshes) for
  horizontal player collision. `addWallBox` returns the pushed object so
  callers (e.g. a building) can hang onto a reference and remove just their
  own entry later (used when a building demolishes).

## Weapons (1–5)

1. **Solar Panel Gun** — places panels on any upward or near-vertical
   surface (roofs + walls). **Grid-snaps**: aiming near an existing panel
   locks the ghost to one of its four edge-adjacent slots, so building a
   uniform array is easy. Placing 5/10/20/50 *connected* panels in a row
   triggers a brief celebratory glow around the whole run
   (`spawnGroupGlow`) plus a toast — smaller/quicker than the milestone
   banner (see Progression). Unlocks a drag-select **Area Tool** at 100
   panels placed (hold RMB on a start point, look to the far corner,
   release to fill the rectangle — since pointer lock means mouse movement
   is camera-look, "dragging" is done by swinging the view). Unlocks a
   **large panel** variant (2× size, teal tint, 350W vs the standard 250W)
   at 1500 connected panels — toggle with `X`.
2. **Cable Gun** — connects panels and/or inverters. Left-click a panel or
   inverter to start a run, click again to add waypoints or click another
   panel/inverter to finish; right-click finishes at the last point or
   cancels/removes a run. Routing auto-inserts right-angle elbows when
   consecutive waypoints sit on differently-oriented surfaces
   (`buildRoutedLegs`/`surfaceAxis`), so cable hugs a roof, turns, then runs
   down a wall like real conduit. Inverter-to-inverter links render as a
   single heavy orange "16mm flex" cylinder instead of the usual dual
   red/black strands (`heavy` flag in `buildCableSegment`). Once the
   10000-milestone building-jump is unlocked, clicking a roof you're
   standing on (nothing nearby to wire) sets a launch point; clicking a
   second roof boosts you there via real projectile-arc physics.
3. **Cable Router** — grab-and-bend an *existing* run: hold left-click on
   it, look to where you want the bend, release to route around an
   obstacle; right-click a bend to straighten it back out. Once the
   Salvage Yard is unlocked, right-click with nothing under the crosshair
   instead salvages the nearest panel (`salvagePanelUnderCrosshair` — drops
   panel-scrap for later pickup).
4. **Inverter Gun** — places wall-mounted inverters, wider grid spacing
   than panels. Tier 0 (3kW) units auto-combine by proximity, 3 → 1, into
   Tier 1 (10kW); **Tier 1+ units do NOT auto-merge** — right-click instead
   *selects* a big unit (gold outline), and selecting 3 same-tier units
   anywhere combines them (10 → 20 → 50kW), regardless of adjacency. Each
   inverter shows a floating sign with its kW rating and a running
   kWh-produced counter. `E` toggles a wired inverter's power switch.
5. **Water Gun** — unlocked by donating 1000 cable-scrap + 500 panel-scrap
   to the salvage cleric (see Progression/Salvage). Hold left-click to
   spray. See the Fire section for what spraying actually does — it's a
   real risk, not just a repair tool.

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
  (`updateInverterProduction`); a global `totalKwhProduced` sums this, shown
  top-right, alongside separate "panels laid" / "panels connected" /
  installed-kW counters (three distinct stats, not blended together).

## Fire, overload, and the water gun

**Overload doesn't destroy instantly.** `triggerInverterOverload` sets the
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
- **Collapse**: once every block is lit, `beginBuildingCollapse(b, st)` fires
  once. It first strips the building's wall/roof/parapet colliders and its
  body mesh out of `worldMeshes`/`placementSurfaces` (nothing to walk on or
  raycast against anymore), calls `collapseInstalledEquipment(b)` (below), then
  builds `st.floorGroups` — an ordered list of mesh groups from top to bottom:
  the roof + its parapet strips (one group), each window-band row top-down
  (one per row — these double as "floors" for this purpose), and finally the
  body mesh itself, flattened to `scale.y = 0.15` so it lands as a floor-thick
  slab instead of one giant box. `updateBuildingCollapse(dt)` then runs every
  frame: whichever floor group is "current" free-falls under gravity
  (`GRAVITY = 26`) until its lowest point reaches the top of the pile so far
  (`st.pileTop`), at which point it's nudged with a small random tilt, pushed
  into `groundColliders` (permanently walkable), `st.pileTop` grows by that
  floor's thickness, and the next floor up starts falling — so the whole
  building visibly pancakes down floor-by-floor rather than shrinking away or
  vanishing all at once. `finishDemolition` runs once the last floor lands:
  marks `st.rubbleSpawned`, scatters a handful of small decorative
  `DodecahedronGeometry` debris chunks on top of the pile (also walkable). A
  fully cabled district really can burn building-to-building and end up as
  rubble.
- `beginBuildingCollapse` calls `collapseInstalledEquipment(b)` *before* the
  floors start falling, which tears down any panels/inverters/cables whose
  position falls within the building's footprint (with a small margin) and
  drops a scrap pile on the ground at each one's own `x,z` — so array mounted
  on a burning building falls and lands *before* the structure under it does,
  rather than floating in mid-air or falling with the floors.
- The eventual plan (not built yet — **don't build it until asked**) is a
  Salvage Yard upgrade tool that lets the player clear/salvage these building
  rubble piles for scrap, similar to panel salvage today.
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

`upgrades` object gates most unlocks and buffs (`sprintMul`, `jumpMul`,
`heightMul`, `magBonus`, `reloadMul`, `fireRateMul`, `largePanelUnlocked`,
`salvageUnlocked`, `buildingJumpUnlocked`, `waterGunUnlocked`, `goldStars`).
Driven by `totalConnected` — panels that have ever been a cable endpoint,
cumulative and never decreases even if the cable is later removed — crossing
`MILESTONES` thresholds. Each milestone pops a big `showMilestoneBanner`
(gold, with star rating) — visually distinct from the small per-streak toast
and from `showDangerBanner` (red, reused for overloads/electrocution).

| Connected | Unlocks |
|---|---|
| 100 / 200 | Recognition banners only |
| 500 | Sprint speed ×1.35 |
| 1000 | Jump power ×1.35 |
| 1200 | Player height ×1.15 |
| 1500 | Large panel variant (toggle with `X`) |
| 2000 | Salvage Yard + scrap economy |
| 3000 | Gold Star ★ — stacking buff: sprint/jump ×1.15 again, +6 mag size, reload/fire-rate ×0.85, panel materials get a gold emissive tint (applies retroactively to every existing panel, since they share materials) |
| 5000 | Gold Star ★★ — same buff stack again |
| 10000 | Gold Star ★★★ — same buff stack again, **and** unlocks the Cable Gun building-to-building boost-jump |

## Salvage economy

Unlocked at 2000 connected. Two *separate* scrap types, tracked
independently:
- **Cable scrap** dropped when a cable is removed/destroyed (`destroyCable`
  with `withScrap`), one coil per segment.
- **Panel scrap** dropped when a panel is salvaged (Cable Router RMB with
  nothing aimed at) or destroyed live by the water gun.

Walking within ~1.6m of dropped scrap auto-picks it up into
`carriedCableScrap`/`carriedPanelScrap` (`updateSalvagePickups`). Walking
close (~3m) to the **salvage cleric** NPC at the Salvage Yard auto-donates
whatever's carried: converts to credits (10 each) and adds to lifetime
**given** totals (`givenCableScrap`/`givenPanelScrap`, never decrease), shown
on floating signs above the cleric's head. Reaching 1000 given cable + 500
given panel scrap unlocks the Water Gun. `credits` are tracked but not yet
spent on anything.

## Known simplifications / open threads

- Building "fire blocks" are pre-computed surface points + a progress
  counter, not real chunked/destructible geometry — the collapse itself now
  animates real floor meshes falling (see Collapse above), but there's still
  no wall-by-wall destruction, just fire-block progress followed by one
  scripted floor-drop sequence.
- No cleanup tool for building rubble piles yet — they accumulate forever
  and stay walkable. A Salvage Yard upgrade for this is planned but
  intentionally not built until asked for.
- No repair/rebuild mechanic for burnt panels or demolished buildings.
- Credits are tracked but nothing to spend them on yet.
- The `matFireBillboard` texture is fairly small/simple; could be prettied up
  later without touching the LOD logic.
- People, cars, and the train are still static/frozen by design — no
  movement/animation yet.

## Bug history worth knowing (don't reintroduce these)

- **Ground-snap fall-through**: the ground plane mesh was built but never
  actually pushed into `groundColliders`, so stepping off any building (or
  spawning) meant falling forever. Fixed by pushing `groundMesh` into the
  array right after creating it.
- **Stairs not reaching roofs**: exterior staircases were built ascending
  *away* from the building (wrong direction) and roofs had a fully sealed
  parapet with no gap for a staircase to enter through — fixed by reversing
  the stair direction and cutting a matching parapet gap on the stair side.
- **Overload only checked at power-on**: originally `toggleInverterSwitch`
  was the only place capacity got checked, so wiring *more* array into an
  already-running inverter never re-tripped it. Fixed by calling
  `checkLiveOverloads` after every wiring change, not just the switch.
- **Building fire under-lighting**: `advanceBuildingFire` incremented a
  block counter by 2 per tick but only ever spawned **one** decorative fire
  effect at a random point — buildings looked like they were barely
  burning. Fixed by pre-mapping real wall/roof points and lighting exactly
  the right number of them per tick.
- **Fire flicker was the main per-fire cost**: flame/smoke meshes were
  re-randomizing scale/opacity/position every single frame, which was both
  the visible over-fast "flashing" and most of the per-fire CPU cost. Fixed
  by holding a fixed pose and only rolling a new one on a random 1–2s timer
  (`f.flickerT`/`f.flickerInterval`).
- **Equipment floating after demolition**: a building's panels/inverters/
  cables weren't cleaned up when the building itself collapsed, leaving
  gear floating in mid-air where the wall used to be. Fixed with
  `collapseInstalledEquipment(b)`, called from `beginBuildingCollapse`, which
  tears down anything whose position falls within the building's footprint
  and drops scrap at its own spot.
- **Floors left floating after "collapse"**: the original demolition only
  scaled the single body-mesh box down to nothing — the roof, parapets, and
  decorative window-band meshes were separate objects the old code never
  touched, so they were left floating at their original height once the body
  vanished. Fixed by tracking those meshes on the building box
  (`roofMesh`/`parapetMeshes`/`windowMeshes`) and giving `updateBuildingCollapse`
  real per-frame fall physics for each of them, landing in sequence into one
  walkable pile.
- **Stale `carriedScrap` references**: when the single scrap counter was
  split into `carriedCableScrap`/`carriedPanelScrap`, two leftover reads of
  the old removed variable (in the HUD and `getProgress`) were left behind
  and would have thrown on first render — caught before push.

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
