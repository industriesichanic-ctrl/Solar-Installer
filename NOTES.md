# Solar Panel Gun — Design Notes

Working notes on how the current systems fit together, for picking this project
back up in a fresh chat. The code (`main.js` + `index.html`) is the source of
truth — this is a map of *why* things work the way they do, not a spec.

## Job Hut and jobs

**No job, no tools.** `currentJob` starts `null`, and on Map 1 (the city;
Map 2 has no Job Hut so it's exempt) that's enforced at every entry point:
`fire()` returns immediately if `currentJob === null`, the `mousedown`
listener returns before any per-weapon branch, and the `Digit*` keys are
inert with a toast — all gated on `MAP_ID === 1 && currentJob === null`.
Every weapon-1-4 view model (`gunGroup`, `cableGunGroup`, etc., and the four
new plumbing ones below) starts with `.visible = false` at construction, and
`setWeapon()`'s visibility block is keyed off `currentJob` for slots 1-4
specifically (`solarJob && w === 1`, etc.) — slots 5+ stay job-agnostic
universal tools (Water Gun, shop purchases, Demo Tool, gun 0), gated by
their own existing unlock flags instead.

### The dome (rotunda)

`buildJobHut()` — a large **open rotunda** at `(-6, 0, 30)`, radius
`JOB_HUT_R` (15): 16 pillars in a ring (`addWallBox` per pillar — wide gaps
between them, easy to walk through, no doorway needed) holding up a
half-sphere dome (`SphereGeometry` clipped to `phiLength/thetaLength` for
just the top hemisphere). No walls at all, so "walk inside" needed no doorway
cut into solid geometry — simplest way to get a genuinely large interior
space without new geometry-cutting code. **25 desks** line the inner ring
(`deskR = domeR - 3.5`), each facing the dome's center, with a clerk
(`buildPerson`) standing behind it, a small colored sample block on the
counter (green solar-panel-material for Solar, copper-pipe-material for
Plumber, grey for the 23 locked jobs), and the same icon+name label sprite
as before. `JOBS` still has all 25 entries (brainstormed the 23 beyond
Solar/Plumber: aircon, heat pump, carpenter, playground, road builder,
electrician, landscaper, painter, roofer, glazier, fence builder,
bricklayer, concreter, telecom, streetlight tech, sign installer,
irrigation, waste collector, pool builder, fountain builder, mural artist,
demolition contractor, security/CCTV) but only Solar and Plumber have
`unlocked: true` — the rest are deliberately inert, no invented unlock
criteria, per explicit instruction.

Selection is unchanged from before: `findJobTileUnderCrosshair()` intercepts
`mousedown` globally (same pattern as the Salvage Yard weapon shop, added
right after that intercept) — RMB aims/selects a desk (`selectJobTile`,
toasts if locked), LMB with something selected confirms
(`confirmJobSelection`), which sets `currentJob`, forces `setWeapon(1)` to
actually re-run (`currentWeapon = -1` first, since `setWeapon` no-ops when
`w === currentWeapon` and it's already `1` on a fresh spawn) so the new
toolkit becomes visible immediately, and pops a milestone banner.

### Plumbing loadout

Slots 1 and 4 are genuinely new tools with their own view models
(`hpGunGroup`, `pipeGunGroup`, `pipeRouterGroup`, `switchGunGroup` — visually
distinct from Solar's guns per "make their guns different please", not just
palette swaps of the same meshes) and slots 2/3 are Solar's *own* Cable
Gun/Router **completely unmodified**, just relabeled in the HUD — the
anchor/`cables` system already handles `heatpump`/`tap`/`watermain` anchors
generically (extended the same few-line way `battery`/`switchboard` were
earlier: `findNearestAnchor`, `anchorThickness`, `unwireAnchor`'s generic
`wiredCables.delete`, `isAnchorElectrified`), and a pipe is just a cable
rendered as one solid `matPipeCopper` cylinder instead of dual red/black
strands (`rebuildCableMesh`'s `pipe` flag, checked the same way the existing
`heavy` inverter-to-inverter flag is).
- **1: HP Gun** (`fireHeatPumpTank`/`placeHeatPumpTank`) — places a heat
  pump tank, grid-snapped exactly like `placePanel` (mirrors its structure:
  `getHeatPumpPlacementTarget`/`isHeatPumpSpotFree`), same 12-round magazine
  as the Solar Panel Gun (just the shared `ammo`/`MAG_SIZE` — no separate
  plumbing magazine needed). Pushes into the **same** `heatPumps[]` array
  every previously-decorative `buildHvacUnit` (wall *and* roof scatters, 20
  in the current world) already populates, so player-placed tanks and
  existing world-dressing HVAC units are indistinguishable as anchors.
- **2: Pipe Gun / 3: Pipe Router** — literally `cableClick`/`cableRightClick`/
  `routerLeftDown` etc., zero new code, just a job-aware HUD label branch in
  `updateHud`.
- **4: Power Switch** (`fireTap`/`placeTap`, internal names kept from an
  earlier "tap" design — see bug history for why a full rename felt too
  risky to do blind) — placement is gated by `getPowerSwitchPlacementTarget`,
  which only returns a target if some `heatPumps[]` entry is within
  `POWER_SWITCH_RANGE` (1m) of the aimed wall point; otherwise `fireTap`
  toasts "MUST BE PLACED WITHIN 1M OF A HEAT PUMP" and places nothing. `E`
  (`handleInteractKey`, which already checks rubble first) also checks
  `toggleTapUnderCrosshair()` before falling back to the inverter switch.
- **Water mains**: one `buildWaterMain` pipe-stub-and-cap prop per building
  (`waterMains[]`), placed just outside each building's `minX` face —
  "little clumps near every building."
- **Flow check**: `isTapNetworkComplete(tap)` is a component-wide BFS across
  `cables` (same fidelity as `isSwitchboardEnergized` — not strict path
  tracing) requiring the connected component to contain both a `heatpump`
  and a `watermain` anchor. `updateTapFlow()` re-checks every switch (called
  after `finishCable`, and via the generalized `unwireAnchor` after
  `destroyCable`) and, on one whose `.on` is true newly satisfying that,
  turns its indicator green and pops a "WATER FLOWING" banner.

Verified live end-to-end: `currentJob` starts `null` and both firing and
weapon-switching are correctly inert until a job is picked; picking Plumber
at a desk correctly sets `currentJob`; the HP Gun places a tank and
correctly spends 1/12 ammo; `getPowerSwitchPlacementTarget` correctly
returns `null` far from any heat pump and a valid target within 1m;
`isTapNetworkComplete` reads `false` before a water main is wired and `true`
right after; and Solar (placing panels) is unaffected as a regression check.

### Plumbing follow-up fixes (v15)

Four bugs reported after the v14 rebuild, all in the plumbing toolset:
- **Solar lingo leaking into plumber mode**: `handleInteractKey()`'s `E`
  fallback unconditionally called `toggleInverterSwitch()` (whose no-target
  toast is "AIM AT AN INVERTER TO SWITCH IT") regardless of `currentJob`.
  Now job-gated: in `currentJob === 'plumber'`, `E` only ever calls
  `toggleTapUnderCrosshair()` and shows "AIM AT A POWER SWITCH TO TOGGLE IT"
  on a miss, never touching `toggleInverterSwitch()` at all. Solar mode was
  already fine in the other direction (`toggleTapUnderCrosshair()` fails
  silently when nothing's hit, so no plumbing lingo could leak into it).
- **Tanks rendered on their side**: `placeHeatPumpTank`'s cylinder had
  `tank.rotation.x = Math.PI / 2`, which points the cylinder's axis
  sideways. Removed — the tank now always stands world-Y-up regardless of
  the surface it's snapped to (unlike panels, which tilt to match the
  surface). Since the mesh itself no longer carries the surface orientation,
  grid-snap math (`getHeatPumpPlacementTarget`'s right/fwd basis for
  adjacent-cell candidates) now reads a separate `snapQuat` stored on each
  heat pump object instead of `mesh.quaternion`.
- **No streak celebration**: heat pumps had no equivalent of panels'
  touching-adjacency `groups`/`STREAK_THRESHOLDS`/`spawnGroupGlow` system.
  Added a parallel `heatPumpGroups`/`nextHeatPumpGroupId`/
  `heatPumpsAdjacent()` mirroring `placePanel`'s merge-on-place block
  exactly, reusing the same `STREAK_THRESHOLDS` and `spawnGroupGlow` (both
  generic enough to take either panels or heat pumps, since they only touch
  `.pos`/`.normal`/`.mesh.quaternion`).
- **No 100-placement area tool**: added `totalHeatPumpsPlaced` (player
  placements only, decorative `buildHvacUnit` units don't count),
  `unlockedHeatPumpAreaTool` at `HEATPUMP_AREA_TOOL_UNLOCK_COUNT` (100), and
  a full parallel drag-fill tool (`beginHeatPumpAreaDragCandidate`/
  `computeHeatPumpAreaCells`/`updateHeatPumpAreaDragPreview`/
  `commitHeatPumpAreaFill`/`endHeatPumpAreaDrag`, `ghostHpAreaMesh`) — same
  hold-RMB-drag-release mechanic as the Solar Panel Gun's Area Tool, reusing
  `pointOnPlacementSurface` for surface-footprint clipping. Weapon-1's RMB
  in the `mousedown`/`mouseup` listeners now branches on `currentJob` before
  choosing which area tool (or pick-up) to run.

### Loadout rework v16 — Switch/MSWB/AC Cable, water taps, activation chain

Implemented the full re-spec: `1: HP, 2: Pipe, 3: Switch, 4: AC Cable
(white TPS), 5: MSWB`. Two parallel systems now share the heat pump as a
common anchor, disambiguated purely by anchor *type* at cable-render time
(`rebuildCableMesh`'s `electricalTypes = ['switch','mswb']` checked before
`plumbingTypes = ['tap','heatpump','watermain']`, since a cable's two ends
are never a mix of both):
- **Water** (Pipe gun, slot 2): `cableClick`/`cableRightClick` unchanged —
  LMB wires heatpump↔watermain/tap (copper pipe render); with no run
  active, RMB now drops a **Water Tap** (`fireTap`/`placeTap`, same
  proximity-to-heat-pump mechanic the old mislabeled "Power Switch" used,
  just renamed to what it actually always was). Capped at
  `MAX_TAPS_PER_HEATPUMP` (10) via a simple distance-bucket count in
  `fireTap` — the 11th attempt near the same heat pump just toasts instead
  of placing.
- **Electrical** (Switch slot 3 + AC Cable slot 4 + MSWB slot 5): `Switch`
  (`fireSwitch`/`placeSwitch`, same 1m-of-heat-pump gating as taps) wires to
  an `MSWB` (`fireMswb`/`placeMswb`, placed anywhere like an inverter) via
  the **same generic** `cableClick`/`cableRightClick` on slot 4, rendered
  white (`matAcCable`) because the anchor types are `switch`/`mswb`.
- **Activation order matters**: `toggleSwitchUnderCrosshair` (E on a
  switch) only turns it on if `isSwitchMswbPowered` (BFS across `cables` to
  a `mswb` with `breakerOn`) **and** `isHeatPumpPlumbed` (BFS from the
  nearby heat pump to a `watermain`, or a `tap` that's `.flowing`) are both
  true. Flip it early — MSWB on, but plumbing not done — and
  `spawnWaterBurst` fires: 16 tumbling blue boxes (`matWaterBlock`, 3
  shades) with simple gravity, no physics engine, removed after 1.4s,
  ticked by `updateWaterBursts(dt)` in the main loop. Succeed and it's the
  actual "prize" — `showMilestoneBanner('🎉','HEAT PUMP SYSTEM ONLINE!')`.
  MSWB's own breaker toggle (E on it) just needs *something* wired, no
  burst risk there — it's upstream of water entirely.
- `handleInteractKey`'s plumber branch now chains
  `toggleTapUnderCrosshair → toggleSwitchUnderCrosshair →
  toggleMswbUnderCrosshair`, falling back to a plumbing-only toast — still
  never touches `toggleInverterSwitch()`.
- `setWeapon`'s slot 5 is job-conditional the same way slots 1-4 already
  were: `mswbGunGroup` for Plumber, `waterGunGroup` (unchanged) for
  Solar/no-job — the `Digit5` handler had to be updated too, since it
  previously hard-gated slot 5 behind `upgrades.waterGunUnlocked`, which is
  a Solar-only unlock a plumber would never trip.

Verified via `window.__debug` (a minimal hand-rolled Vector3-alike, since
the module's real `THREE` isn't on `window`): placed a heat pump, switch,
and MSWB directly; confirmed the tank mesh's `rotation.x === 0` (upright);
confirmed `isSwitchMswbPowered`/`isHeatPumpPlumbed` both correctly flip
from `false` to `true` only after pushing the matching fake cable objects;
confirmed `spawnWaterBurst` runs with no console errors. Not yet
live-tested with actual mouse/pointer-lock input in a real play session —
that's the next thing to do before calling this fully done.

### Locked-job planned loadouts (v17, display-only)

Each of the 23 locked `JOBS` entries now carries a `tools` array — the
6-tool loadout the user itemized for every remaining trade, following the
shared `Place → Connect → Configure → Test → Repair/Clean` workflow shape.
Purely cosmetic: `selectJobTile` shows it in the toast (`job.tools.join('
· ')`, 5s duration since it's a long line) when RMB-selecting a locked
desk at the Job Hut, nothing else reads `tools` anywhere. No new tools,
meshes, or mechanics — matches "no need to code the other jobs now,"
just makes the plan visible before it's built.

### Job Hut hot-swap loadout panel (v18)

Replaced the flat toast list of a locked job's planned tools with a real
3D readout, plus a genuine "aim and hot-swap" mechanic:
- `jobLoadoutPanel` is a `scene`-space (not camera-space) group repositioned
  onto whichever desk's tile was just RMB-selected
  (`jobLoadoutPanel.position/rotation` set from the tile's stored
  `dx/dz/facing` — `jobTileMeshes` entries now carry those, not just
  `{mesh, job}`), with up to `MAX_LOADOUT_ROWS` (6) rows stacked vertically
  above the desk. Being world-space (not HUD-anchored like the gun view
  models) is what makes "aim at the individual guns" literal — turning your
  head really does move the crosshair across the stack.
- Each row = a small icon + a smaller text label (`makeTextSprite` at
  `fontSize:20, scale:0.16`, vs. the desk name label's `fontSize:26,
  scale:0.4` — deliberately smaller per the request). For Solar/Plumber
  (the two coded jobs) the icon is a live `.clone(true)` of that slot's
  *actual* view-model group (`LOADOUT_SLOT_MODELS`) — so it really does
  "show what it looks like." The 23 uncoded jobs fall back to
  `buildGenericToolIcon()`, a generic mini box-and-barrel silhouette, since
  they have no real mesh yet.
- **Hot-swap**: `findLoadoutRowUnderCrosshair()` raycasts the visible rows'
  icon meshes; RMB on one calls `hotSwapSlot`, which writes
  `loadoutSkins[slotIndex] = { name, iconTemplate }` — keyed to the
  *player's own currently equipped job*, regardless of which desk's panel
  is on screen (so you can stand at the Aircon desk and reskin your
  Plumber slot 1 with the Indoor Unit Gun's look). This is **cosmetic
  only**: the slot's underlying `fire()`/`mousedown` behavior never
  changes, just what's rendered in-hand (`customSkinGroup`, a camera-child
  populated by `refreshEquippedSkin()` cloning the stored `iconTemplate`)
  and the HUD's bold title (`updateHud` prepends a "hot-swapped skin — same
  function as before" line when `loadoutSkins[currentWeapon]` is set).
  `setWeapon()` hides every job's normal view-model group whenever the
  slot being switched to has a skin, so the reskinned look doesn't get
  clobbered back to the original mesh.
- Verified via `window.__debug`: populated the panel for a locked job
  (Aircon, 6 rows, each with a name + real icon mesh), hot-swapped its
  first row into Plumber's slot 1, confirmed `loadoutSkins[1]` persists
  across a `setWeapon` no-op guard (switch away and back), no console
  errors. Not yet tested with real mouse-look aiming in a live play
  session.

### Demolition Contractor — third playable job (v19)

Picked as the next job specifically to be a "wtf" moment for friends
watching, not another connect-the-utilities build like Plumbing — the hook
is that you can walk up to any existing city building and bring it down on
demand, mid-game, with a real floor-by-floor collapse.

- **1: Safety Barrier Gun** (`fireBarrier`/`placeBarrier`) — cosmetic
  ground marker, no gating.
- **2: Structural Scanner Gun** (`fireScan`) — aims via `raycastWorldHit()`
  → `findBuildingContaining(x,z)` (the same helper fire-spread already
  used), adds the building to `scannedBuildings`, shows fake-but-fun
  diagnostic numbers. Required before charges can be armed on it — gives
  the tools a reason to be used in order.
- **3: Breaker Gun** (`fireBreaker`) — cosmetic wall-chip particles only
  (reuses `waterBursts[]`'s generic gravity+lifetime tumble updater from
  the Plumbing burst effect — same array, same `updateWaterBursts`, no new
  per-frame updater needed), no persistent damage state.
- **4: Controlled Charge Gun** (`fireCharge` LMB arms / `detonateCharges`
  RMB fires) — up to `MAX_CHARGES_PER_BUILDING` (6) charge props per
  building, gated on that building being scanned first. Detonating is the
  actual payoff: it calls `getBuildingFireState(b)` +
  `beginBuildingCollapse(b, st)` — the **exact same functions** the
  building-fire system already uses for its floor-by-floor pancake
  collapse (`buildCollapseFloors`, `collapseInstalledEquipment`,
  `updateBuildingCollapse`) — just triggered on demand instead of waiting
  for a fire to fully engulf the building. No new collapse logic at all,
  just a new *entry point* into code that already existed. Also fires
  `spawnDemolitionBlast` (a bigger, dust-colored version of the same burst
  effect, 40 tumbling blocks + a decaying `PointLight` flash) and
  `triggerScreenShake` (new: a `shakeTime`/`shakeMag` pair, applied as a
  random position jitter once per frame right before `renderer.render()` —
  safe to do with no "undo" step since `camera.position` is fully
  overwritten by movement code every single frame anyway).
- **5: Debris Vacuum Gun** — not a new tool at all, just the existing Demo
  Tool (weapon 8) shown under slot 5 for this job (`demoToolGroup.visible`
  extended with an `|| (w === 5 && demoJob)` clause, `Digit5` no longer
  gated behind the Water Gun's salvage unlock for this job either — mirrors
  exactly how Plumber's MSWB got its own slot-5 carve-out).

Verified via `window.__debug`: `beginBuildingCollapse` triggered directly
on a real building box (bypassing charges/scan entirely) correctly flips
`collapsing: true` and builds a real `floorGroups` array (7 floors for the
test building); `spawnDemolitionBlast`/`triggerScreenShake` run with no
console errors; the Job Hut hot-swap panel correctly lists all 5 real
slot names/icons for `demolition` now that it's `unlocked: true`. Did
**not** verify the collapse actually finishes animating in a live locked
session (the automated check ran with the pointer never locked, so
`updateBuildingCollapse` may not have been ticking) — worth a live
playtest to confirm the pancake collapse visually completes the same way
it does when triggered by fire.

### Explicitly deferred (asked for, not yet built)

- Panels placed on the road getting cracked/shattered by passing traffic
  (white line "glass" cracks).
- The old rooftop staircase that ran all the way to the top of a building
  with a jump-gap near the top — replaced earlier this session by the
  floor-by-floor pancake collapse system; bringing it back means it'd need
  to coexist with that collapse logic rather than just reverting it.

## Mobile / touch controls

`IS_MOBILE` (`window.matchMedia('(pointer: coarse)').matches`, checked once
at load) gates an entirely separate *input* layer with zero separate *game
logic* — the design goal was that desktop stays byte-for-byte behaviorally
unchanged, and mobile just produces the same events the keyboard/mouse
already would:
- **Movement**: the joystick (`#mJoystickBase`/`#mJoystickKnob`, fixed
  bottom-left) doesn't drive position directly — it adds/removes `KeyW`/`A`/
  `S`/`D` from the same `keys` Set the keyboard handler uses, snapped to an
  8-way deadzone (`setJoystickKeys`), since the movement code only ever
  calls `keys.has(...)`, never reads an analog magnitude.
- **Look**: dragging `#mLookZone` (full-screen, *behind* every button/
  joystick in DOM order, so touches on those hit them first, not the look
  zone underneath) dispatches a real `document.dispatchEvent(new
  MouseEvent('mousemove', { movementX, movementY }))` per frame of drag —
  the existing `mousemove` listener that drives `yaw`/`pitch` doesn't know
  or care that the event was synthetic.
- **Firing / secondary action**: `#mFire`/`#mAlt` dispatch synthetic
  `mousedown`/`mouseup` with `button: 0`/`2` for the duration of the touch —
  every weapon's existing per-weapon LMB/RMB branching in the real
  `mousedown` listener runs completely unmodified.
- **Jump / sprint / crouch**: `#mJump`/`#mSprint`/`#mCrouch` add/remove
  `Space`/`ShiftLeft`/`KeyC` from `keys` for the duration of the touch, same
  as the joystick.
- **Reload / interact / map / weapon switch**: `#mReload`/`#mInteract`/
  `#mMap`/`.mWeaponBtn` dispatch a one-shot synthetic `keydown` with the
  matching `code` on tap — same `keydown` listener the keyboard uses.

`setPlayState(locked)` replaces the old inline pointer-lock-only show/hide
logic — desktop still calls it from `pointerlockchange` exactly as before,
but on mobile there's no real Pointer Lock (touch devices don't meaningfully
support it), so tapping the start overlay calls `setPlayState(true)`
directly and `pointerlockchange` is ignored entirely (`if (IS_MOBILE)
return;` at the top of that handler).

Known gap: the full map's scroll-to-zoom (`mapZoom`, desktop `wheel`
listener) has no touch equivalent yet (no pinch-to-zoom) — `M` still opens
it, it just always opens at the default zoom on mobile. Not implemented due
to time, not a design decision — worth adding if mobile map use turns out
to matter.

## Maps

The start screen's `#mapPanel` (left column, `index.html`) lists 10 map
slots; only 1 and 2 are wired up, 3-10 are `.locked` placeholders. Picking a
map is a **full page reload** with `?map=N` in the URL — `MAP_ID` (read once
at the very top of `main.js` via `URLSearchParams`) then gates the
map-specific branches sprinkled through the rest of the file. This was a
deliberate simplification over building a real "tear down and rebuild the
scene" system: the existing Map 1 world-build is a large amount of working
top-level code with no init/teardown boundaries, and safely wrapping all of
it in a live map switch would have been a much bigger, riskier job than a
reload. The trade-off: **Map 1's entire city still gets built even when
playing Map 2** (nothing skips it) — Map 2's world just lives at a huge
coordinate offset (`MAP2_ORIGIN = {x: 3000, z: 0}`, camera far-plane is 400,
so it's not even in view distance of Map 1) and the player spawns there
instead. This costs some memory/CPU building a city nobody will visit in
Map 2 mode; fine at the current scale, but if a 3rd real map gets added, it's
probably worth revisiting with an actual init/teardown split.

### Map 2 — Solar Farm (Open Range)

Built by `buildSolarFarmMap()`, called once at the very end of the file
(right before `animate()` — by then every shared array/material/function it
reuses is guaranteed to have already run, sidestepping any `const` temporal-
dead-zone ordering concerns with reusing Map-1 systems from a spot much
earlier in load order). Open grass plane, ~130 trees scattered around
(skipping the array/hardstand/spawn footprints), a fixed **1MW tilted solar
array**, and a decorative battery hardstand.

- **Loadout differences**: `upgrades.gun0Unlocked` and
  `upgrades.switchboardUnlocked` start `true` — no 20-power-system or
  100kWh-of-batteries grind here, gun 0 is just available. Weapon 1 (LMB) is
  entirely replaced: `fire()` branches on `MAP_ID === 2` right at the top and
  calls `fireTreeCutter()` instead of placing a panel — same ammo/reload
  economy as the normal panel gun, just a different action. `map2Trees`
  tracks each tree's meshes/collider so a hit chunk can be fully removed
  (RMB/area-tool/ghost-preview for weapon 1 are all separately guarded off
  for `MAP_ID === 2`, since none of that applies and the RMB "pick up
  nearest panel" action in particular would otherwise let the player yank
  the fixed array anchors back out of the world).
- **The array**: `MAP2_ARRAY_SECTIONS` (20) tilted sections, each a real
  entry pushed directly into the shared `panels[]` array (bypassing
  `placePanel` — these are fixed infrastructure, not something the player
  placed) with `watts: 50000` (1,000,000 / 20) and `groupId: null` so each
  section needs its **own separate cable** to an inverter — there's no
  touching-group shortcut that would let one cable reach all 1MW at once.
  The Cable Gun's existing anchor system (`findNearestAnchor` et al., type
  `'panel'`) works on these anchors completely unmodified.
- **Inverter tiers are different on this map**: `MAP2_INVERTER_CAPACITY_KW =
  [25, 50, 100, 250]` vs Map 1's `[3, 10, 20, 50]`. Every place that used to
  index `INVERTER_CAPACITY_KW` directly now goes through
  `inverterCapacityKw(tier)`, which picks the table based on `MAP_ID` — this
  is the one piece of Map-1 machinery that had to change to support Map 2,
  since inverter tiers are otherwise global, not per-map state.
- **Goal**: `computeMap2ProgressKw()` sums `inverterCapacityKw(tier)` for
  every powered-on inverter whose `collectInverterNetwork(...).watts > 0`
  (i.e. actually reaching some of the array, not just any powered inverter
  anywhere) — checked every frame by `checkMap2Goal()`, which pops a
  milestone banner once it crosses `MAP2_GOAL_KW` (500) and then stops
  checking (`map2GoalReached`). Shown live in the HUD as "Array: X/500kW".
- **Battery hardstand is intentionally inert** — visual only (oversized
  battery-bank meshes, not real `batteries[]` entries), no switchboard
  wiring to it yet. This isn't a bug or an oversight: how the player is
  meant to unlock a cable able to reach it hasn't been decided yet — the
  user's own words were "will figure out an unlock for that." Don't invent
  one; ask first.

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

**Browser caching**: `index.html` loads the game via
`<script type="module" src="./main.js?v=N">` — bump `N` whenever `main.js`
changes and gets pushed. Without a new query string, some browsers keep
serving a cached copy of the old `main.js` even after GitHub Pages has
redeployed the new one, which shows up as "I fixed that bug but the live
site still does the old thing" — confusing, since local testing (a fresh
`node --check` + fresh page load against the dev server) will correctly show
the fix working. If a live-site bug report doesn't reproduce locally, check
the cache-buster got bumped before assuming it's a real regression; if it
still doesn't clear, tell the user to hard-refresh (Ctrl+Shift+R).

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
  each with a flat roof, a parapet, and (most of them) exterior floor access
  up one side (`buildFloorAccess`, replaced the old single-flight
  `buildAccessRamp`) — a balcony landing + door prop at every floor level
  (window-band height), alternating between a wider "fire escape" flight and
  a narrower flight (buildings are solid boxes with no modeled interior, so
  this narrower flight just *reads* as an enclosed stairwell rather than
  being a literal separate interior — see the Floor access section below),
  then a vertical ladder (rails + rungs + small climbable step platforms) for
  the final run from the top floor to the roof.
- **HVAC installs**: heat pump / aircon condenser units (`buildHvacUnit`)
  scattered on building walls at ground level and on rooftops, each paired
  with a static installer NPC in a new bent-forward `'install'` pose
  (`scatterWallHvac`/`scatterRoofHvac`) — purely decorative, frozen in place
  like the rest of the population.
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

### Floor access (fire escapes, balconies, roof ladder)

`buildFloorAccess(box, side)` (called once per building that has a
`stairSide`, both regular and mega buildings) replaces what used to be one
continuous flight straight to the roof. Floor levels are computed the same
way `windowMeshes` rows are (`1.8 + r * 3.2`, stopping once within 1.2 of
`topY`), so doors line up with the window bands. For each floor: a
`buildFlight` climbs from the previous level to this one (alternating
`matRail`-colored 2.4-wide "fire escape" flights on even floors and
`matCrate`-colored 1.6-wide narrower flights on odd floors — purely a visual
alternation, both are still exterior-attached box steps pushed into
`groundColliders`), then `buildLanding` adds a walkable deck with 3 rail
posts and a door prop (`matDoor`, flat box on the wall) at that height. Once
every floor level is climbed, the final segment from the top floor to the
roof is a vertical ladder — two rail cylinders + rungs for looks, plus a
stack of small `matCrate` step platforms at the same heights so it's
actually climbable (this simple box-collider ground-snap system has no
dedicated ladder-climb mechanic, so a literal thin ladder mesh wouldn't be
walkable on its own).

Known limitation, called out up front rather than hidden: because buildings
are solid single-box meshes with no hollow interior, the "narrower flight"
segments are still exterior-attached, just styled to read as an enclosed
stairwell — there's no way to actually walk *through* a door into a real
room without redesigning how buildings are constructed (floor slabs +
interior walls per building), which wasn't done here. Doors are entry-point
props, not real openings.

The train, the market/park crowd, and most parked cars are still
**static/frozen** — that was an explicit "later" from the original ask, not
an oversight. Two small pieces of ambient movement now exist though:

### Perimeter loop road + circling traffic

The building grid only ever occupies roughly -90..90 (ground extends to
±140), so `buildLoopRoad()` lays a square road (`LOOP_R = 115`, 4
`matRoad`-colored strips joining `LOOP_CORNERS`, pushed into
`groundColliders`) well outside every building — cars on it never need to
navigate around anything or hit a dead end. `pointOnLoop(dist)` parameterizes
the whole loop as one wrapping distance value (`dist % LOOP_PERIM`), so a
car (`movingCars`, built with a dedicated `buildMovingCar` that mirrors the
static `buildCar`'s look but returns the group and skips the wall collider)
just keeps adding to its own `dist` every frame (`updateMovingCars`) forever
— no per-segment branching, intersection logic, or dead-end handling needed.
Rotation each frame comes from the corner-to-corner direction vector
(`Math.atan2(-dz, dx)`, matching `buildCar`'s existing rotation convention).
The original scattered parked cars near the central cross are untouched and
stay static.

### Wandering NPCs (market fountain + park lake)

`buildWanderer(cx, cz, radius, speed, phase, pose)` places one `buildPerson`
NPC and adds it to `wanderers`; `updateWanderers(dt)` walks its `angle`
forward each frame and repositions it on a circle around `(cx, cz)` —
4 around the market fountain (`SPECIAL_ZONES[0]`), 3 around the park lake
shore (`SPECIAL_ZONES[1]`, radius kept outside `lakeR`), alternating
clockwise/counterclockwise with a slow, randomized walking-pace angular
speed. Facing rotation is approximate/cosmetic — `buildPerson`'s silhouette
has no strong front-facing marker beyond arm poses, so exact heading
accuracy doesn't matter here the way it does for the boxy, obviously-oriented
cars. The rest of each zone's crowd (`buildPerson` calls in
`buildMarketSquare`/`buildParkLake` itself) stays static, unchanged.

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

## Weapons (0–8)

1. **Solar Panel Gun** — places panels on any upward or near-vertical
   surface (roofs + walls). **Grid-snaps**: aiming near an existing panel
   locks the ghost to one of its four edge-adjacent slots, so building a
   uniform array is easy. Placing 5/10/20/50 *connected* panels in a row
   triggers a brief celebratory glow around the whole run
   (`spawnGroupGlow`) plus a toast — smaller/quicker than the milestone
   banner (see Progression). Unlocks a drag-select **Area Tool** at 100
   panels placed (hold RMB on a start point, look to the far corner,
   release to fill the rectangle — since pointer lock means mouse movement
   is camera-look, "dragging" is done by swinging the view). Unlocks
   **Block Placement** at 1000 panels placed (`BLOCK_PLACE_UNLOCK_COUNT`) —
   press `B` to toggle; while on, LMB drops a centered 5×5 (25-panel) block
   in one shot (`computeBlockCells`) instead of a single panel, costing 25
   ammo per shot (RMB drag-fill still works independently of this toggle).
   Unlocks a **large panel** variant (2× size, teal tint, 350W vs the
   standard 250W) at 1500 connected panels — toggle with `X`.
   Both the Area Tool and Block Placement clip their grid to the actual
   surface footprint via `pointOnPlacementSurface` (a short raycast back
   into the surface for each candidate cell) — a cell that would land past
   the real wall/roof edge, out over open air, is silently dropped instead
   of placing a floating panel.
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
   kWh-produced counter. `E` toggles a wired inverter's power switch — or, if
   aiming at a tagged rock/timber rubble chunk instead, picks up 1 unit of it
   (`handleInteractKey` checks rubble first, falls back to
   `toggleInverterSwitch`; see Demo Tool below for the rest of that chain).
5. **Water Gun** — unlocked by donating 1000 cable-scrap + 500 panel-scrap
   to the salvage cleric (see Progression/Salvage). Hold left-click to
   spray. See the Fire section for what spraying actually does — it's a
   real risk, not just a repair tool. Putting out 10 fires (`registerExtinguish`,
   called from both `extinguishInverter` and `extinguishPanel`) unlocks
   **powder** (`upgrades.powderUnlocked`, `POWDER_UNLOCK_COUNT = 10`) — hold
   RMB while spraying (tracked globally via `rmbDown`) to switch the stream
   to powder (tan-colored instead of blue, `waterStreamMesh.material.color`).
   Powder still destroys anything still live — it can't repair a live
   circuit either — but it doesn't conduct back to the player, so
   `waterSprayTick(powder)` skips `electrocutePlayer()` on that branch.
6. **Panel Repair Tool** — bought at the Salvage Yard weapon shop (see Weapon
   shop below), not milestone-gated. LMB aims at a panel; if it's charred
   (`.burnt`) and not still on fire, restores its clean material. Purely
   cosmetic — burning never deducted a panel's wattage in the first place
   (`collectInverterNetwork` doesn't check `.burnt`), so there's no watts
   change on repair either.
7. **Bulk Inverter Gun** — also a shop purchase. LMB fires a Tier 1 (10kW)
   inverter directly onto a wall (`placeInverter(point, normal, 1)`),
   skipping the normal grind of placing 3 Tier-0 units and waiting for them
   to auto-merge.
8. **Demo Tool** — a shop purchase, gated in two layers (see Weapon shop
   below): it only appears for sale once 100 given rock + 100 given timber
   are on hand, and then costs 200/200 to actually buy. Before you own it,
   rubble is only collectible one unit at a time with the baseline `E`
   interact (`handleInteractKey`) — no weapon needed. Once bought
   (`upgrades.demoToolUnlocked`, `upgrades.demoToolTier = 1`):
   - **Tier 1**: LMB breaks up one rubble chunk under the crosshair for +20
     of its type at once (`fireDemoTool` → `harvestRubbleChunk(idx, 20)`).
   - **Tier 2** (auto-unlocks at 500 given rock + 500 given timber, checked
     in `maybeUpgradeDemoTool`): LMB can now also aim at an already-dropped
     loose scrap pickup (cable/panel/inverter/rock/timber, anything in the
     `scraps` array) and pick it up directly, one unit, instead of only
     working on rubble; RMB held + swept across a rubble field
     "drag-collects" (`demoDrag`/`updateDemoDrag`, ticks every 0.12s) rubble
     chunks one at a time up to 100 per drag session.
   - **Tier 3** (auto-unlocks at 100 given panel + 100 given cable + 100
     given inverter): the RMB drag now also sweeps up loose scrap of *any*
     type, not just rubble — same 100-per-drag cap.
   Building rubble piles spawn 12 tagged "rock"/"metal"/"timber" chunks
   (`salvageableRubble`, split evenly across the three types) on top of the
   pile alongside 10 plain decorative debris chunks at `finishDemolition`
   time — this happens regardless of whether the Demo Tool has been bought
   yet, since `E` needs something to pick up from the very start.
0. **Battery & Switchboard Gun** — auto-unlocked once `totalPowerSystemsActivated`
   (every successful "SOLAR ARRAY ONLINE" event — see `toggleInverterSwitch`,
   cumulative, never decreases) hits `POWER_SYSTEMS_FOR_GUN0` (20). LMB
   (`fireBattery`) places a battery on a wall, same grid-snap placement rule
   as inverters (`getBatteryPlacementTarget` reuses `findInverterPlacementHit`).
   Batteries combine like inverters but simpler: **every** tier auto-merges
   by proximity (`mergeBatteryGroups`), `BATTERY_MERGE_COUNT` (5) at a time,
   through `BATTERY_CAPACITY_KWH = [2, 5, 20, 50]` — 5×2kWh → one 5kWh unit,
   5×5kWh → one 20kWh unit, 5×20kWh → one 50kWh unit. There's no manual
   RMB-select merge tier like inverters have, since RMB on this gun is
   reserved for switchboards instead. `totalBatteryKwhInstalled` tracks the
   *currently installed* total (decremented in `removeBatteryFromWorld`,
   same pattern as `totalWattsInstalled` for panels) — cascading merges must
   subtract the consumed lower-tier units' kWh or the total inflates with
   phantom energy every merge (caught and fixed before push, see bug
   history). RMB (`fireSwitchboard`) places a switchboard once
   `totalBatteryKwhInstalled` reaches `SWITCHBOARD_UNLOCK_KWH` (100) — a
   one-way unlock, like the water gun's scrap gate, not a live gate that
   re-locks if kWh later drops back down from more merging.

## Energizing a switchboard (building + street lamps)

The Cable Gun (weapon 2) now also accepts battery and switchboard anchors —
`findNearestAnchor`/`anchorThickness`/`wireAnchor`/`unwireAnchor`/
`isAnchorElectrified` were all generalized from their inverter-only form (see
bug history for what `unwireAnchor` was missing). `isSwitchboardEnergized(swb)`
does a component-wide BFS from the switchboard across `cables` (not strict
path-tracing, same fidelity level as `collectInverterNetwork`): energized
requires the connected component to contain **both** at least one battery
and at least one powered-on inverter, anywhere in it. `updateSwitchboardEnergize()`
re-checks every switchboard and is called after `finishCable`, both branches
of `toggleInverterSwitch`, and (via the generalized `unwireAnchor`) after
`destroyCable`/battery-merge cable reassignment. On an energized transition,
`applyNearbyLighting(swb.pos, on)`:
- finds the building at that position (`findBuildingContaining`) and
  re-colors its `windowMeshes` (bright warm `0xffd98a` when on, back to the
  normal dim `0x2a3a44` when off) — the same array the building-collapse
  floor system already tracks.
- turns on any `streetLamps` (one per stair-equipped building, placed near
  its floor-access base, off by default — `buildStreetLamp`/`setStreetLampOn`)
  within 20 units of the switchboard.

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
  once. It first snuffs out every open flame the building's own fire-spread
  put on it: `st.fires` (every fire object `advanceBuildingFire` spawned,
  tracked as they're created) gets flipped from `persistent: true` to
  `persistent: false, dur: 5, t: 5` — reusing the *existing* non-persistent
  flame/smoke fade in `updateFires` rather than any new code, so each one
  just moulders/smokes out over 5 seconds instead of burning indefinitely.
  It then strips the building's wall/roof/parapet colliders and its
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
  marks `st.rubbleSpawned`, scatters 10 small decorative `DodecahedronGeometry`
  debris chunks on top of the pile for bulk (also walkable, not individually
  salvageable), then 12 more that *are* salvageable — split evenly across
  `rock` (boulder), `metal` (bent beam), and `timber` (splintered beam),
  pushed into `salvageableRubble` — the collapsed floors read as a genuinely
  mixed pile of debris types rather than just rock. A fully cabled district
  really can burn building-to-building and end up as rubble.
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

Fires beyond `FIRE_LOD_RADIUS` show a cheap static billboard sprite (one
shared canvas texture/material, `matFireBillboard`) and skip **all**
per-frame animation — for a far fire, `updateFires` only decrements a
non-persistent fire's remaining-life timer, nothing else. The detailed group
(5 flame cones + 4 smoke spheres + a `PointLight` — the expensive part) is
built **lazily**, only the first time a fire is actually within
`FIRE_LOD_RADIUS` of the player (`buildFireDetail`), not at ignition.
`FIRE_LOD_RADIUS` was cranked down hard, **16 → 2.5**, after a live report of
a city-wide fire spread tanking framerate — even with the 1-2s flicker
throttle, dozens of simultaneously-near animated 3D flame groups (each with
its own `PointLight`, and dynamic lights are usually the dominant cost) was
still too much. At 2.5 a fire has to be almost point-blank before it
animates at all; everywhere else it's a static image, exactly matching a
direct "just make it a still image, animation isn't worth the framerate"
ask. If more headroom is ever needed, the next lever is capping simultaneous
*near* fires outright, not shrinking the radius further (it's already close
to as small as it can go while still doing anything).

## Radar / full map

A 2D canvas overlay (`#mapWrap`/`#mapCanvas` in `index.html`, always
640×640 internally regardless of on-screen size — CSS just scales it down
for the small corner radar), drawn top-down: canvas x = world x, canvas y =
world z. `drawMap()` runs every frame from the main loop, gated on
`isLocked`. Two modes, one draw function:
- **Radar** (default): fixed 160px circle top-left, fixed `MAP_RADAR_RADIUS`
  (55 world units) always centered on the player. No labels (too small to
  read), just colored dots.
- **Full map**: `M` toggles `mapOpen` (`toggleMap`), which CSS-transitions
  the same wrapper to a large centered 640px circle (`.big` class) and shows
  the `#mapHint` reminder. While open, the `wheel` listener (registered with
  `{ passive: false }` so it can `preventDefault` — otherwise the page would
  scroll) adjusts `mapZoom` between `MAP_ZOOM_MIN`/`MAP_ZOOM_MAX` (15-180
  world-unit radius), and labels are drawn next to each dot.
Both modes share the same `toXY(worldX, worldZ)` transform (centered on
`camera.position`, scaled by `radius`) and the same point-of-interest list:
building footprints (faint background rectangles, from
`buildingBoxes`/`megaBuildingBoxes`), the four `SPECIAL_ZONES` (market/park/
solar farm/salvage yard), the train station (`TRAIN_STATION_POS`, a
hardcoded midpoint of `buildTrain`'s span since there's no zone object for
it), the delivery truck once spawned, every powered-on inverter, every
energized switchboard, and any building currently mid-collapse
(`buildingFireState`, red dot) — i.e. everything currently relevant to what
the player might want to walk toward. The player is a white wedge at center,
rotated by `-yaw` to point in the camera's facing direction (canvas 2D
`rotate` is clockwise-positive; yaw's sign convention needed the negation to
match — verified live by placing the camera at a known offset from a known
POI and reading back the exact expected canvas pixel color/position).

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

## Delivery truck

Not milestone-driven — unlocked the moment the player successfully switches
**any** inverter on for the first time (`toggleInverterSwitch`'s success
branch, right after the "SOLAR ARRAY ONLINE" toast): `upgrades.deliveryUnlocked`
flips true and `spawnDeliveryTruck()` builds a parked truck near spawn
(`DELIVERY_TRUCK_POS`, currently `(4.5, 0, 16)`, on the clear road strip —
buildings are never generated on the `x≈0`/`z≈0` road columns, so this spot
doesn't need a collision-avoidance search). A `showMilestoneBanner` announces
it. Walking within 3.5m (`updateDeliveryTruck`, called every frame regardless
of weapon) tops panel ammo up to `DELIVERY_AMMO_CAP` (150) — well above the
normal magazine size (`effMagSize()`, 12 + upgrade bonuses, caps out around
30). This is a *separate, bigger* resupply on top of normal `R` reload, not a
replacement: `reload()` and the panel-pickup ammo trickle
(`pickUpNearestPanel`) both had to be changed from a plain `=== effMagSize()`
target to "don't reduce ammo below whatever it already is," specifically so
neither one claws a truck-topped 150 back down to the ~12-30 normal cap.

## Salvage Yard layout

Rebuilt (see `buildSalvageYard`) as a warehouse-and-hard-stand complex, not
just a fenced circle. Location/size still keyed off `SALVAGE_YARD` (`cx: 70,
cz: -110, r: 24` — `r` grew from 14 to fit the new layout; `SPECIAL_ZONES`'
building-exclusion radius derives from it automatically). Front-to-back
along Z: fenced paved **hard stand**, an **archway entrance** (two posts + a
lintel + a "SALVAGE YARD" sign) in a gap in the front fence rail, then the
**desk 1** counter (2 clerics via `buildPerson`, a sign board with 5 live
totals), then the **warehouse** (a plain decorative box + flat roof, *not*
wired into the fire/collapse system) with 3 **pallet racking** frames
(`buildRack`) holding small stored crates. `SALVAGE_YARD.deskX/deskZ/clericZ`
are stashed on the zone object once built so `buildShopCounter` (below) can
place the second desk relative to the first without recomputing the layout.

## Salvage economy

Unlocked at 2000 connected. **Six** separate scrap types, each tracked
independently (`carried*`/`given*` pairs — `Cable`, `Panel`, `Inverter`,
`Rock`, `Metal`, `Timber`):
- **Cable scrap** dropped when a cable is removed/destroyed (`destroyCable`
  with `withScrap`), one coil per segment.
- **Panel scrap** dropped when a panel is salvaged (Cable Router RMB with
  nothing aimed at) or destroyed live by the water gun.
- **Inverter scrap** dropped whenever an inverter is destroyed — extinguished
  after a fire, destroyed live by the water gun, or torn down along with its
  building in `collapseInstalledEquipment`. (This didn't exist before the
  weapon shop needed a 5th currency — those code paths previously dropped no
  scrap for the inverter itself, only for its wired cables.)
- **Rock**, **Metal**, and **Timber** scrap only come from a collapsed
  building's rubble pile — either the Demo Tool (weapon 8, +20 per rubble
  chunk broken up) or the baseline `E` interact (1 unit at a time, no tool
  needed) — there's no other source. `finishDemolition` seeds each pile with
  12 tagged chunks split evenly across all three types (see Collapse above).

`dropScrap(point, type)` gives each type a distinct mesh/material: cable =
coiled wire (torus), panel = a flat shard (box), inverter = a small dark
electronics chunk (box), rock = a grey lump (small dodecahedron), metal = a
bent beam (light grey/high-metalness box, `matMetalScrap`), timber = a
splintered beam (thin brown box, `matTimberScrap`).

Walking within ~1.6m of dropped scrap auto-picks it up into the matching
`carried*` variable (`updateSalvagePickups`) — and picking a rubble chunk up
with the Demo Tool or `E` credits the matching `carried*` variable directly
via a shared `creditScrap(type, n)` helper (see bug history: this was
missing a `'metal'` branch when metal was first added, silently crediting
metal pickups as cable). Walking close (~3m) to `salvageCleric.pos` (desk 1,
both clerics standing behind it) auto-donates everything carried at once:
converts to credits (10 each) and adds to the matching **given** total
(never decrease on their own — see Weapon shop for the one thing that *does*
spend them back down), shown on the 6-line sign board behind the desk
(`updateCleriSigns`). Reaching 1000 given cable + 500 given panel unlocks the
Water Gun. Reaching `SHOP_UNLOCK_TOTAL` (3000) combined across all six given
totals unlocks the Weapon shop (below). `credits` are tracked but not yet
spent on anything.

## Weapon shop (desk 2)

A second counter, lazily built by `buildShopCounter()` the first donation
that pushes the combined given-total past `SHOP_UNLOCK_TOTAL` — mirrors the
delivery truck's lazy-spawn pattern. Sits beside desk 1 (`SALVAGE_YARD.deskX
+ standHalfW * 0.55`), staffed by 2 more clerics. `SHOP_ITEMS` (Panel Repair
Tool, slot 6; Bulk Inverter Gun, slot 7) are on the counter from the moment
it's built. The **Demo Tool** (`DEMO_TOOL_ITEM`, slot 8) is *not* in
`SHOP_ITEMS` — it's added dynamically by `maybeAddDemoToolToShop()`, called
after every donation, once `DEMO_TOOL_SHOP_GATE` (100 given rock + 100 given
timber) is met; if the shop counter hasn't opened yet via
`SHOP_UNLOCK_TOTAL`, hitting this gate opens it early just to list the Demo
Tool. Every item (fixed or dynamic) is a small prop mesh with a floating
name+price tag (`addShopItemProp`, `costLine`).

Purchase flow is a global mousedown intercept, not a per-weapon action —
`findShopItemUnderCrosshair()` runs before the normal weapon-specific
branching in the `mousedown` listener, and only fires if the crosshair is
actually on a shop item mesh within 5m, so it can't steal a click meant for
whatever weapon is currently equipped. RMB → `selectShopItem` (stores
`selectedShopItem`, shows the cost in a toast). LMB with something selected
→ `purchaseSelectedShopItem`: checks all 5 given totals meet the item's cost,
subtracts them (spending the given pool, not the carried one), sets
`upgrades.weapon{N}Unlocked` (or, for slot 8 specifically,
`upgrades.demoToolUnlocked` + `upgrades.demoToolTier = 1` — the Demo Tool
doesn't follow the generic `weapon{N}Unlocked` naming since it also needs a
tier), and auto-equips the new weapon. Insufficient funds or an
already-owned item both just toast and leave state untouched.

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

- **(Avoided, not hit) TDZ trap building the plumbing view models**: the
  weapon view-model groups (`hpGunGroup` etc.) are built as top-level code
  that runs immediately at module load — not deferred inside a function like
  most gameplay logic is. A first draft referenced `matTapBody`, which is
  declared much later in the file inside the Plumbing job toolset section;
  since top-level `const` initializes in top-to-bottom execution order (no
  hoisting benefit the way function declarations get), that would have been
  a `ReferenceError` on every page load. Caught before testing by tracing
  where each material referenced from view-model code was actually
  declared; fixed by inlining a fresh `MeshStandardMaterial` instead of
  reaching for the later constant. Worth remembering any time new top-level
  (not function-body) code reuses a `const` — check it's declared *earlier*
  in the file, not just declared *somewhere*.
- **Duplicate `const matRoad` — whole game fails to load**: the loop-road
  code declared its own `const matRoad` without checking one already existed
  (line 132, used for the central cross roads). A duplicate top-level
  `const` in an ES module is a fatal `SyntaxError` in the browser — the
  entire script fails to execute, not just the new feature. `node --check`
  did **not** catch this (it doesn't do full module-scope duplicate-binding
  analysis the way a browser's module loader does), so it silently passed
  the usual pre-push check; only caught by actually loading the page and
  reading the console. Reinforces: `node --check` is a baseline sanity check
  in this project, not a substitute for a real browser load before pushing.
  Also separately: a **stale browser tab cache** briefly made a fresh page
  load in the same long-lived automation tab keep showing this same error
  even after the fix landed on disk and `curl` confirmed the server was
  serving the corrected file — a brand-new tab loaded the fix immediately.
  If a fix "isn't taking" during local verification, try a fresh tab before
  assuming the fix itself is wrong.
- **Metal scrap silently crediting as cable**: when the `'metal'` rubble type
  was added, `creditScrap(type, n)` — the shared helper the Demo Tool and `E`
  interact both call to award carried scrap — was never given a `'metal'`
  branch, so it fell through to the `else` (cable) case. Picking up a metal
  beam incremented `carriedCableScrap` instead of `carriedMetalScrap`.
  Caught live: picked up a tagged metal chunk and found `carried.cable` at 1
  with `carried.metal` still 0. Fixed by adding the missing branch.
- **Battery merges inflating installed kWh**: `removeBatteryFromWorld`
  (called on every battery consumed by a merge) removed the battery from the
  scene/array but never subtracted its capacity from
  `totalBatteryKwhInstalled`. Verified live: placing 5×2kWh batteries and
  letting them auto-merge left the total reading 15kWh instead of 5kWh (the
  10kWh from the 5 consumed originals never got subtracted, only the new
  5kWh unit's contribution added on top). Since every further merge repeats
  the inflation, this would have made `SWITCHBOARD_UNLOCK_KWH` trivially easy
  to hit regardless of what's actually still standing. Fixed by subtracting
  in `removeBatteryFromWorld`, mirroring how `totalWattsInstalled` is handled
  for panels.
- **Panel Repair Tool double-counting wattage**: the first pass had
  `firePanelRepair` add `p.watts` back into `totalWattsInstalled` on repair,
  on the assumption burning had deducted it. It hadn't — `burnPanel` only
  swaps the material, and `collectInverterNetwork` never checks `.burnt`, so
  a charred panel counts electrically the whole time. Repairing would have
  silently inflated the installed-watts total every time. Caught before
  push; repair is now purely cosmetic (see Weapons, #6).
- **Building-collapse equipment drop mislabeling inverter scrap as panel
  scrap**: `collapseInstalledEquipment`'s inverter branch called
  `dropScrap(inv.pos, 'panel')` (a copy-paste leftover from the panel branch
  right above it) — inverters destroyed by a building collapse were dropping
  the wrong scrap type. Fixed to `'inverter'` when the inverter-scrap type
  was added for the weapon shop.
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
- **Area-fill grid painting panels off the edge of a surface**: `computeAreaCells`
  projected the drag onto an *infinite* math-plane defined by the corner point
  + surface normal, and `isSpotFree` only checked distance from other panels —
  neither step confirmed a given grid cell actually landed on real wall/roof
  geometry, so a wide enough drag (or one aimed near an edge) could place
  panels floating past the surface's actual boundary, out over open air. This
  also made the preview look glitchy near edges, since cells with nothing
  underneath them still rendered. Fixed by adding `pointOnPlacementSurface`
  (a short raycast from just above each candidate cell straight back into the
  surface) and rejecting any cell that misses; both `computeAreaCells` and the
  newer `computeBlockCells` use it now.
- **Delivery truck ammo getting clawed back down**: `reload()`'s guard was
  `ammo === effMagSize()` and `pickUpNearestPanel`'s ammo trickle was
  `Math.min(effMagSize(), ammo + 1)` — both assumed ammo could never exceed
  the normal mag cap. Once the delivery truck could push ammo to 150 (well
  above `effMagSize()`'s ~12-30), pressing `R` or picking up a stray panel
  right after a truck visit would silently reset ammo back down to the
  normal cap. Fixed by changing the reload guard to `>=` (no-op once ammo is
  already at or above cap) and the pickup trickle to clamp against
  `Math.max(effMagSize(), ammo)` instead of `effMagSize()` alone.

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
