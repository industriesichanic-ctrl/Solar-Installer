import * as THREE from 'three';

// ---------- Map selection ----------
// Which map to build is decided ONCE, from a URL query param, before any world
// geometry runs — everything below that reads MAP_ID branches on it, but nothing
// tears down/rebuilds a running scene; switching maps is a full page reload
// (see the mapPanel click handler further down), which is simpler and far lower
// risk than trying to make one page own multiple live worlds.
const urlParams = new URLSearchParams(location.search);
const MAP_ID = Number(urlParams.get('map')) === 2 ? 2 : 1;
// Map 2's world sits at a huge offset from Map 1's (-140..140), rather than Map 1's
// city being conditionally skipped — Map 1's whole world-build is a large amount of
// existing, working top-level code that would be risky to wrap in a map check.
// Building it even in Map 2 mode costs some memory/CPU for a city the player will
// practically never walk to, which is a known simplification (see NOTES.md).
const MAP2_ORIGIN = { x: 3000, z: 0 };

// ============================================================================
// Solar Panel Gun — open-world prototype
// Half-Life/Crysis/Hurtworld-style movement (walk/sprint/crouch/jump) in a
// small open world of scattered buildings. The weapon raycasts forward and,
// on a valid upward-facing surface (rooftops, crate tops, ground), snaps a
// solar-panel mesh onto it. Placed panels are solid, so the player can use
// them to build makeshift steps/cover — a lightweight environment-manipulation
// loop layered on top of a standard FPS controller.
// ============================================================================

const EYE_HEIGHT_STAND = 1.75;
const EYE_HEIGHT_CROUCH = 1.05;
const PLAYER_RADIUS = 0.35;
const GRAVITY = 24;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 9.0;
const CROUCH_SPEED = 2.6;
const JUMP_SPEED = 7.6;
const CROUCH_LERP = 12;

const MAG_SIZE = 12;
const RELOAD_TIME = 1.4;
const FIRE_COOLDOWN = 0.18;
const MAX_PLACE_DIST = 40;
const PANEL_SIZE = 0.95;
const PANEL_SIZE_LARGE = 1.9;
const PANEL_WATTS_SMALL = 250;
const PANEL_WATTS_LARGE = 350;
const INVERTER_TIER_DIMS = [{ w: 0.55, h: 0.75 }, { w: 0.9, h: 1.2 }, { w: 1.45, h: 1.9 }, { w: 2.2, h: 2.8 }];
const INVERTER_STEP = 1.4; // wider than panel spacing, per spec
const INVERTER_THICK = 0.2;
const INVERTER_CAPACITY_KW = [3, 10, 20, 50]; // per tier: standard, big, bigger, biggest
const MAP2_INVERTER_CAPACITY_KW = [25, 50, 100, 250]; // Map 2's utility-scale inverters
function inverterCapacityKw(tier) {
  const table = MAP_ID === 2 ? MAP2_INVERTER_CAPACITY_KW : INVERTER_CAPACITY_KW;
  return table[Math.min(tier, table.length - 1)];
}
const PANEL_THICK = 0.06;
const MIN_PANEL_SPACING = PANEL_SIZE * 0.92;
const BATTERY_CAPACITY_KWH = [2, 5, 20, 50]; // per tier, mirrors INVERTER_CAPACITY_KW's non-linear scaling
const BATTERY_MERGE_COUNT = 5; // 5 same-tier batteries combine into 1 of the next tier
const BATTERY_STEP = 0.8;
const BATTERY_THICK = 0.25;
const BATTERY_DIMS = [{ w: 0.3, h: 0.5 }, { w: 0.45, h: 0.65 }, { w: 0.7, h: 0.95 }, { w: 1.0, h: 1.3 }];
const SWITCHBOARD_DIMS = { w: 0.5, h: 0.7 };
const SWITCHBOARD_THICK = 0.15;
const SWITCHBOARD_UNLOCK_KWH = 100; // total installed battery kWh needed before switchboards can be placed
const POWER_SYSTEMS_FOR_GUN0 = 20; // successful "SOLAR ARRAY ONLINE" events needed to unlock gun 0

function rand(a, b) { return a + Math.random() * (b - a); }

// ---------- Small billboarded text signs (inverter kW rating / production readout) ----------
function drawTextSpriteCanvas(canvas, text, opts) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = opts.bg || 'rgba(10,14,18,0.78)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = opts.border || '#ffd54a';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  ctx.fillStyle = opts.color || '#ffffff';
  ctx.font = `bold ${opts.fontSize || 56}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function makeTextSprite(text, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 96;
  drawTextSpriteCanvas(canvas, text, opts);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  const scale = opts.scale || 0.5;
  sprite.scale.set(scale * (canvas.width / canvas.height), scale, 1);
  return sprite;
}

function updateTextSprite(sprite, text, opts = {}) {
  drawTextSpriteCanvas(sprite.material.map.image, text, opts);
  sprite.material.map.needsUpdate = true;
}

// ---------- Progression: cable-connected-panel milestones ----------
// "Connected" = a panel that has ever been an endpoint of a finished cable run.
// The count only ever goes up (an achievement tally), even if the cable is later removed.
const upgrades = {
  sprintMul: 1, jumpMul: 1, heightMul: 1, magBonus: 0, reloadMul: 1, fireRateMul: 1,
  largePanelUnlocked: false, salvageUnlocked: false, buildingJumpUnlocked: false, goldStars: 0, waterGunUnlocked: false,
  powderUnlocked: false, blockPlacementUnlocked: false, deliveryUnlocked: false,
  shopUnlocked: false, demoToolUnlocked: false, demoToolTier: 0, weapon6Unlocked: false, weapon7Unlocked: false,
  gun0Unlocked: false, switchboardUnlocked: false,
};
function effStandHeight() { return EYE_HEIGHT_STAND * upgrades.heightMul; }
function effCrouchHeight() { return EYE_HEIGHT_CROUCH * upgrades.heightMul; }
function effMagSize() { return MAG_SIZE + upgrades.magBonus; }

// ---------- Renderer / Scene / Camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc7e8);
scene.fog = new THREE.FogExp2(0x8fc7e8, 0.011);

const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 400);
const SPAWN_POS = MAP_ID === 2 ? { x: MAP2_ORIGIN.x, z: MAP2_ORIGIN.z + 6 } : { x: 0, z: 6 };
camera.position.set(SPAWN_POS.x, effStandHeight(), SPAWN_POS.z);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Lighting ----------
scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x3a3226, 0.85));
const sun = new THREE.DirectionalLight(0xfff3d8, 1.4);
sun.position.set(60, 90, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
sun.shadow.camera.far = 280;
sun.shadow.bias = -0.0015;
scene.add(sun, sun.target);

// ---------- Materials ----------
const matGround   = new THREE.MeshStandardMaterial({ color: 0x5c6b4a, roughness: 0.95, metalness: 0.0 });
const matRoad      = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.9 });
const matBuilding  = [
  new THREE.MeshStandardMaterial({ color: 0xb3a68c, roughness: 0.85 }),
  new THREE.MeshStandardMaterial({ color: 0x9aa5ac, roughness: 0.8 }),
  new THREE.MeshStandardMaterial({ color: 0xc7b299, roughness: 0.85 }),
  new THREE.MeshStandardMaterial({ color: 0x8f9a86, roughness: 0.85 }),
];
const matRoof      = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.95 });
const matRoofHighlight = new THREE.MeshStandardMaterial({ color: 0x5a5648, roughness: 0.9, emissive: 0x111008, emissiveIntensity: 0.15 });
const matCrate     = new THREE.MeshStandardMaterial({ color: 0x8a6a3e, roughness: 0.9 });
const matPanel     = new THREE.MeshStandardMaterial({ color: 0x1a2c4a, roughness: 0.35, metalness: 0.55, emissive: 0x0a1830, emissiveIntensity: 0.4 });
const matPanelLarge = new THREE.MeshStandardMaterial({ color: 0x1a4a3a, roughness: 0.3, metalness: 0.6, emissive: 0x0a3022, emissiveIntensity: 0.45 });
const matPanelFrame = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.5, metalness: 0.3 });
const matGhostGood = new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.45 });
const matGhostBad  = new THREE.MeshBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.45 });
const matWood      = new THREE.MeshStandardMaterial({ color: 0x5a4530, roughness: 0.8, metalness: 0.05 });
const matLeaf      = new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 0.85, metalness: 0.02 });
const matWater     = new THREE.MeshStandardMaterial({ color: 0x2c5a72, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.85, emissive: 0x0d2a34, emissiveIntensity: 0.35 });
const matSilhouette = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.95, metalness: 0.0 });
const matPlaza     = new THREE.MeshStandardMaterial({ color: 0xa89a80, roughness: 0.7, metalness: 0.05 });
const matFountain  = new THREE.MeshStandardMaterial({ color: 0xc9c0ab, roughness: 0.4, metalness: 0.1 });
const matRail      = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.5, metalness: 0.7 });
const matTrain     = new THREE.MeshStandardMaterial({ color: 0x3a5a7a, roughness: 0.5, metalness: 0.3 });
const matTrainWindow = new THREE.MeshStandardMaterial({ color: 0x1a2830, roughness: 0.25, metalness: 0.5, emissive: 0x0b1a22, emissiveIntensity: 0.25 });
const matKite      = new THREE.MeshStandardMaterial({ color: 0xd8455c, roughness: 0.6, side: THREE.DoubleSide });
const matCableRed  = new THREE.MeshStandardMaterial({ color: 0x8a2020, roughness: 0.55, metalness: 0.1 });
const matCableBlack = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.55, metalness: 0.1 });
const matScrap     = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.7, metalness: 0.2 });
const matToolBody  = new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.4, metalness: 0.6 });
const matSpool     = new THREE.MeshStandardMaterial({ color: 0x7a2020, roughness: 0.6, metalness: 0.1 });
const matInverterBody = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.45, metalness: 0.65 });
const matInverterVent = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.6, metalness: 0.5 });
const matSpark     = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
const matFlexOrange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.55, metalness: 0.15 });

// ---------- Ground ----------
const GROUND_SIZE = 280;
let groundMesh;
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1), matGround);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.isSurface = true;
  scene.add(ground);
  groundMesh = ground;

  // simple cross-roads so the world reads as a district, not a void
  for (const rot of [0, Math.PI / 2]) {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, 7), matRoad);
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = rot;
    road.position.y = 0.01;
    scene.add(road);
  }
}

// ---------- Collision registries ----------
const groundColliders = [];      // raycast-down targets for ground-snap (ground, roofs, crates, panels)
const wallColliders = [];        // { minX, maxX, minZ, maxZ, minY, maxY } axis-aligned building/crate walls
const placementSurfaces = [];    // meshes the gun can paint panels onto (roofs, crate tops, ground)
const panels = [];               // { mesh, pos: Vector3 }

groundColliders.push(groundMesh);

function addWallBox(minX, maxX, minZ, maxZ, minY, maxY) {
  const box = { minX, maxX, minZ, maxZ, minY, maxY };
  wallColliders.push(box);
  return box;
}

// ---------- Special zones (market square, park+lake, solar farm, salvage yard) — kept clear of buildings/crates ----------
const SALVAGE_YARD = { cx: 70, cz: -110, r: 24 };
const salvageCleric = {}; // filled in when the yard is built: { group, pos, cableSign, panelSign }
const SPECIAL_ZONES = [
  { cx: 118, cz: 0, r: 26 },     // market square
  { cx: -118, cz: 0, r: 34 },    // park + lake
  { cx: 0, cz: 134, r: 70 },     // solar farm district (mega roofs)
  { cx: SALVAGE_YARD.cx, cz: SALVAGE_YARD.cz, r: SALVAGE_YARD.r + 6 },   // salvage yard
];
function inSpecialZone(x, z, pad = 8) {
  return SPECIAL_ZONES.some((zone) => Math.hypot(x - zone.cx, z - zone.cz) < zone.r + pad);
}

// ---------- Buildings ----------
const BUILDING_DEFS = [];
const STAIR_SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
{
  const gridSpacing = 22;
  const half = 4; // -4..4 -> 9x9 minus road-adjacent gaps
  let idx = 0;
  for (let gx = -half; gx <= half; gx++) {
    for (let gz = -half; gz <= half; gz++) {
      if (gx === 0 || gz === 0) continue; // keep roads clear
      if (Math.random() < 0.16) continue; // leave some open lots
      const cx = gx * gridSpacing + rand(-4, 4);
      const cz = gz * gridSpacing + rand(-4, 4);
      if (inSpecialZone(cx, cz)) continue;
      const isSkyscraper = Math.random() < 0.22;
      const w = isSkyscraper ? rand(9, 13) : rand(8, 14);
      const d = isSkyscraper ? rand(9, 13) : rand(8, 14);
      const h = isSkyscraper ? rand(38, 78) : rand(4, 22);
      const stairSide = Math.random() < 0.75 ? STAIR_SIDES[Math.floor(Math.random() * 4)] : null;
      BUILDING_DEFS.push({ id: idx++, cx, cz, w, d, h, isSkyscraper, stairSide, mat: matBuilding[idx % matBuilding.length] });
    }
  }
}

function buildBuilding(def) {
  const { cx, cz, w, d, h, mat, stairSide } = def;
  const minX = cx - w / 2, maxX = cx + w / 2;
  const minZ = cz - d / 2, maxZ = cz + d / 2;

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  body.position.set(cx, h / 2, cz);
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.isSurface = true;
  scene.add(body);
  placementSurfaces.push(body);
  const wallRef = addWallBox(minX, maxX, minZ, maxZ, 0, h);

  // simple window strips for visual read — also doubles as the building's "floors" for
  // the pancake-collapse demolition sequence (see beginBuildingCollapse/updateBuildingCollapse)
  const winMat = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.3, metalness: 0.4, emissive: 0x0b1a22, emissiveIntensity: 0.3 });
  const rows = Math.max(1, Math.floor(h / 3.2));
  const windowMeshes = [];
  for (let r = 0; r < rows; r++) {
    const wy = 1.8 + r * 3.2;
    if (wy > h - 1) break;
    const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.7, d * 0.96 + 0.02), winMat);
    band.position.set(cx, wy, cz);
    band.castShadow = true;
    band.receiveShadow = true;
    scene.add(band);
    windowMeshes.push(band);
  }

  // flat roof, slightly inset so its edges read visually, and a low parapet lip
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), matRoofHighlight);
  roof.position.set(cx, h + 0.2, cz);
  roof.castShadow = true;
  roof.receiveShadow = true;
  roof.userData.isSurface = true;
  scene.add(roof);
  groundColliders.push(roof);
  placementSurfaces.push(roof);

  // parapet lip around the roof edge — left open on the stair-access side so the
  // staircase actually leads onto the roof instead of dead-ending against a wall
  const parapetH = 0.5;
  const t = 0.25;
  const gapW = 2.6;
  const parapetMeshes = [];
  const mkParapet = (pw, pd, px, pz) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(pw, parapetH, pd), matRoof);
    p.position.set(px, h + parapetH / 2 + 0.4, pz);
    p.castShadow = true;
    scene.add(p);
    const wallBox = addWallBox(px - pw / 2, px + pw / 2, pz - pd / 2, pz + pd / 2, h + 0.4, h + parapetH + 0.4);
    parapetMeshes.push({ mesh: p, wallBox });
  };
  const mkParapetWithGap = (alongZAxis, fixedCoord, rangeMin, rangeMax) => {
    const gapCenter = (rangeMin + rangeMax) / 2;
    const gLo = gapCenter - gapW / 2, gHi = gapCenter + gapW / 2;
    const seg1 = gLo - rangeMin, seg2 = rangeMax - gHi;
    if (alongZAxis) {
      if (seg1 > 0.2) mkParapet(t, seg1, fixedCoord, rangeMin + seg1 / 2);
      if (seg2 > 0.2) mkParapet(t, seg2, fixedCoord, gHi + seg2 / 2);
    } else {
      if (seg1 > 0.2) mkParapet(seg1, t, rangeMin + seg1 / 2, fixedCoord);
      if (seg2 > 0.2) mkParapet(seg2, t, gHi + seg2 / 2, fixedCoord);
    }
  };
  if (stairSide === 'minZ') mkParapetWithGap(false, minZ - t / 2, minX, maxX); else mkParapet(w + t * 2, t, cx, minZ - t / 2);
  if (stairSide === 'maxZ') mkParapetWithGap(false, maxZ + t / 2, minX, maxX); else mkParapet(w + t * 2, t, cx, maxZ + t / 2);
  if (stairSide === 'minX') mkParapetWithGap(true, minX - t / 2, minZ, maxZ); else mkParapet(t, d, minX - t / 2, cz);
  if (stairSide === 'maxX') mkParapetWithGap(true, maxX + t / 2, minZ, maxZ); else mkParapet(t, d, maxX + t / 2, cz);

  return { minX, maxX, minZ, maxZ, topY: h, bodyMesh: body, wallRef, roofMesh: roof, windowMeshes, parapetMeshes };
}

const buildingBoxes = BUILDING_DEFS.map(buildBuilding);

// ---------- Fire-escape style exterior circulation so every floor (not just the roof)
// is reachable on foot: a balcony + door landing at each floor level (window-band
// height), alternating between a wide open "fire escape" flight and a narrower
// "internal stair" flight for visual variety (buildings are solid boxes with no
// modeled interior, so both flights are exterior-attached — the narrow ones just read
// as an enclosed stairwell rather than an open fire escape), and a vertical ladder
// for the final run from the top floor up to the roof. ----------
function buildFloorAccess(box, side) {
  const { minX, maxX, minZ, maxZ, topY } = box;
  const alongX = (side === 'minX' || side === 'maxX');
  const sign = (side === 'minX' || side === 'minZ') ? -1 : 1;
  const wallCoord = alongX ? (side === 'minX' ? minX : maxX) : (side === 'minZ' ? minZ : maxZ);
  const midOther = alongX ? (minZ + maxZ) / 2 : (minX + maxX) / 2;
  const wallGap = 0.5;
  const matDoor = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.3 });

  // one flight of stepped boxes climbing from yFrom to yTo, offset out from the wall
  function buildFlight(yFrom, yTo, flightWidth, mat) {
    const rise = yTo - yFrom;
    const steps = Math.max(3, Math.round(rise / 0.9));
    const stepH = rise / steps;
    const stepDepth = 0.85;
    for (let i = 0; i < steps; i++) {
      const distFromWall = wallGap + (steps - 1 - i) * stepDepth + stepDepth / 2;
      const y = yFrom + stepH * (i + 0.5);
      const coord = wallCoord + sign * distFromWall;
      const geo = alongX
        ? new THREE.BoxGeometry(stepDepth * 1.2, stepH, flightWidth)
        : new THREE.BoxGeometry(flightWidth, stepH, stepDepth * 1.2);
      const stepMesh = new THREE.Mesh(geo, mat);
      if (alongX) stepMesh.position.set(coord, y, midOther); else stepMesh.position.set(midOther, y, coord);
      stepMesh.castShadow = true;
      stepMesh.receiveShadow = true;
      stepMesh.userData.isSurface = true;
      scene.add(stepMesh);
      groundColliders.push(stepMesh);
    }
  }

  // a balcony landing (walkable deck + rail posts) plus a door prop on the wall behind it
  function buildLanding(y) {
    const deckW = 2.6, deckD = 1.3;
    const coord = wallCoord + sign * (wallGap + deckD / 2);
    const deck = new THREE.Mesh(
      alongX ? new THREE.BoxGeometry(deckD, 0.15, deckW) : new THREE.BoxGeometry(deckW, 0.15, deckD),
      matRail
    );
    if (alongX) deck.position.set(coord, y, midOther); else deck.position.set(midOther, y, coord);
    deck.castShadow = true;
    deck.receiveShadow = true;
    deck.userData.isSurface = true;
    scene.add(deck);
    groundColliders.push(deck);

    const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6);
    const outerCoord = wallCoord + sign * (wallGap + deckD);
    [-deckW / 2 + 0.2, 0, deckW / 2 - 0.2].forEach((o) => {
      const post = new THREE.Mesh(postGeo, matRail);
      if (alongX) post.position.set(outerCoord, y + 0.45, midOther + o); else post.position.set(midOther + o, y + 0.45, outerCoord);
      post.castShadow = true;
      scene.add(post);
    });

    const door = new THREE.Mesh(
      alongX ? new THREE.BoxGeometry(0.08, 1.9, 0.9) : new THREE.BoxGeometry(0.9, 1.9, 0.08),
      matDoor
    );
    const doorCoord = wallCoord + sign * 0.04;
    if (alongX) door.position.set(doorCoord, y + 0.95, midOther); else door.position.set(midOther, y + 0.95, doorCoord);
    scene.add(door);
  }

  const floorYs = [];
  const rows = Math.max(1, Math.floor(topY / 3.2));
  for (let r = 0; r < rows; r++) {
    const wy = 1.8 + r * 3.2;
    if (wy > topY - 1.2) break;
    floorYs.push(wy);
  }

  let y = 0;
  floorYs.forEach((nextY, i) => {
    const exterior = i % 2 === 0;
    buildFlight(y, nextY, exterior ? 2.4 : 1.6, exterior ? matRail : matCrate);
    buildLanding(nextY);
    y = nextY;
  });

  // final run: an external ladder from the top floor landing up to the roof — visually
  // rails + rungs, with small climbable step platforms behind them since the simple
  // box-collider ground-snap system has no dedicated ladder-climb mechanic
  const railGeo = new THREE.CylinderGeometry(0.035, 0.035, topY - y, 6);
  const railCoord = wallCoord + sign * (wallGap + 0.3);
  [-0.3, 0.3].forEach((o) => {
    const rail = new THREE.Mesh(railGeo, matRail);
    if (alongX) rail.position.set(railCoord, y + (topY - y) / 2, midOther + o); else rail.position.set(midOther + o, y + (topY - y) / 2, railCoord);
    scene.add(rail);
  });
  const rungCount = Math.max(4, Math.round((topY - y) / 0.35));
  for (let i = 0; i <= rungCount; i++) {
    const ry = y + (topY - y) * (i / rungCount);
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.66, 6), matRail);
    if (alongX) { rung.rotation.z = Math.PI / 2; rung.position.set(railCoord, ry, midOther); }
    else { rung.rotation.x = Math.PI / 2; rung.position.set(midOther, ry, railCoord); }
    scene.add(rung);
    const step = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), matCrate);
    if (alongX) step.position.set(railCoord, ry, midOther); else step.position.set(midOther, ry, railCoord);
    step.userData.isSurface = true;
    scene.add(step);
    groundColliders.push(step);
  }
}
BUILDING_DEFS.forEach((def, i) => { if (def.stairSide) buildFloorAccess(buildingBoxes[i], def.stairSide); });

// ---------- Scattered crates (cover + climbable + valid panel targets) ----------
const crateBoxes = [];
for (let i = 0; i < 50; i++) {
  const cx = rand(-GROUND_SIZE / 2 + 10, GROUND_SIZE / 2 - 10);
  const cz = rand(-GROUND_SIZE / 2 + 10, GROUND_SIZE / 2 - 10);
  if (inSpecialZone(cx, cz)) continue;
  // skip crates that would land inside a building footprint
  if (buildingBoxes.some(b => cx > b.minX - 1 && cx < b.maxX + 1 && cz > b.minZ - 1 && cz < b.maxZ + 1)) continue;
  const s = rand(1.0, 1.8);
  const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), matCrate);
  crate.position.set(cx, s / 2, cz);
  crate.castShadow = true;
  crate.receiveShadow = true;
  crate.userData.isSurface = true;
  scene.add(crate);
  groundColliders.push(crate);
  placementSurfaces.push(crate);
  const minX = cx - s / 2, maxX = cx + s / 2, minZ = cz - s / 2, maxZ = cz + s / 2;
  addWallBox(minX, maxX, minZ, maxZ, 0, s);
  crateBoxes.push({ minX, maxX, minZ, maxZ, topY: s });
}

// ground itself is a valid (if low-value) placement surface too
placementSurfaces.push(groundMesh);

// ---------- Static population — low-poly silhouettes, frozen in poses for now ----------
function buildPerson(x, z, rotY = 0, pose = 'stand') {
  const g = new THREE.Group();
  const bodyH = pose === 'sit' ? 0.85 : 1.55;
  const bodyY = pose === 'sit' ? bodyH / 2 + 0.45 : bodyH / 2;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, bodyH, 8), matSilhouette);
  body.position.y = bodyY;
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), matSilhouette);
  head.position.y = bodyY + bodyH / 2 + 0.16;
  head.castShadow = true;
  g.add(head);

  const armGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.55, 6);
  const armY = bodyY + bodyH * 0.22;
  if (pose === 'talk') {
    const a1 = new THREE.Mesh(armGeo, matSilhouette); a1.position.set(0.24, armY, 0.05); a1.rotation.z = -1.0; g.add(a1);
    const a2 = new THREE.Mesh(armGeo, matSilhouette); a2.position.set(-0.2, armY, 0); g.add(a2);
  } else if (pose === 'eat') {
    const a1 = new THREE.Mesh(armGeo, matSilhouette); a1.position.set(0.2, armY + 0.18, 0.08); a1.rotation.z = -1.4; g.add(a1);
    const a2 = new THREE.Mesh(armGeo, matSilhouette); a2.position.set(-0.2, armY, 0); g.add(a2);
    const snack = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), matSilhouette);
    snack.position.set(0.15, armY + 0.42, 0.2); g.add(snack);
  } else if (pose === 'kite') {
    const a1 = new THREE.Mesh(armGeo, matSilhouette); a1.position.set(0.2, armY + 0.25, 0); a1.rotation.z = -1.6; g.add(a1);
    const a2 = new THREE.Mesh(armGeo, matSilhouette); a2.position.set(-0.2, armY + 0.25, 0); a2.rotation.z = 1.6; g.add(a2);
  } else if (pose === 'install') {
    // bent-forward stance, both arms reaching out toward whatever's being worked on
    g.rotation.x = 0.25;
    const a1 = new THREE.Mesh(armGeo, matSilhouette); a1.position.set(0.16, armY + 0.1, 0.22); a1.rotation.x = -1.1; g.add(a1);
    const a2 = new THREE.Mesh(armGeo, matSilhouette); a2.position.set(-0.16, armY + 0.1, 0.22); a2.rotation.x = -1.1; g.add(a2);
  } else {
    const a1 = new THREE.Mesh(armGeo, matSilhouette); a1.position.set(0.22, armY, 0); g.add(a1);
    const a2 = new THREE.Mesh(armGeo, matSilhouette); a2.position.set(-0.22, armY, 0); g.add(a2);
  }

  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  scene.add(g);
  return g;
}

function buildKiteFlyer(x, z) {
  buildPerson(x, z, Math.random() * Math.PI * 2, 'kite');
  const kite = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 4), matKite);
  kite.rotation.z = Math.PI / 2;
  kite.rotation.y = Math.PI / 4;
  const kx = x + rand(2.5, 4), kz = z + rand(-2, 2), ky = rand(8, 12);
  kite.position.set(kx, ky, kz);
  kite.castShadow = true;
  scene.add(kite);
  const pts = [new THREE.Vector3(x, 1.6, z), new THREE.Vector3(kx, ky, kz)];
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  scene.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x1a1a1a })));
}

function buildBench(x, z, rotY) {
  const bench = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.45, 0.5), matWood);
  bench.position.set(x, 0.4, z);
  bench.rotation.y = rotY;
  bench.castShadow = true;
  bench.receiveShadow = true;
  scene.add(bench);
  groundColliders.push(bench);
}

function buildTree(x, z) {
  const scale = rand(0.8, 1.4);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * scale, 0.24 * scale, 2.2 * scale, 8), matWood);
  trunk.position.set(x, 1.1 * scale, z);
  trunk.castShadow = true;
  scene.add(trunk);
  const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.3 * scale, 2.6 * scale, 8), matLeaf);
  leaves.position.set(x, 2.6 * scale, z);
  leaves.castShadow = true;
  scene.add(leaves);
  const r = 0.2 * scale;
  addWallBox(x - r, x + r, z - r, z + r, 0, 2.2 * scale);
}

// ---------- Market square ----------
function buildMarketSquare(cx, cz, r) {
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(r, 40), matPlaza);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(cx, 0.02, cz);
  plaza.receiveShadow = true;
  plaza.userData.isSurface = true;
  scene.add(plaza);
  groundColliders.push(plaza);
  placementSurfaces.push(plaza);

  // central fountain — also a small climbable stage
  const fountainBase = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 0.5, 20), matFountain);
  fountainBase.position.set(cx, 0.27, cz);
  fountainBase.castShadow = true;
  fountainBase.receiveShadow = true;
  fountainBase.userData.isSurface = true;
  scene.add(fountainBase);
  groundColliders.push(fountainBase);
  placementSurfaces.push(fountainBase);
  const fountainWater = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.08, 20), matWater);
  fountainWater.position.set(cx, 0.56, cz);
  scene.add(fountainWater);

  // lamp posts ringing the plaza
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const lx = cx + Math.cos(a) * (r - 2), lz = cz + Math.sin(a) * (r - 2);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8), matRail);
    pole.position.set(lx, 1.6, lz);
    scene.add(pole);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffcf7a, emissiveIntensity: 1.2 }));
    bulb.position.set(lx, 3.25, lz);
    scene.add(bulb);
    scene.add(new THREE.PointLight(0xffcf8a, 3.5, 10, 2).translateX(lx).translateY(3.25).translateZ(lz));
  }

  // a few benches
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    buildBench(cx + Math.cos(a) * (r - 5), cz + Math.sin(a) * (r - 5), a + Math.PI / 2);
  }

  // scattered static crowd: standing, eating, sitting, plus a few chatting pairs
  const poses = ['talk', 'eat', 'stand', 'sit', 'stand', 'eat'];
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = rand(4, r - 3);
    buildPerson(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, Math.random() * Math.PI * 2, poses[i % poses.length]);
  }
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = rand(5, r - 4);
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
    buildPerson(px - 0.5, pz, a + Math.PI / 2, 'talk');
    buildPerson(px + 0.5, pz, a - Math.PI / 2, 'talk');
  }
}
buildMarketSquare(SPECIAL_ZONES[0].cx, SPECIAL_ZONES[0].cz, SPECIAL_ZONES[0].r);

// ---------- Wanderers — a handful of the static crowd upgraded to slowly circle a
// center point (fountain / lake shore) forever, so the market and park don't read as
// completely frozen. Everyone else stays static as before. ----------
const wanderers = [];
function buildWanderer(cx, cz, radius, speed, phase, pose) {
  const group = buildPerson(cx + Math.cos(phase) * radius, cz + Math.sin(phase) * radius, 0, pose);
  wanderers.push({ group, cx, cz, radius, speed, angle: phase });
}
function updateWanderers(dt) {
  wanderers.forEach((w) => {
    w.angle += w.speed * dt;
    const x = w.cx + Math.cos(w.angle) * w.radius;
    const z = w.cz + Math.sin(w.angle) * w.radius;
    w.group.position.set(x, 0, z);
    w.group.rotation.y = Math.atan2(-Math.cos(w.angle), -Math.sin(w.angle));
  });
}
{
  const { cx, cz, r } = SPECIAL_ZONES[0];
  for (let i = 0; i < 4; i++) {
    const radius = rand(6, r - 4);
    const speed = (rand(0.6, 1.1) / radius) * (i % 2 === 0 ? 1 : -1); // ~walking pace, alternating direction
    buildWanderer(cx, cz, radius, speed, rand(0, Math.PI * 2), 'stand');
  }
}

// ---------- Park + lake ----------
function buildParkLake(cx, cz, r) {
  const lakeR = r * 0.42;
  const lake = new THREE.Mesh(new THREE.CircleGeometry(lakeR, 40), matWater);
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(cx, 0.05, cz);
  lake.userData.isSurface = true;
  scene.add(lake);
  groundColliders.push(lake); // stylized shallow lake — walkable surface for now

  for (let i = 0; i < 45; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = rand(lakeR + 3, r);
    const tx = cx + Math.cos(a) * rr, tz = cz + Math.sin(a) * rr;
    buildTree(tx, tz);
  }

  buildKiteFlyer(cx + r * 0.32, cz - r * 0.32);
  const poses = ['stand', 'sit', 'eat', 'talk'];
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = rand(lakeR + 4, r * 0.85);
    buildPerson(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, Math.random() * Math.PI * 2, poses[i % poses.length]);
  }
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = rand(lakeR + 4, r * 0.8);
    buildBench(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, a);
  }
}
buildParkLake(SPECIAL_ZONES[1].cx, SPECIAL_ZONES[1].cz, SPECIAL_ZONES[1].r);
{
  const { cx, cz, r } = SPECIAL_ZONES[1];
  const lakeR = r * 0.42;
  for (let i = 0; i < 3; i++) {
    const radius = rand(lakeR + 4, r * 0.8);
    const speed = (rand(0.5, 0.9) / radius) * (i % 2 === 0 ? 1 : -1);
    buildWanderer(cx, cz, radius, speed, rand(0, Math.PI * 2), 'stand');
  }
}

// ---------- Train + station (static — no movement yet) ----------
function buildTrain(startX, endX, z) {
  const railZ1 = z - 0.8, railZ2 = z + 0.8;
  [railZ1, railZ2].forEach((rz) => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(endX - startX, 0.08, 0.12), matRail);
    rail.position.set((startX + endX) / 2, 0.04, rz);
    scene.add(rail);
  });
  for (let x = startX; x <= endX; x += 2) {
    const tie = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 2.0), matWood);
    tie.position.set(x, 0.03, z);
    scene.add(tie);
  }

  // platform
  const platform = new THREE.Mesh(new THREE.BoxGeometry(32, 0.6, 4.5), matFountain);
  platform.position.set(startX + 34, 0.3, z - 4.5);
  platform.castShadow = true;
  platform.receiveShadow = true;
  platform.userData.isSurface = true;
  scene.add(platform);
  groundColliders.push(platform);
  addWallBox(startX + 18, startX + 50, z - 6.75, z - 2.25, 0, 0.6);

  // canopy posts
  for (let i = 0; i < 4; i++) {
    const px = startX + 20 + i * 8;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.2, 8), matRail);
    post.position.set(px, 1.6 + 0.6, z - 4.5);
    scene.add(post);
  }
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(30, 0.2, 4.5), matTrain);
  canopy.position.set(startX + 34, 4.6, z - 4.5);
  canopy.castShadow = true;
  scene.add(canopy);

  // train cars — roofs are walkable, a fun climb spot
  const carCount = 4, carLen = 9;
  for (let i = 0; i < carCount; i++) {
    const carX = startX + 12 + i * (carLen + 0.3);
    const car = new THREE.Mesh(new THREE.BoxGeometry(carLen, 3.2, 3.0), matTrain);
    car.position.set(carX, 1.6 + 0.3, z);
    car.castShadow = true;
    car.receiveShadow = true;
    car.userData.isSurface = true;
    scene.add(car);
    groundColliders.push(car);
    placementSurfaces.push(car);
    addWallBox(carX - carLen / 2, carX + carLen / 2, z - 1.5, z + 1.5, 0.3, 3.5);

    const win = new THREE.Mesh(new THREE.BoxGeometry(carLen * 0.85, 0.8, 3.02), matTrainWindow);
    win.position.set(carX, 2.15, z);
    scene.add(win);
  }

  for (let i = 0; i < 5; i++) {
    buildPerson(startX + 34 + rand(-13, 13), z - 4.5 - 1.3, Math.random() * Math.PI * 2, i % 2 ? 'talk' : 'stand');
  }
}
buildTrain(-90, -20, -100);

// ---------- Parked vehicles (static — no movement yet) ----------
function buildCar(x, z, rotY, color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.35 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 1.9), mat);
  body.position.y = 0.65;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.7), mat);
  cabin.position.set(-0.2, 1.35, 0);
  g.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  [[1.3, 0.75], [1.3, -0.75], [-1.3, 0.75], [-1.3, -0.75]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.35, wz);
    g.add(wheel);
  });
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  scene.add(g);

  // axis-aligned collider approximation — cars are only ever placed at 0/90°
  const isAlongX = Math.abs(Math.cos(rotY)) > 0.5;
  if (isAlongX) addWallBox(x - 2.2, x + 2.2, z - 1.05, z + 1.05, 0, 1.75);
  else addWallBox(x - 1.05, x + 1.05, z - 2.2, z + 2.2, 0, 1.75);
}
const CAR_COLORS = [0x8a2c2c, 0x2c4a8a, 0x2c8a4a, 0xc9c0ab, 0x3a3a3e, 0x8a7a2c];
for (let i = 0; i < 6; i++) {
  const z = i % 2 === 0 ? rand(20, 100) : -rand(20, 100);
  buildCar(rand(-2.4, 2.4), z, Math.PI / 2, CAR_COLORS[i % CAR_COLORS.length]);
}
for (let i = 0; i < 6; i++) {
  const x = i % 2 === 0 ? rand(20, 95) : -rand(20, 95);
  buildCar(x, rand(-2.4, 2.4), 0, CAR_COLORS[(i + 3) % CAR_COLORS.length]);
}

// ---------- Perimeter loop road + slowly circling traffic. The building grid only
// ever occupies roughly -90..90, so a loop out at LOOP_R=115 clears every building
// with room to spare (ground extends to ±140) — cars on it never have to navigate
// around anything or hit a dead end, they just go around forever. ----------
const LOOP_R = 115;
const LOOP_CORNERS = [[LOOP_R, LOOP_R], [-LOOP_R, LOOP_R], [-LOOP_R, -LOOP_R], [LOOP_R, -LOOP_R]];
function buildLoopRoad() {
  const width = 6;
  for (let i = 0; i < 4; i++) {
    const a = LOOP_CORNERS[i], b = LOOP_CORNERS[(i + 1) % 4];
    const midX = (a[0] + b[0]) / 2, midZ = (a[1] + b[1]) / 2;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) + width; // small overlap so corners look joined
    const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
    const geo = alongX ? new THREE.BoxGeometry(length, 0.06, width) : new THREE.BoxGeometry(width, 0.06, length);
    const strip = new THREE.Mesh(geo, matRoad);
    strip.position.set(midX, 0.03, midZ);
    strip.receiveShadow = true;
    strip.userData.isSurface = true;
    scene.add(strip);
    groundColliders.push(strip);
  }
}
buildLoopRoad();

// distance-along-the-loop parameterization — dist wraps automatically, so a car just
// keeps adding to it forever with no branching/pathfinding needed
const LOOP_SIDE = 2 * LOOP_R;
const LOOP_PERIM = 4 * LOOP_SIDE;
function pointOnLoop(dist) {
  dist = ((dist % LOOP_PERIM) + LOOP_PERIM) % LOOP_PERIM;
  const side = Math.floor(dist / LOOP_SIDE);
  const t = (dist % LOOP_SIDE) / LOOP_SIDE;
  const a = LOOP_CORNERS[side], b = LOOP_CORNERS[(side + 1) % 4];
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: b[0] - a[0], dz: b[1] - a[1] };
}

function buildMovingCar(color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.35 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 1.9), mat);
  body.position.y = 0.65;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.7), mat);
  cabin.position.set(-0.2, 1.35, 0);
  g.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  [[1.3, 0.75], [1.3, -0.75], [-1.3, 0.75], [-1.3, -0.75]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.35, wz);
    g.add(wheel);
  });
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(g);
  return g;
}

const movingCars = [];
for (let i = 0; i < 7; i++) {
  const group = buildMovingCar(CAR_COLORS[i % CAR_COLORS.length]);
  movingCars.push({ group, dist: (LOOP_PERIM / 7) * i, speed: rand(4, 7) });
}
function updateMovingCars(dt) {
  movingCars.forEach((car) => {
    car.dist += car.speed * dt;
    const p = pointOnLoop(car.dist);
    car.group.position.set(p.x, 0, p.z);
    car.group.rotation.y = Math.atan2(-p.dz, p.dx);
  });
}

// ---------- Delivery truck (spawned once, the first time an inverter goes live —
// see toggleInverterSwitch) — parks near spawn and resupplies panel ammo up to
// DELIVERY_AMMO_CAP when the player walks up to it. Not built at world-load; only
// created the first time deliveryUnlocked flips true. ----------
const DELIVERY_AMMO_CAP = 150;
const DELIVERY_TRUCK_POS = new THREE.Vector3(4.5, 0, 16);
let deliveryTruck = null; // { group, pos, sign }

function buildDeliveryTruck(x, z, rotY) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.5, metalness: 0.3 });
  const cargoMat = new THREE.MeshStandardMaterial({ color: 0xffcf4a, roughness: 0.6, metalness: 0.1 });
  const g = new THREE.Group();
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.6, 2.1), mat);
  cab.position.set(2.6, 1.0, 0);
  const cargo = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.1, 2.2), cargoMat);
  cargo.position.set(-1.0, 1.25, 0);
  g.add(cab, cargo);
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  [[2.6, 1.15], [2.6, -1.15], [-1.6, 1.15], [-1.6, -1.15], [-2.9, 1.15], [-2.9, -1.15]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.42, wz);
    g.add(wheel);
  });
  const sign = makeTextSprite(`AMMO: ${ammo}/${DELIVERY_AMMO_CAP}`, { color: '#8aff9e', border: '#4dff88', fontSize: 40, scale: 0.55 });
  sign.position.set(-1.0, 3.1, 0);
  g.add(sign);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  scene.add(g);
  addWallBox(x - 3.4, x + 3.6, z - 1.2, z + 1.2, 0, 2.1);
  return { group: g, sign };
}

function spawnDeliveryTruck() {
  if (deliveryTruck) return;
  const { group, sign } = buildDeliveryTruck(DELIVERY_TRUCK_POS.x, DELIVERY_TRUCK_POS.z, Math.PI / 2);
  deliveryTruck = { group, pos: DELIVERY_TRUCK_POS.clone(), sign };
}

// walking within range tops panel ammo up to DELIVERY_AMMO_CAP — a bigger, one-stop
// resupply on top of the normal reload, which is still capped at effMagSize()
function updateDeliveryTruck() {
  if (!deliveryTruck) return;
  updateTextSprite(deliveryTruck.sign, `AMMO: ${ammo}/${DELIVERY_AMMO_CAP}`, { color: '#8aff9e', border: '#4dff88', fontSize: 40 });
  const dist = Math.hypot(camera.position.x - deliveryTruck.pos.x, camera.position.z - deliveryTruck.pos.z);
  if (dist < 3.5 && ammo < DELIVERY_AMMO_CAP) {
    ammo = DELIVERY_AMMO_CAP;
    reloading = false;
    showToast(`TRUCK RESUPPLY — AMMO TOPPED UP TO ${DELIVERY_AMMO_CAP}`);
  }
}

// ---------- Solar Farm District — a handful of huge flat-roofed warehouses at varying
// heights, purpose-built for massive panel arrays (roof area totals ~1800 sqm, room
// for 1000+ panels once you're deep into the connected-panel progression). ----------
const MEGA_BUILDING_DEFS = [
  { cx: -50, cz: 118, w: 16, d: 16, h: 6,  stairSide: 'minZ' },
  { cx: -16, cz: 118, w: 18, d: 18, h: 10, stairSide: 'minZ' },
  { cx: 18,  cz: 118, w: 20, d: 20, h: 14, stairSide: 'minZ' },
  { cx: 52,  cz: 118, w: 16, d: 16, h: 18, stairSide: 'minZ' },
  { cx: 0,   cz: 152, w: 24, d: 24, h: 22, stairSide: 'minZ' },
];
MEGA_BUILDING_DEFS.forEach((def, i) => { def.mat = matBuilding[i % matBuilding.length]; });
const megaBuildingBoxes = MEGA_BUILDING_DEFS.map((def) => {
  const box = buildBuilding(def);
  buildFloorAccess(box, def.stairSide);
  return box;
});

// ---------- Heat pump / aircon condenser units + static installer NPCs, scattered on
// building walls (ground level) and rooftops, purely decorative/frozen in pose ----------
const matHvac = new THREE.MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.5, metalness: 0.4 });
const matHvacGrille = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6, metalness: 0.3 });
function buildHvacUnit(x, y, z, facing) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.32), matHvac);
  body.position.y = 0.28;
  const grille = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 12), matHvacGrille);
  grille.rotation.x = Math.PI / 2;
  grille.position.set(0, 0.3, 0.17);
  group.add(body, grille);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.position.set(x, y, z);
  group.rotation.y = facing;
  scene.add(group);
  return group;
}

function scatterWallHvac(count, boxes) {
  const sides = ['minX', 'maxX', 'minZ', 'maxZ'];
  for (let i = 0; i < count; i++) {
    const b = boxes[Math.floor(Math.random() * boxes.length)];
    const side = sides[Math.floor(Math.random() * 4)];
    const alongX = side === 'minX' || side === 'maxX';
    const sign = (side === 'minX' || side === 'minZ') ? -1 : 1;
    const wallCoord = alongX ? (side === 'minX' ? b.minX : b.maxX) : (side === 'minZ' ? b.minZ : b.maxZ);
    const t = rand(0.2, 0.8);
    const otherCoord = alongX ? b.minZ + (b.maxZ - b.minZ) * t : b.minX + (b.maxX - b.minX) * t;
    const unitCoord = wallCoord + sign * 0.5;
    const npcCoord = wallCoord + sign * 1.3;
    const facing = alongX ? (sign > 0 ? Math.PI / 2 : -Math.PI / 2) : (sign > 0 ? 0 : Math.PI);
    const jitter = rand(-0.3, 0.3);
    if (alongX) {
      buildHvacUnit(unitCoord, 0.3, otherCoord, facing);
      buildPerson(npcCoord, otherCoord + jitter, facing + Math.PI, 'install');
    } else {
      buildHvacUnit(otherCoord, 0.3, unitCoord, facing);
      buildPerson(otherCoord + jitter, npcCoord, facing + Math.PI, 'install');
    }
  }
}
function scatterRoofHvac(count, boxes) {
  for (let i = 0; i < count; i++) {
    const b = boxes[Math.floor(Math.random() * boxes.length)];
    const x = b.minX + rand(0.2, 0.8) * (b.maxX - b.minX);
    const z = b.minZ + rand(0.2, 0.8) * (b.maxZ - b.minZ);
    const facing = rand(0, Math.PI * 2);
    buildHvacUnit(x, b.topY + 0.2, z, facing);
    buildPerson(x + rand(-1.1, 1.1), z + rand(-1.1, 1.1), rand(0, Math.PI * 2), 'install');
  }
}
scatterWallHvac(12, buildingBoxes);
scatterRoofHvac(8, buildingBoxes.concat(megaBuildingBoxes));

// ---------- Street lamps — one per stair-equipped building, near its floor-access base.
// Off by default; a nearby energized switchboard (see applyNearbyLighting) turns them on
// along with that building's window lights. ----------
const streetLamps = [];
function buildStreetLamp(x, z) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 8), matRail);
  pole.position.set(x, 1.6, z);
  pole.castShadow = true;
  scene.add(pole);
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0x000000, emissiveIntensity: 0 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), bulbMat);
  bulb.position.set(x, 3.25, z);
  scene.add(bulb);
  const light = new THREE.PointLight(0xffcf8a, 0, 10, 2);
  light.position.set(x, 3.25, z);
  scene.add(light);
  return { pole, bulb, light, pos: new THREE.Vector3(x, 0, z) };
}
function setStreetLampOn(lamp, on) {
  lamp.bulb.material.color.setHex(on ? 0xffe9b0 : 0x555555);
  lamp.bulb.material.emissive.setHex(on ? 0xffcf7a : 0x000000);
  lamp.bulb.material.emissiveIntensity = on ? 1.2 : 0;
  lamp.light.intensity = on ? 3.5 : 0;
}
BUILDING_DEFS.forEach((def, i) => {
  if (!def.stairSide) return;
  const b = buildingBoxes[i];
  const side = def.stairSide;
  const alongX = side === 'minX' || side === 'maxX';
  const sign = (side === 'minX' || side === 'minZ') ? -1 : 1;
  const wallCoord = alongX ? (side === 'minX' ? b.minX : b.maxX) : (side === 'minZ' ? b.minZ : b.maxZ);
  const midOther = alongX ? (b.minZ + b.maxZ) / 2 : (b.minX + b.maxX) / 2;
  const lampCoord = wallCoord + sign * 3.5;
  const lx = alongX ? lampCoord : midOther, lz = alongX ? midOther : lampCoord;
  streetLamps.push(buildStreetLamp(lx, lz));
});

// ---------- Salvage Yard (unlocked at the 2000-connected milestone) ----------
// A warehouse with pallet racking behind a fenced, paved hard stand, entered through
// an archway. A desk out front is staffed by two clerics who take donated scrap and
// track lifetime totals on a sign board. A second counter (built lazily by
// buildShopCounter, see below) appears once enough has been traded overall, selling
// weapon upgrades for combinations of the five scrap types.
function buildSalvageYard() {
  const { cx, cz, r } = SALVAGE_YARD;
  const standDepth = r * 1.5; // hard stand runs from the fence back to the warehouse
  const standHalfW = r * 0.9;
  const frontZ = cz + standDepth / 2; // fence/entrance side (nearer the road)
  const backZ = cz - standDepth / 2;  // warehouse side

  // paved hard stand
  const standFloor = new THREE.Mesh(new THREE.BoxGeometry(standHalfW * 2, 0.06, standDepth), matScrap);
  standFloor.position.set(cx, 0.02, cz);
  standFloor.receiveShadow = true;
  standFloor.userData.isSurface = true;
  scene.add(standFloor);
  groundColliders.push(standFloor);

  // perimeter fence with a gap in the front rail for the archway entrance
  const gapW = 4.5;
  const fencePosts = [];
  const addFenceRun = (x1, z1, x2, z2) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const count = Math.max(2, Math.round(len / 2.5));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const px = x1 + (x2 - x1) * t, pz = z1 + (z2 - z1) * t;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), matRail);
      post.position.set(px, 1.2, pz);
      scene.add(post);
      fencePosts.push(post);
    }
    if (Math.abs(x2 - x1) > Math.abs(z2 - z1)) addWallBox(Math.min(x1, x2), Math.max(x1, x2), z1 - 0.1, z1 + 0.1, 0, 1.9);
    else addWallBox(x1 - 0.1, x1 + 0.1, Math.min(z1, z2), Math.max(z1, z2), 0, 1.9);
  };
  addFenceRun(cx - standHalfW, frontZ, cx - gapW / 2, frontZ); // front-left, up to the gate gap
  addFenceRun(cx + gapW / 2, frontZ, cx + standHalfW, frontZ); // front-right
  addFenceRun(cx - standHalfW, frontZ, cx - standHalfW, backZ); // left side
  addFenceRun(cx + standHalfW, frontZ, cx + standHalfW, backZ); // right side

  // archway entrance straddling the front gap
  const archPostGeo = new THREE.CylinderGeometry(0.16, 0.18, 3.4, 8);
  const archMat = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.7, metalness: 0.2 });
  [cx - gapW / 2, cx + gapW / 2].forEach((px) => {
    const post = new THREE.Mesh(archPostGeo, archMat);
    post.position.set(px, 1.7, frontZ);
    post.castShadow = true;
    scene.add(post);
  });
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(gapW + 0.6, 0.35, 0.35), archMat);
  lintel.position.set(cx, 3.4, frontZ);
  lintel.castShadow = true;
  scene.add(lintel);
  const archSign = makeTextSprite('SALVAGE YARD', { color: '#ffd54a', border: '#ff9a4d', fontSize: 40, scale: 0.6 });
  archSign.position.set(cx, 4.1, frontZ);
  scene.add(archSign);

  // warehouse — big flat-roofed shed at the back of the yard, purely decorative
  // (not wired into the fire/collapse system; a simple storage backdrop)
  const whW = standHalfW * 1.9, whD = r * 0.9, whH = 8.5;
  const whCz = backZ - whD / 2 - 1;
  const matWarehouse = new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.75, metalness: 0.15 });
  const warehouse = new THREE.Mesh(new THREE.BoxGeometry(whW, whH, whD), matWarehouse);
  warehouse.position.set(cx, whH / 2, whCz);
  warehouse.castShadow = true;
  warehouse.receiveShadow = true;
  scene.add(warehouse);
  addWallBox(cx - whW / 2, cx + whW / 2, whCz - whD / 2, whCz + whD / 2, 0, whH);
  const whRoof = new THREE.Mesh(new THREE.BoxGeometry(whW + 0.6, 0.4, whD + 0.6), matRoofHighlight);
  whRoof.position.set(cx, whH + 0.2, whCz);
  whRoof.castShadow = true;
  scene.add(whRoof);
  const whDoor = new THREE.Mesh(new THREE.BoxGeometry(4.5, 5, 0.15), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.3 }));
  whDoor.position.set(cx, 2.5, whCz + whD / 2 + 0.02);
  scene.add(whDoor);

  // pallet racking inside/beside the warehouse — a couple of shelf frames with a
  // handful of stored crates and scrap piles on each level
  const rackMat = new THREE.MeshStandardMaterial({ color: 0xc9782c, roughness: 0.6, metalness: 0.4 });
  const buildRack = (rx, rz, rotY) => {
    const rack = new THREE.Group();
    const width = 3.4, depth = 0.8, postH = 3.2;
    [[-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2], [width / 2, depth / 2]].forEach(([px, pz]) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, postH, 0.09), rackMat);
      post.position.set(px, postH / 2, pz);
      rack.add(post);
    });
    [1.1, 2.2, postH - 0.15].forEach((shelfY) => {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, depth), rackMat);
      shelf.position.set(0, shelfY, 0);
      shelf.castShadow = true;
      shelf.receiveShadow = true;
      rack.add(shelf);
      groundColliders.push(shelf);
      // a couple of stored objects sitting on this level
      for (let i = 0; i < 2; i++) {
        const cs = rand(0.35, 0.6);
        const stored = new THREE.Mesh(new THREE.BoxGeometry(cs, cs, cs), matCrate);
        stored.position.set(rand(-width / 2 + 0.4, width / 2 - 0.4), shelfY + cs / 2 + 0.03, 0);
        stored.rotation.y = rand(0, Math.PI);
        stored.castShadow = true;
        rack.add(stored);
      }
    });
    rack.position.set(rx, 0, rz);
    rack.rotation.y = rotY;
    rack.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(rack);
  };
  buildRack(cx - standHalfW * 0.55, whCz, 0);
  buildRack(cx + standHalfW * 0.55, whCz, 0);
  buildRack(cx, whCz - whD / 2 + 1.2, Math.PI / 2);

  // desk 1 — the salvage counter, staffed by two clerics, backed by a sign board
  // tracking lifetime given totals for all five scrap types
  const deskZ = backZ + 4;
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.6, metalness: 0.3 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.9), deskMat);
  desk.position.set(cx - standHalfW * 0.4, 0.5, deskZ);
  desk.castShadow = true;
  desk.receiveShadow = true;
  scene.add(desk);
  groundColliders.push(desk);
  addWallBox(desk.position.x - 1.6, desk.position.x + 1.6, deskZ - 0.45, deskZ + 0.45, 0, 1.0);

  const clericZ = deskZ - 1.1;
  salvageCleric.clerics = [
    buildPerson(desk.position.x - 0.7, clericZ, Math.PI, 'stand'),
    buildPerson(desk.position.x + 0.7, clericZ, Math.PI, 'talk'),
  ];
  salvageCleric.pos = new THREE.Vector3(desk.position.x, 0, deskZ - 0.6); // donate by walking up to the desk

  const board = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 0.1), matWood);
  board.position.set(desk.position.x, 2.3, clericZ - 1.0);
  scene.add(board);
  const signDefs = [
    ['cableSign', 'cable', '#ffcf8a', '#ff9a4d'],
    ['panelSign', 'panel', '#8aff9e', '#4dff88'],
    ['inverterSign', 'inverter', '#9fd4ff', '#4ab0ff'],
    ['rockSign', 'rock', '#d8d8d8', '#9a9a9a'],
    ['metalSign', 'metal', '#c3c8cc', '#9aa0a6'],
    ['timberSign', 'timber', '#e0b078', '#a86a3a'],
  ];
  signDefs.forEach(([key, label, color, border], i) => {
    const sign = makeTextSprite(`0 ${label}`, { fontSize: 34, color, border, scale: 0.32 });
    sign.position.set(desk.position.x, 3.2 - i * 0.38, clericZ - 0.94);
    scene.add(sign);
    salvageCleric[key] = sign;
  });

  [[cx - standHalfW + 1.2, frontZ - 1.2], [cx + standHalfW - 1.2, frontZ - 1.2], [cx - standHalfW + 1.2, backZ + 1.2], [cx + standHalfW - 1.2, backZ + 1.2]].forEach(([bx, bz]) => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffcf8a, emissive: 0xff9a4d, emissiveIntensity: 1.3 }));
    bulb.position.set(bx, 3.6, bz);
    scene.add(bulb);
    const light = new THREE.PointLight(0xff9a4d, 4, 14, 2);
    light.position.copy(bulb.position);
    scene.add(light);
  });

  SALVAGE_YARD.deskX = desk.position.x;
  SALVAGE_YARD.deskZ = deskZ;
  SALVAGE_YARD.clericZ = clericZ;
  SALVAGE_YARD.standHalfW = standHalfW;
}
buildSalvageYard();

// ---------- Weapon shop (second counter) — appears once SHOP_UNLOCK_TOTAL salvage has
// been given overall (see updateSalvagePickups). Two more clerics staff a second desk;
// each weapon sits on the counter with a floating price tag. RMB while aiming at a gun
// selects it, LMB while selected attempts to buy it by spending given-scrap totals. ----------
const SHOP_ITEMS = [
  { slot: 6, name: 'Panel Repair Tool', cost: { cable: 30, panel: 30, inverter: 5, rock: 10, metal: 10, timber: 10 } },
  { slot: 7, name: 'Bulk Inverter Gun', cost: { cable: 50, panel: 20, inverter: 15, rock: 20, metal: 20, timber: 20 } },
];
// the Demo Tool only appears for sale once 100 rock + 100 timber have been given —
// it isn't in SHOP_ITEMS from the start, see maybeAddDemoToolToShop below
const DEMO_TOOL_ITEM = { slot: 8, name: 'Demo Tool', cost: { cable: 0, panel: 0, inverter: 0, rock: 200, metal: 0, timber: 200 } };
const DEMO_TOOL_SHOP_GATE = { rock: 100, timber: 100 }; // given totals needed before it's even listed
let selectedShopItem = null;
const shopItemMeshes = []; // { mesh, item }

function costLine(cost) {
  return `${cost.cable} cable / ${cost.panel} panel / ${cost.inverter} inv / ${cost.rock} rock / ${cost.metal} metal / ${cost.timber} timber`;
}

// adds one shop item's prop + price tag at counter slot index i; used both for the
// two fixed SHOP_ITEMS at build time and for the Demo Tool once it's unlocked later
function addShopItemProp(item, i, shopDeskX, deskZ) {
  const gx = shopDeskX - 0.8 + i * 1.6;
  const colorBySlot = { 6: 0x8aff9e, 7: 0x9fd4ff, 8: 0xd8a04a };
  const propMat = new THREE.MeshStandardMaterial({ color: colorBySlot[item.slot] || 0xcccccc, roughness: 0.4, metalness: 0.5 });
  const prop = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.7), propMat);
  prop.position.set(gx, 1.08, deskZ);
  prop.rotation.y = Math.PI / 2;
  prop.castShadow = true;
  scene.add(prop);
  prop.userData.shopItem = item;
  shopItemMeshes.push({ mesh: prop, item });

  const nameTag = makeTextSprite(item.name, { fontSize: 34, color: '#ffd54a', border: '#ff9a4d', scale: 0.4 });
  nameTag.position.set(gx, 1.85, deskZ);
  scene.add(nameTag);
  const costTag = makeTextSprite(costLine(item.cost), { fontSize: 24, color: '#e8e8e8', border: '#9a9a9a', scale: 0.4 });
  costTag.position.set(gx, 1.55, deskZ);
  scene.add(costTag);
  item.tag = nameTag;
}

function buildShopCounter() {
  if (shopItemMeshes.length) return; // already built
  const { deskX, deskZ, clericZ, standHalfW } = SALVAGE_YARD;
  const shopDeskX = deskX + standHalfW * 0.55;
  SALVAGE_YARD.shopDeskX = shopDeskX;
  SALVAGE_YARD.shopDeskZ = deskZ;

  const deskMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.6, metalness: 0.3 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 0.9), deskMat);
  desk.position.set(shopDeskX, 0.5, deskZ);
  desk.castShadow = true;
  desk.receiveShadow = true;
  scene.add(desk);
  groundColliders.push(desk);
  addWallBox(shopDeskX - 1.6, shopDeskX + 1.6, deskZ - 0.45, deskZ + 0.45, 0, 1.0);

  buildPerson(shopDeskX - 0.7, clericZ, Math.PI, 'stand');
  buildPerson(shopDeskX + 0.7, clericZ, Math.PI, 'talk');

  SHOP_ITEMS.forEach((item, i) => addShopItemProp(item, i, shopDeskX, deskZ));
}

// called after every donation — lists the Demo Tool for sale once the gate is met,
// building the shop counter early if it hasn't opened via SHOP_UNLOCK_TOTAL yet
function maybeAddDemoToolToShop() {
  if (shopItemMeshes.some((s) => s.item.slot === 8)) return; // already listed
  if (givenRockScrap < DEMO_TOOL_SHOP_GATE.rock || givenTimberScrap < DEMO_TOOL_SHOP_GATE.timber) return;
  if (!upgrades.shopUnlocked) { upgrades.shopUnlocked = true; buildShopCounter(); }
  addShopItemProp(DEMO_TOOL_ITEM, SHOP_ITEMS.length, SALVAGE_YARD.shopDeskX, SALVAGE_YARD.shopDeskZ);
  showMilestoneBanner('🔨', 'DEMO TOOL NOW FOR SALE AT THE SALVAGE YARD WEAPON SHOP');
}

function findShopItemUnderCrosshair() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(shopItemMeshes.map((s) => s.mesh), false);
  if (!hits.length || hits[0].distance > 5) return null;
  const found = shopItemMeshes.find((s) => s.mesh === hits[0].object);
  return found ? found.item : null;
}

function selectShopItem(item) {
  selectedShopItem = item;
  showToast(`SELECTED: ${item.name} — LMB TO BUY (${costLine(item.cost)})`);
}

function purchaseSelectedShopItem() {
  const item = selectedShopItem;
  if (!item) return;
  const unlockedKey = item.slot === 8 ? 'demoToolUnlocked' : `weapon${item.slot}Unlocked`;
  if (upgrades[unlockedKey]) { showToast('ALREADY OWNED'); return; }
  const c = item.cost;
  if (givenCableScrap < c.cable || givenPanelScrap < c.panel || givenInverterScrap < c.inverter ||
      givenRockScrap < c.rock || givenMetalScrap < c.metal || givenTimberScrap < c.timber) {
    showToast(`NOT ENOUGH SALVAGE GIVEN — NEED ${costLine(c)}`);
    return;
  }
  givenCableScrap -= c.cable;
  givenPanelScrap -= c.panel;
  givenInverterScrap -= c.inverter;
  givenRockScrap -= c.rock;
  givenMetalScrap -= c.metal;
  givenTimberScrap -= c.timber;
  if (item.slot === 8) { upgrades.demoToolUnlocked = true; upgrades.demoToolTier = 1; }
  else upgrades[unlockedKey] = true;
  updateCleriSigns();
  selectedShopItem = null;
  showMilestoneBanner('🔫', `${item.name.toUpperCase()} PURCHASED — PRESS ${item.slot}`);
  setWeapon(item.slot);
}

// Demo Tool tier-ups, checked after every donation alongside maybeAddDemoToolToShop
function maybeUpgradeDemoTool() {
  if (!upgrades.demoToolUnlocked) return;
  if (upgrades.demoToolTier === 1 && givenRockScrap >= 500 && givenTimberScrap >= 500) {
    upgrades.demoToolTier = 2;
    showMilestoneBanner('🔨', 'DEMO TOOL UPGRADED — RMB DRAG-COLLECTS RUBBLE (100/drag), LMB ALSO PICKS UP LOOSE SCRAP');
  }
  if (upgrades.demoToolTier === 2 && givenPanelScrap >= 100 && givenCableScrap >= 100 && givenInverterScrap >= 100) {
    upgrades.demoToolTier = 3;
    showMilestoneBanner('🔨', 'DEMO TOOL UPGRADED — RMB DRAG NOW COLLECTS ANY SALVAGE (100/drag)');
  }
}

// ---------- Cable-raycast target list — snapshot of every solid mesh built so far
// (buildings, roofs, crates, ground, market/park/train/vehicle props). The cable tool
// raycasts against this so it can anchor to walls, not just upward-facing surfaces. ----------
const worldMeshes = [];
scene.traverse((o) => { if (o.isMesh) worldMeshes.push(o); });

// ---------- View-model gun ----------
const gunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.42), new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.4, metalness: 0.6 }));
  body.position.set(0, 0, -0.15);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 10), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.35, metalness: 0.7 }));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, -0.42);
  const panelChip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.1), matPanel);
  panelChip.position.set(0, 0.09, -0.05);
  gunGroup.add(body, barrel, panelChip);
}
gunGroup.position.set(0.22, -0.2, -0.4);
camera.add(gunGroup);
scene.add(camera);

const muzzleFlash = new THREE.PointLight(0x8fd8ff, 0, 6, 2);
gunGroup.add(muzzleFlash);
let flashTimer = 0;

// ---------- Cable-gun view model ----------
const cableGunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), matToolBody);
  body.position.set(0, 0, -0.1);
  const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.1, 12), matSpool);
  spool.rotation.z = Math.PI / 2;
  spool.position.set(0, 0.02, 0.06);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.18, 8), matToolBody);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0, -0.32);
  cableGunGroup.add(body, spool, nozzle);
}
cableGunGroup.position.set(0.22, -0.2, -0.4);
cableGunGroup.visible = false;
camera.add(cableGunGroup);

// ---------- Cable-router view model (gun 3) ----------
const routerGunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.22), matToolBody);
  body.position.set(0, 0, -0.08);
  const jawMat = new THREE.MeshStandardMaterial({ color: 0xd8455c, roughness: 0.4, metalness: 0.5 });
  const jaw1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.2), jawMat);
  jaw1.position.set(0.03, 0, -0.28);
  jaw1.rotation.y = 0.18;
  const jaw2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.2), jawMat);
  jaw2.position.set(-0.03, 0, -0.28);
  jaw2.rotation.y = -0.18;
  routerGunGroup.add(body, jaw1, jaw2);
}
routerGunGroup.position.set(0.22, -0.2, -0.4);
routerGunGroup.visible = false;
camera.add(routerGunGroup);

// ---------- Inverter-gun view model (gun 4) ----------
const inverterGunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.1, 0.26), matToolBody);
  body.position.set(0, 0, -0.09);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.1), matInverterBody);
  box.position.set(0, 0.06, -0.05);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.16, 8), matToolBody);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -0.28);
  inverterGunGroup.add(body, box, muzzle);
}
inverterGunGroup.position.set(0.22, -0.2, -0.4);
inverterGunGroup.visible = false;
camera.add(inverterGunGroup);

// ---------- Water-gun view model (gun 5) ----------
const matWaterTool = new THREE.MeshStandardMaterial({ color: 0x2a4a5a, roughness: 0.4, metalness: 0.5 });
const waterGunGroup = new THREE.Group();
{
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.22, 10), matWaterTool);
  tank.position.set(0, 0.02, -0.02);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.2, 8), matToolBody);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0, -0.3);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.06), matToolBody);
  handle.position.set(0, -0.1, 0.03);
  waterGunGroup.add(tank, nozzle, handle);
}
waterGunGroup.position.set(0.22, -0.2, -0.4);
waterGunGroup.visible = false;
camera.add(waterGunGroup);

const matWaterStream = new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.55 });
const waterStreamMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1, 8), matWaterStream);
waterStreamMesh.visible = false;
scene.add(waterStreamMesh);

// ---------- Panel Repair Tool view model (gun 6, shop purchase) ----------
const repairGunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.28), matToolBody);
  body.position.set(0, 0, -0.1);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0x8aff9e, emissive: 0x2a7a3e, emissiveIntensity: 0.8 }));
  tip.rotation.x = -Math.PI / 2;
  tip.position.set(0, 0, -0.32);
  repairGunGroup.add(body, tip);
}
repairGunGroup.position.set(0.22, -0.2, -0.4);
repairGunGroup.visible = false;
camera.add(repairGunGroup);

// ---------- Bulk Inverter Gun view model (gun 7, shop purchase) ----------
const bulkInverterGunGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.3), matToolBody);
  body.position.set(0, 0, -0.1);
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.2, 0.13), matInverterBody);
  box.position.set(0, 0.07, -0.05);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.18, 8), matToolBody);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -0.3);
  bulkInverterGunGroup.add(body, box, muzzle);
}
bulkInverterGunGroup.position.set(0.22, -0.2, -0.4);
bulkInverterGunGroup.visible = false;
camera.add(bulkInverterGunGroup);

// ---------- Demo Tool view model (gun 8, auto-unlocked on first building collapse) ----------
const demoToolGroup = new THREE.Group();
{
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.3, 8), matWood);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(0, -0.02, -0.1);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.09), new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.5, metalness: 0.6 }));
  head.position.set(0, -0.02, -0.28);
  demoToolGroup.add(handle, head);
}
demoToolGroup.position.set(0.22, -0.2, -0.4);
demoToolGroup.visible = false;
camera.add(demoToolGroup);

// ---------- Gun 0 view model (batteries + switchboards) ----------
const gun0Group = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.3), matToolBody);
  body.position.set(0, 0, -0.1);
  const cell = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.1), new THREE.MeshStandardMaterial({ color: 0x2f6a3a, roughness: 0.5, metalness: 0.3 }));
  cell.position.set(0, 0.06, -0.05);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.16, 8), matToolBody);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 0, -0.28);
  gun0Group.add(body, cell, muzzle);
}
gun0Group.position.set(0.22, -0.2, -0.4);
gun0Group.visible = false;
camera.add(gun0Group);

// ---------- Placement ghost preview ----------
const ghostGeo = new THREE.BoxGeometry(PANEL_SIZE, PANEL_THICK, PANEL_SIZE);
const ghostGeoLarge = new THREE.BoxGeometry(PANEL_SIZE_LARGE, PANEL_THICK, PANEL_SIZE_LARGE);
const ghostMesh = new THREE.Mesh(ghostGeo, matGhostGood);
ghostMesh.visible = false;
scene.add(ghostMesh);
let selectedPanelSize = 'small'; // toggled with X once the 1500-panel milestone unlocks the large panel
function currentPanelSize() { return (selectedPanelSize === 'large' && upgrades.largePanelUnlocked) ? PANEL_SIZE_LARGE : PANEL_SIZE; }

const ghostInverterGeo = new THREE.BoxGeometry(INVERTER_TIER_DIMS[0].w, INVERTER_THICK, INVERTER_TIER_DIMS[0].h);
const ghostInverterMesh = new THREE.Mesh(ghostInverterGeo, matGhostGood);
ghostInverterMesh.visible = false;
scene.add(ghostInverterMesh);

// area-fill drag preview — a pool of instances reused every frame while dragging
const MAX_AREA_CELLS = 400;
const AREA_SPAN_CAP = 14; // max grid cells out from the corner in either direction
const ghostAreaMesh = new THREE.InstancedMesh(ghostGeo, matGhostGood, MAX_AREA_CELLS);
ghostAreaMesh.visible = false;
ghostAreaMesh.count = 0;
scene.add(ghostAreaMesh);

// ---------- Input ----------
const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');
const hud = document.getElementById('hud');
const mapWrap = document.getElementById('mapWrap');
const mapCanvas = document.getElementById('mapCanvas');
const mapCtx = mapCanvas.getContext('2d');
const mapHint = document.getElementById('mapHint');
const panelCountEl = document.getElementById('panelCount');
const streakToastEl = document.getElementById('streakToast');
const milestoneBannerEl = document.getElementById('milestoneBanner');
const milestoneBannerStarsEl = milestoneBannerEl.querySelector('.stars');
const milestoneBannerTitleEl = milestoneBannerEl.querySelector('.title');
let isLocked = false;
let currentWeapon = 1; // 1 = solar panel gun, 2 = cable gun

function setWeapon(w) {
  if (w === currentWeapon) return;
  currentWeapon = w;
  gunGroup.visible = w === 1;
  cableGunGroup.visible = w === 2;
  routerGunGroup.visible = w === 3;
  inverterGunGroup.visible = w === 4;
  waterGunGroup.visible = w === 5;
  repairGunGroup.visible = w === 6;
  bulkInverterGunGroup.visible = w === 7;
  demoToolGroup.visible = w === 8;
  gun0Group.visible = w === 0;
  mouseDown = false;
  if (w === 2) cancelCable();
  if (routerGrab) { if (routerGrab.previewLine) scene.remove(routerGrab.previewLine); routerGrab = null; }
  ghostMesh.visible = false;
  ghostInverterMesh.visible = false;
  waterStreamMesh.visible = false;
}

overlay.addEventListener('click', () => {
  const req = renderer.domElement.requestPointerLock();
  if (req && typeof req.catch === 'function') req.catch(() => {});
});
document.addEventListener('pointerlockchange', () => {
  isLocked = document.pointerLockElement === renderer.domElement;
  overlay.style.display = isLocked ? 'none' : 'flex';
  crosshair.style.display = isLocked ? 'block' : 'none';
  hud.style.display = isLocked ? 'block' : 'none';
  panelCountEl.style.display = isLocked ? 'block' : 'none';
  mapPanel.style.display = isLocked ? 'none' : 'flex';
});

// ---------- Map picker (start screen only) ----------
const mapPanel = document.getElementById('mapPanel');
mapPanel.querySelectorAll('.mapOption').forEach((el) => {
  const id = Number(el.dataset.map);
  if (id === MAP_ID) el.classList.add('active');
  if (el.classList.contains('locked')) return;
  el.addEventListener('click', (e) => {
    e.stopPropagation(); // don't let the click fall through to overlay's pointer-lock request
    if (id === MAP_ID) return;
    location.href = id === 1 ? location.pathname : `${location.pathname}?map=${id}`;
  });
});

let yaw = 0, pitch = 0;
const LOOK_SENS = 0.0022;
document.addEventListener('mousemove', (e) => {
  if (!isLocked) return;
  yaw -= e.movementX * LOOK_SENS;
  pitch -= e.movementY * LOOK_SENS;
  pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch));
});

const keys = new Set();
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') reload();
  if (e.code === 'Digit1') setWeapon(1);
  if (e.code === 'Digit2') setWeapon(2);
  if (e.code === 'Digit3') setWeapon(3);
  if (e.code === 'Digit4') setWeapon(4);
  if (e.code === 'Digit5') {
    if (upgrades.waterGunUnlocked) setWeapon(5);
    else showToast(`WATER GUN LOCKED — GIVE ${SCRAP_UNLOCK_CABLE} CABLE + ${SCRAP_UNLOCK_PANEL} PANEL SCRAP TO THE SALVAGE CLERIC`);
  }
  if (e.code === 'Digit6') {
    if (upgrades.weapon6Unlocked) setWeapon(6);
    else showToast('PANEL REPAIR TOOL LOCKED — BUY IT AT THE SALVAGE YARD WEAPON SHOP');
  }
  if (e.code === 'Digit7') {
    if (upgrades.weapon7Unlocked) setWeapon(7);
    else showToast('BULK INVERTER GUN LOCKED — BUY IT AT THE SALVAGE YARD WEAPON SHOP');
  }
  if (e.code === 'Digit8') {
    if (upgrades.demoToolUnlocked) setWeapon(8);
    else showToast('DEMO TOOL LOCKED — BUY IT AT THE SALVAGE YARD WEAPON SHOP (100 GIVEN ROCK + TIMBER TO UNLOCK IT FOR SALE)');
  }
  if (e.code === 'Digit0') {
    if (upgrades.gun0Unlocked) setWeapon(0);
    else showToast(`GUN 0 LOCKED — ${totalPowerSystemsActivated}/${POWER_SYSTEMS_FOR_GUN0} POWER SYSTEMS ACTIVATED`);
  }
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'KeyX' && upgrades.largePanelUnlocked && currentWeapon === 1) {
    selectedPanelSize = selectedPanelSize === 'small' ? 'large' : 'small';
    showToast(selectedPanelSize === 'large' ? 'LARGE PANEL SELECTED' : 'STANDARD PANEL SELECTED');
  }
  if (e.code === 'KeyB' && upgrades.blockPlacementUnlocked && currentWeapon === 1) {
    blockPlaceMode = !blockPlaceMode;
    showToast(blockPlaceMode ? `BLOCK MODE: LMB PLACES ${BLOCK_PLACE_SIZE * BLOCK_PLACE_SIZE} PANELS` : 'SINGLE PANEL MODE');
  }
  if (e.code === 'KeyE') handleInteractKey();
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

let mouseDown = false;
let rmbDown = false; // tracked globally so the water gun can check "is RMB also held" for powder mode
document.addEventListener('mousedown', (e) => {
  if (!isLocked) return;
  if (e.button === 2) rmbDown = true;

  // shop counter intercept — works regardless of currently-equipped weapon, but only
  // when actually aiming at a shop item mesh, so it never steals a click meant for
  // the current weapon's own RMB/LMB action
  if (upgrades.shopUnlocked) {
    const shopHit = findShopItemUnderCrosshair();
    if (shopHit) {
      if (e.button === 2) { selectShopItem(shopHit); return; }
      if (e.button === 0 && selectedShopItem) { purchaseSelectedShopItem(); return; }
    }
  }

  if (currentWeapon === 1) {
    if (e.button === 0) mouseDown = true;
    // Map 2's weapon 1 is the tree cutter (see fire()) — no RMB action, and
    // critically no pickUpNearestPanel, which would otherwise let the player
    // "salvage" the fixed 1MW array anchors right back out of the world
    if (e.button === 2 && MAP_ID !== 2) {
      if (unlockedAreaTool) beginAreaDragCandidate();
      else pickUpNearestPanel();
    }
  } else if (currentWeapon === 2) {
    if (e.button === 0) cableClick();
    if (e.button === 2) cableRightClick();
  } else if (currentWeapon === 3) {
    if (e.button === 0) routerLeftDown();
    if (e.button === 2) routerRightClick();
  } else if (currentWeapon === 4) {
    if (e.button === 0) fireInverter();
    if (e.button === 2) handleInverterRightClick();
  } else if (currentWeapon === 5) {
    if (e.button === 0) mouseDown = true; // hold to spray
  } else if (currentWeapon === 6) {
    if (e.button === 0) firePanelRepair();
  } else if (currentWeapon === 7) {
    if (e.button === 0) fireBulkInverter();
  } else if (currentWeapon === 8) {
    if (e.button === 0) fireDemoTool();
    if (e.button === 2 && upgrades.demoToolTier >= 2) demoDrag = { collected: 0, tick: 0 };
  } else if (currentWeapon === 0) {
    if (e.button === 0) fireBattery();
    if (e.button === 2) fireSwitchboard();
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    mouseDown = false;
    if (currentWeapon === 3) routerLeftUp();
  }
  if (e.button === 2) {
    rmbDown = false;
    if (currentWeapon === 1 && unlockedAreaTool) endAreaDrag();
    if (currentWeapon === 8 && demoDrag) { showToast(`DRAG COLLECTED ${demoDrag.collected} UNITS`); demoDrag = null; }
  }
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Radar / full map (M to toggle, scroll to zoom while open) ----------
let mapOpen = false;
let mapZoom = 60; // world-unit radius visible from center to edge
const MAP_ZOOM_MIN = 15, MAP_ZOOM_MAX = 180;
const MAP_RADAR_RADIUS = 55; // fixed radius for the small always-on corner radar
const TRAIN_STATION_POS = { cx: -55, cz: -100 }; // midpoint of buildTrain(-90, -20, -100)

function toggleMap() {
  mapOpen = !mapOpen;
  mapWrap.classList.toggle('big', mapOpen);
  mapHint.style.display = mapOpen ? 'block' : 'none';
}
document.addEventListener('wheel', (e) => {
  if (!mapOpen) return;
  e.preventDefault();
  mapZoom = Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, mapZoom + e.deltaY * 0.12));
}, { passive: false });

function drawMap() {
  if (!isLocked) { mapWrap.style.display = 'none'; return; }
  mapWrap.style.display = 'block';
  const size = mapCanvas.width;
  const half = size / 2;
  const radius = mapOpen ? mapZoom : MAP_RADAR_RADIUS;
  const scale = half / radius;
  const px = camera.position.x, pz = camera.position.z;
  const toXY = (wx, wz) => [half + (wx - px) * scale, half + (wz - pz) * scale];

  mapCtx.clearRect(0, 0, size, size);
  mapCtx.fillStyle = '#0b1218';
  mapCtx.fillRect(0, 0, size, size);

  // building footprints, faint, for spatial context
  mapCtx.fillStyle = 'rgba(120,140,160,0.28)';
  buildingBoxes.concat(megaBuildingBoxes).forEach((b) => {
    const [x1, y1] = toXY(b.minX, b.minZ);
    const [x2, y2] = toXY(b.maxX, b.maxZ);
    if (x2 < 0 || x1 > size || y2 < 0 || y1 > size) return;
    mapCtx.fillRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
  });

  const drawDot = (wx, wz, color, r, label) => {
    const [x, y] = toXY(wx, wz);
    if (x < -20 || x > size + 20 || y < -20 || y > size + 20) return;
    mapCtx.beginPath();
    mapCtx.arc(x, y, r, 0, Math.PI * 2);
    mapCtx.fillStyle = color;
    mapCtx.fill();
    if (label && mapOpen) {
      mapCtx.fillStyle = '#e8f4ff';
      mapCtx.font = '11px Segoe UI, Arial';
      mapCtx.fillText(label, x + r + 3, y + 3);
    }
  };

  // static points of interest
  drawDot(SPECIAL_ZONES[0].cx, SPECIAL_ZONES[0].cz, '#ffcf4a', 5, 'Market');
  drawDot(SPECIAL_ZONES[1].cx, SPECIAL_ZONES[1].cz, '#4dff88', 5, 'Park');
  drawDot(SPECIAL_ZONES[2].cx, SPECIAL_ZONES[2].cz, '#ffd54a', 5, 'Solar Farm');
  drawDot(SALVAGE_YARD.cx, SALVAGE_YARD.cz, '#c9782c', 5, 'Salvage Yard');
  drawDot(TRAIN_STATION_POS.cx, TRAIN_STATION_POS.cz, '#7fd4ff', 5, 'Station');
  if (deliveryTruck) drawDot(deliveryTruck.pos.x, deliveryTruck.pos.z, '#9fe8ff', 4, 'Truck');

  // dynamic points of interest — anything currently relevant to interact with
  inverters.forEach((inv) => { if (inv.poweredOn) drawDot(inv.pos.x, inv.pos.z, '#4dff88', 3); });
  switchboards.forEach((s) => { if (s.energized) drawDot(s.pos.x, s.pos.z, '#ffe066', 3); });
  buildingFireState.forEach((st, b) => {
    if (st.demolishing && !st.rubbleSpawned) drawDot((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, '#ff5a3c', 5, mapOpen ? 'Fire' : undefined);
  });

  // player marker + facing wedge (canvas y = world z; yaw=0 faces -Z, i.e. "up" here)
  mapCtx.save();
  mapCtx.translate(half, half);
  mapCtx.rotate(-yaw);
  mapCtx.beginPath();
  mapCtx.moveTo(0, -8);
  mapCtx.lineTo(5, 6);
  mapCtx.lineTo(-5, 6);
  mapCtx.closePath();
  mapCtx.fillStyle = '#ffffff';
  mapCtx.fill();
  mapCtx.restore();

  if (mapOpen) {
    mapCtx.fillStyle = 'rgba(200,220,255,0.7)';
    mapCtx.font = 'bold 13px Segoe UI, Arial';
    mapCtx.fillText('N', half - 5, 16);
  }
}

// ---------- Ammo state ----------
let ammo = MAG_SIZE;
let reloading = false;
let reloadT = 0;
let fireCooldown = 0;
let totalPanelsPlaced = 0;
let totalWattsInstalled = 0; // sum of every currently-laid panel's nameplate wattage
const AREA_TOOL_UNLOCK_COUNT = 100;
let unlockedAreaTool = false;
const BLOCK_PLACE_UNLOCK_COUNT = 1000;
const BLOCK_PLACE_SIZE = 5; // 5x5 = 25 panels per LMB shot in block mode
let blockPlaceMode = false; // toggled with B once unlocked; RMB drag-fill still works independently

// ---------- Inverters (gun 4) ----------
const inverters = []; // { mesh, pos, normal, tier, groupId, wiredCables: Set<cableObj>, poweredOn, indicatorMat }
const inverterGroups = new Map(); // groupId -> Set<inverterObj>, same-tier adjacency clusters awaiting a 3-way merge
let nextInverterGroupId = 1;
let totalInvertersPlaced = 0;
let totalPowerSystemsActivated = 0; // counts every successful "SOLAR ARRAY ONLINE" event, cumulative
let inverterFireCooldown = 0;
let totalKwhProduced = 0; // ticks up as any healthy, powered-on inverter produces

function updateInverterProduction(dt) {
  for (const inv of inverters) {
    if (!inv.poweredOn) continue;
    inv.productionTick += dt;
    while (inv.productionTick >= 5) {
      inv.productionTick -= 5;
      inv.kwhProduced += 1;
      totalKwhProduced += 1;
      if (inv.productionSign) updateTextSprite(inv.productionSign, `${inv.kwhProduced} kWh`, { color: '#8aff9e', border: '#4dff88', fontSize: 44 });
    }
  }
}

function reload() {
  // >= not === : a truck resupply can leave ammo above the normal mag size, and
  // reloading in that state must never claw it back down to effMagSize()
  if (reloading || ammo >= effMagSize()) return;
  reloading = true;
  reloadT = RELOAD_TIME * upgrades.reloadMul;
}

// ---------- Player physics state ----------
const velocity = new THREE.Vector3();
const airLaunch = new THREE.Vector3(); // horizontal drift from a building-jump boost (gun 2, 10000 milestone)
let grounded = false;
let crouching = false;
let currentEyeHeight = effStandHeight();
const raycaster = new THREE.Raycaster();
const centerRay = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

function resolveWallPush(pos, feetY, headY, box) {
  // only collide if the player's vertical span overlaps the wall's vertical span
  if (headY < box.minY + 0.02 || feetY > box.maxY - 0.02) return;
  const cx = Math.max(box.minX, Math.min(pos.x, box.maxX));
  const cz = Math.max(box.minZ, Math.min(pos.z, box.maxZ));
  const dx = pos.x - cx, dz = pos.z - cz;
  const distSq = dx * dx + dz * dz;
  const r = PLAYER_RADIUS;
  if (distSq < r * r) {
    const dist = Math.sqrt(distSq) || 0.0001;
    const push = r - dist;
    pos.x += (dx / dist) * push;
    pos.z += (dz / dist) * push;
  } else if (distSq < 0.0001) {
    // dead-center inside (rare, e.g. teleport) — push out along +X arbitrarily
    pos.x += r;
  }
}

function findPlacementHit() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(placementSurfaces, false);
  for (const hit of hits) {
    if (hit.distance > MAX_PLACE_DIST) break;
    if (hit.face && hit.face.normal) {
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      // upward-facing (rooftops/crates/ground) or near-vertical (walls) — reject odd
      // in-between overhang angles, which don't occur on anything in this world anyway
      const isUpward = worldNormal.y > 0.55;
      const isWall = Math.abs(worldNormal.y) < 0.35;
      if (isUpward || isWall) return { point: hit.point, normal: worldNormal };
    }
  }
  return null;
}

// Grid-snapping: if aiming near an already-placed panel, lock the target to one of
// that panel's four edge-adjacent slots (whichever is closest to the raw aim point)
// instead of the raw surface hit — makes building a uniform array easy.
const SNAP_RADIUS = PANEL_SIZE_LARGE * 1.9;
function getPlacementTarget() {
  const hit = findPlacementHit();
  if (!hit) return null;
  const size = currentPanelSize();

  let nearest = null, nearestDist = SNAP_RADIUS;
  for (const p of panels) {
    if (p.size !== size) continue; // only chain-snap within panels of the same size
    const dist = p.pos.distanceTo(hit.point);
    if (dist < nearestDist) { nearestDist = dist; nearest = p; }
  }
  if (!nearest) return { point: hit.point, normal: hit.normal, snapped: false, size };

  const q = nearest.mesh.quaternion;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const candidates = [
    nearest.pos.clone().addScaledVector(right, size),
    nearest.pos.clone().addScaledVector(right, -size),
    nearest.pos.clone().addScaledVector(fwd, size),
    nearest.pos.clone().addScaledVector(fwd, -size),
  ];
  let best = candidates[0], bestDist = Infinity;
  for (const c of candidates) {
    const dd = c.distanceTo(hit.point);
    if (dd < bestDist) { bestDist = dd; best = c; }
  }
  const snappedNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  return { point: best, normal: snappedNormal, snapped: true, size };
}

function isSpotFree(point, size = PANEL_SIZE) {
  for (const p of panels) {
    const minDist = ((size + (p.size || PANEL_SIZE)) / 2) * 0.92;
    if (p.pos.distanceTo(point) < minDist) return false;
  }
  return true;
}

const surfaceProbeRay = new THREE.Raycaster();
// confirms a grid cell actually lands on real surface geometry facing the expected
// direction (not just an infinite math-plane projection) — without this, a wide
// area-fill or block-place grid could paint panels floating past a wall's actual
// edge, out over open air, since the plane itself has no boundary
function pointOnPlacementSurface(point, normal) {
  const origin = point.clone().addScaledVector(normal, 0.5);
  surfaceProbeRay.set(origin, normal.clone().negate());
  surfaceProbeRay.far = 1.2;
  const hits = surfaceProbeRay.intersectObjects(placementSurfaces, false);
  for (const hit of hits) {
    if (!hit.face) continue;
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (worldNormal.dot(normal) > 0.85) return hit.point;
  }
  return null;
}

// ---------- Inverter placement, merging, and power switching ----------
// Inverters only mount to walls (near-vertical surfaces). Three tier-N inverters
// placed adjacent to each other automatically combine into one bigger tier-(N+1)
// unit — this can cascade (3 tier-1s -> 1 tier-2, etc).
function findInverterPlacementHit() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(worldMeshes, false);
  for (const hit of hits) {
    if (hit.distance > MAX_PLACE_DIST) continue;
    if (!hit.face || !hit.face.normal) continue;
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (Math.abs(worldNormal.y) < 0.35) return { point: hit.point, normal: worldNormal };
  }
  return null;
}

const INVERTER_SNAP_RADIUS = INVERTER_STEP * 1.9;
function getInverterPlacementTarget() {
  const hit = findInverterPlacementHit();
  if (!hit) return null;
  let nearest = null, nearestDist = INVERTER_SNAP_RADIUS;
  for (const inv of inverters) {
    if (inv.tier !== 0) continue; // only chain off freshly-placed (tier-0) units
    const dist = inv.pos.distanceTo(hit.point);
    if (dist < nearestDist) { nearestDist = dist; nearest = inv; }
  }
  if (!nearest) return { point: hit.point, normal: hit.normal, snapped: false };

  const q = nearest.mesh.quaternion;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const candidates = [
    nearest.pos.clone().addScaledVector(right, INVERTER_STEP),
    nearest.pos.clone().addScaledVector(right, -INVERTER_STEP),
    nearest.pos.clone().addScaledVector(fwd, INVERTER_STEP),
    nearest.pos.clone().addScaledVector(fwd, -INVERTER_STEP),
  ];
  let best = candidates[0], bestDist = Infinity;
  for (const c of candidates) {
    const dd = c.distanceTo(hit.point);
    if (dd < bestDist) { bestDist = dd; best = c; }
  }
  const snappedNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  return { point: best, normal: snappedNormal, snapped: true };
}

function isInverterSpotFree(point) {
  for (const inv of inverters) {
    if (inv.pos.distanceTo(point) < INVERTER_STEP * 0.85) return false;
  }
  return true;
}

function updateInverterIndicator(inv) {
  inv.indicatorMat.color.setHex(inv.poweredOn ? 0x4dff88 : 0xff5050);
  inv.indicatorMat.emissive.setHex(inv.poweredOn ? 0x2a8850 : 0x5a1010);
}

function createInverterMesh(point, normal, tier) {
  const dims = INVERTER_TIER_DIMS[Math.min(tier, INVERTER_TIER_DIMS.length - 1)];
  const thick = INVERTER_THICK + tier * 0.03;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(dims.w, thick, dims.h), matInverterBody);
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.isSurface = true;
  const vent = new THREE.Mesh(new THREE.BoxGeometry(dims.w * 0.7, thick * 0.3, dims.h * 0.35), matInverterVent);
  vent.position.set(0, thick / 2 + 0.001, -dims.h * 0.15);
  const indicatorMat = new THREE.MeshStandardMaterial({ color: 0xff5050, emissive: 0x5a1010, emissiveIntensity: 1.1 });
  const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.045 + tier * 0.01, 8, 8), indicatorMat);
  indicator.position.set(0, thick / 2 + 0.02, dims.h * 0.32);
  group.add(body, vent, indicator);

  const capacityKw = inverterCapacityKw(tier);
  const capacitySign = makeTextSprite(`0.0/${capacityKw}kW`, { fontSize: 46, color: '#ffe9b0', border: '#ffd54a', scale: 0.42 });
  capacitySign.position.set(0, thick / 2 + 0.3, dims.h * 0.55);
  const productionSign = makeTextSprite('0 kWh', { fontSize: 44, color: '#8aff9e', border: '#4dff88', scale: 0.32 });
  productionSign.position.set(0, thick / 2 + 0.3, dims.h * 0.32);
  group.add(capacitySign, productionSign);

  const up = new THREE.Vector3(0, 1, 0);
  group.quaternion.setFromUnitVectors(up, normal);
  group.position.copy(point).addScaledVector(normal, thick / 2 + 0.01);
  return { group, body, indicatorMat, productionSign, capacitySign };
}

function invertersAdjacent(a, b) {
  return a.tier === b.tier && a.pos.distanceTo(b.pos) < INVERTER_STEP * 1.15 && a.normal.dot(b.normal) > 0.9;
}

function placeInverter(point, normal, tier = 0) {
  const { group, body, indicatorMat, productionSign, capacitySign } = createInverterMesh(point, normal, tier);
  scene.add(group);
  worldMeshes.push(body);
  const inv = {
    mesh: group, pos: point.clone(), normal: normal.clone(), tier, groupId: null,
    wiredCables: new Set(), poweredOn: false, indicatorMat, productionSign, capacitySign,
    kwhProduced: 0, productionTick: 0, selected: false, selectionOutline: null,
  };
  inverters.push(inv);
  totalInvertersPlaced++;
  if (tier === 0) mergeInverterGroups(inv); // only base units auto-cluster by proximity; bigger tiers combine via manual RMB selection
  return inv;
}

// live "connected/capacity" readout on the sign, color-banded by load percentage —
// green up to 50%, yellow 51-85%, red 86-97%, flashing red 98-100%; past 100% the
// inverter overloads and is destroyed before the sign would ever show it
const SIGN_BANDS = {
  green:  { color: '#8aff9e', border: '#4dff88' },
  yellow: { color: '#ffe066', border: '#ffcf4a' },
  red:    { color: '#ff8a7f', border: '#ff5a3c' },
  flashDim: { color: '#7a2a22', border: '#5a1a10' },
};

function bandForLoadPercent(pct) {
  if (pct <= 50) return 'green';
  if (pct <= 85) return 'yellow';
  if (pct <= 97) return 'red';
  return 'flash';
}

// Sign shows the WHOLE network's connected-vs-capacity total (not just this one unit's
// own rating) — chaining inverters together pools their capacity, so that's the number
// that actually determines whether the system is safe.
function refreshInverterSign(inv) {
  const { watts, capacityWatts } = collectInverterNetwork(inv);
  const connectedKw = watts / 1000;
  const capacityKw = capacityWatts / 1000;
  const pct = capacityWatts > 0 ? (watts / capacityWatts) * 100 : 0;
  inv.signText = `${connectedKw.toFixed(1)}/${capacityKw}kW`;
  inv.signBand = bandForLoadPercent(pct);
  if (inv.signBand !== 'flash') {
    const style = SIGN_BANDS[inv.signBand];
    updateTextSprite(inv.capacitySign, inv.signText, { color: style.color, border: style.border, fontSize: 46 });
  }
  // the 'flash' band is animated per-frame by updateInverterSignFlash instead
}

function refreshAllInverterSigns() { inverters.forEach(refreshInverterSign); }

function updateInverterSignFlash(dt) {
  for (const inv of inverters) {
    if (inv.signBand !== 'flash') continue;
    inv.flashTimer = (inv.flashTimer || 0) + dt;
    const on = Math.floor(inv.flashTimer / 0.3) % 2 === 0;
    const style = on ? SIGN_BANDS.red : SIGN_BANDS.flashDim;
    updateTextSprite(inv.capacitySign, inv.signText, { color: style.color, border: style.border, fontSize: 46 });
  }
}

function checkLiveOverloads() {
  for (const inv of inverters.slice()) { // slice: overload mutates the live inverters array mid-loop
    if (!inv.poweredOn || !inverters.includes(inv)) continue; // may have just been destroyed by an earlier iteration
    const { watts, capacityWatts } = collectInverterNetwork(inv);
    if (watts > capacityWatts) triggerInverterOverload(inv, watts, capacityWatts);
  }
}

// shared by both merge paths: auto-cluster (tier 0) and manual RMB-selection (tier >= 1)
function finalizeInverterMerge(members) {
  const centroid = members[0].pos.clone();
  for (let i = 1; i < members.length; i++) centroid.add(members[i].pos);
  centroid.divideScalar(members.length);
  const normal = members[0].normal.clone();
  const newTier = members[0].tier + 1;
  const wiredCables = new Set();
  let anyPowered = false;
  members.forEach((inv) => { inv.wiredCables.forEach((c) => wiredCables.add(c)); if (inv.poweredOn) anyPowered = true; });

  // banner must be shown BEFORE constructing the merged unit: placeInverter() below can
  // itself trigger a deeper cascade (this merge's result touching off a further merge),
  // and that deeper banner should win — it only does if it's set chronologically after this one
  const tierNames = ['STANDARD', 'BIG', 'BIGGER', 'BIGGEST'];
  showMilestoneBanner('✦', `${members.length} INVERTERS COMBINED — ${tierNames[Math.min(newTier, tierNames.length - 1)]} UNIT!`);

  const merged = placeInverter(centroid, normal, newTier);
  merged.wiredCables = wiredCables;
  merged.poweredOn = anyPowered;
  updateInverterIndicator(merged);
  cables.forEach((c) => {
    if (c.startAnchor && c.startAnchor.type === 'inverter' && members.includes(c.startAnchor.obj)) c.startAnchor.obj = merged;
    if (c.endAnchor && c.endAnchor.type === 'inverter' && members.includes(c.endAnchor.obj)) c.endAnchor.obj = merged;
  });
  refreshAllInverterSigns();
  checkLiveOverloads(); // e.g. three powered 10kW units combining into a 20kW unit can exceed the new cap
  return merged;
}

function removeInverterFromWorld(inv) {
  unhighlightInverter(inv);
  scene.remove(inv.mesh);
  const wi = worldMeshes.indexOf(inv.mesh.children[0]);
  if (wi >= 0) worldMeshes.splice(wi, 1);
  const idx = inverters.indexOf(inv);
  if (idx >= 0) inverters.splice(idx, 1);
}

function combineInverters(members, groupId, group) {
  members.forEach((inv) => { removeInverterFromWorld(inv); group.delete(inv); });
  inverterGroups.delete(groupId);
  finalizeInverterMerge(members);
}

// ---------- Manual selection combine — RMB "highlights" a big (tier >= 1) inverter;
// once 3 same-tier units are highlighted they combine, regardless of adjacency ----------
const selectedInverters = new Set();

function highlightInverter(inv) {
  if (inv.selectionOutline) return;
  const body = inv.mesh.children[0];
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0xffe066 }));
  outline.position.copy(body.position);
  inv.mesh.add(outline);
  inv.selectionOutline = outline;
  inv.selected = true;
}

function unhighlightInverter(inv) {
  if (inv.selectionOutline) inv.mesh.remove(inv.selectionOutline);
  inv.selectionOutline = null;
  inv.selected = false;
}

function toggleInverterSelection(inv) {
  if (selectedInverters.has(inv)) {
    selectedInverters.delete(inv);
    unhighlightInverter(inv);
    return;
  }
  if (selectedInverters.size > 0) {
    const existingTier = Array.from(selectedInverters)[0].tier;
    if (inv.tier !== existingTier) { showToast('SELECT SAME-TIER INVERTERS TO COMBINE'); return; }
  }
  selectedInverters.add(inv);
  highlightInverter(inv);
  if (selectedInverters.size >= 3) {
    const members = Array.from(selectedInverters).slice(0, 3);
    members.forEach((m) => selectedInverters.delete(m));
    members.forEach((m) => removeInverterFromWorld(m));
    finalizeInverterMerge(members);
  }
}

function mergeInverterGroups(newInv) {
  const touchedIds = new Set();
  for (const other of inverters) {
    if (other === newInv || !other.groupId) continue;
    if (invertersAdjacent(newInv, other)) touchedIds.add(other.groupId);
  }
  let mergedId;
  if (touchedIds.size === 0) {
    mergedId = nextInverterGroupId++;
    inverterGroups.set(mergedId, new Set());
  } else {
    const ids = Array.from(touchedIds);
    mergedId = ids[0];
    const mergedSet = inverterGroups.get(mergedId);
    for (let i = 1; i < ids.length; i++) {
      const other = inverterGroups.get(ids[i]);
      other.forEach((p) => { p.groupId = mergedId; mergedSet.add(p); });
      inverterGroups.delete(ids[i]);
    }
  }
  const finalGroup = inverterGroups.get(mergedId);
  finalGroup.add(newInv);
  newInv.groupId = mergedId;

  while (finalGroup.size >= 3) {
    const members = Array.from(finalGroup).slice(0, 3);
    combineInverters(members, mergedId, finalGroup);
    break; // combineInverters may recurse into a fresh merge pass of its own
  }
}

// ---------- Batteries (gun 0, LMB) — combine BATTERY_MERGE_COUNT (5) at a time like
// inverters, but every tier auto-merges by proximity (no manual RMB-select tier, since
// RMB on this gun places switchboards instead) ----------
const matBatteryBody = new THREE.MeshStandardMaterial({ color: 0x2f6a3a, roughness: 0.5, metalness: 0.3 });
const batteries = [];
const batteryGroups = new Map();
let nextBatteryGroupId = 1;
let totalBatteryKwhInstalled = 0;

const BATTERY_SNAP_RADIUS = BATTERY_STEP * 1.9;
function getBatteryPlacementTarget() {
  const hit = findInverterPlacementHit(); // walls only, same placement rule as inverters
  if (!hit) return null;
  let nearest = null, nearestDist = BATTERY_SNAP_RADIUS;
  for (const b of batteries) {
    const dist = b.pos.distanceTo(hit.point);
    if (dist < nearestDist) { nearestDist = dist; nearest = b; }
  }
  if (!nearest) return { point: hit.point, normal: hit.normal, snapped: false };
  const q = nearest.mesh.quaternion;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const candidates = [
    nearest.pos.clone().addScaledVector(right, BATTERY_STEP),
    nearest.pos.clone().addScaledVector(right, -BATTERY_STEP),
    nearest.pos.clone().addScaledVector(fwd, BATTERY_STEP),
    nearest.pos.clone().addScaledVector(fwd, -BATTERY_STEP),
  ];
  let best = candidates[0], bestDist = Infinity;
  for (const c of candidates) { const dd = c.distanceTo(hit.point); if (dd < bestDist) { bestDist = dd; best = c; } }
  const snappedNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  return { point: best, normal: snappedNormal, snapped: true };
}
function isBatterySpotFree(point) {
  for (const b of batteries) if (b.pos.distanceTo(point) < BATTERY_STEP * 0.85) return false;
  return true;
}
function createBatteryMesh(point, normal, tier) {
  const dims = BATTERY_DIMS[Math.min(tier, BATTERY_DIMS.length - 1)];
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(dims.w, BATTERY_THICK, dims.h), matBatteryBody);
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.isSurface = true;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(dims.w * 0.8, 0.02, dims.h * 0.15), matPanelFrame);
  stripe.position.set(0, BATTERY_THICK / 2 + 0.005, 0);
  group.add(body, stripe);
  const kwh = BATTERY_CAPACITY_KWH[Math.min(tier, BATTERY_CAPACITY_KWH.length - 1)];
  const sign = makeTextSprite(`${kwh}kWh`, { fontSize: 40, color: '#8affc9', border: '#4dffa0', scale: 0.3 });
  sign.position.set(0, BATTERY_THICK / 2 + 0.22, dims.h * 0.4);
  group.add(sign);
  const up = new THREE.Vector3(0, 1, 0);
  group.quaternion.setFromUnitVectors(up, normal);
  group.position.copy(point).addScaledVector(normal, BATTERY_THICK / 2 + 0.01);
  return { group, body };
}
function batteriesAdjacent(a, b) {
  return a.tier === b.tier && a.pos.distanceTo(b.pos) < BATTERY_STEP * 1.15 && a.normal.dot(b.normal) > 0.9;
}
function placeBattery(point, normal, tier = 0) {
  const { group, body } = createBatteryMesh(point, normal, tier);
  scene.add(group);
  worldMeshes.push(body);
  const battery = { mesh: group, pos: point.clone(), normal: normal.clone(), tier, groupId: null, wiredCables: new Set() };
  batteries.push(battery);
  totalBatteryKwhInstalled += BATTERY_CAPACITY_KWH[Math.min(tier, BATTERY_CAPACITY_KWH.length - 1)];
  mergeBatteryGroups(battery);
  maybeUnlockSwitchboards();
  return battery;
}
function removeBatteryFromWorld(battery) {
  scene.remove(battery.mesh);
  const wi = worldMeshes.indexOf(battery.mesh.children[0]);
  if (wi >= 0) worldMeshes.splice(wi, 1);
  const idx = batteries.indexOf(battery);
  if (idx >= 0) batteries.splice(idx, 1);
  totalBatteryKwhInstalled -= BATTERY_CAPACITY_KWH[Math.min(battery.tier, BATTERY_CAPACITY_KWH.length - 1)];
}
function finalizeBatteryMerge(members) {
  const centroid = members[0].pos.clone();
  for (let i = 1; i < members.length; i++) centroid.add(members[i].pos);
  centroid.divideScalar(members.length);
  const normal = members[0].normal.clone();
  const newTier = members[0].tier + 1;
  const wiredCables = new Set();
  members.forEach((b) => { b.wiredCables.forEach((c) => wiredCables.add(c)); });
  const tierNames = ['STANDARD', 'BIG', 'BIGGER', 'BIGGEST'];
  showMilestoneBanner('🔋', `${members.length} BATTERIES COMBINED — ${tierNames[Math.min(newTier, tierNames.length - 1)]} BANK!`);
  const merged = placeBattery(centroid, normal, newTier);
  merged.wiredCables = wiredCables;
  cables.forEach((c) => {
    if (c.startAnchor && c.startAnchor.type === 'battery' && members.includes(c.startAnchor.obj)) c.startAnchor.obj = merged;
    if (c.endAnchor && c.endAnchor.type === 'battery' && members.includes(c.endAnchor.obj)) c.endAnchor.obj = merged;
  });
  updateSwitchboardEnergize();
  return merged;
}
function combineBatteries(members, groupId, group) {
  members.forEach((b) => { removeBatteryFromWorld(b); group.delete(b); });
  batteryGroups.delete(groupId);
  finalizeBatteryMerge(members);
}
function mergeBatteryGroups(newBattery) {
  const touchedIds = new Set();
  for (const other of batteries) {
    if (other === newBattery || !other.groupId) continue;
    if (batteriesAdjacent(newBattery, other)) touchedIds.add(other.groupId);
  }
  let mergedId;
  if (touchedIds.size === 0) {
    mergedId = nextBatteryGroupId++;
    batteryGroups.set(mergedId, new Set());
  } else {
    const ids = Array.from(touchedIds);
    mergedId = ids[0];
    const mergedSet = batteryGroups.get(mergedId);
    for (let i = 1; i < ids.length; i++) {
      const other = batteryGroups.get(ids[i]);
      other.forEach((p) => { p.groupId = mergedId; mergedSet.add(p); });
      batteryGroups.delete(ids[i]);
    }
  }
  const finalGroup = batteryGroups.get(mergedId);
  finalGroup.add(newBattery);
  newBattery.groupId = mergedId;
  while (finalGroup.size >= BATTERY_MERGE_COUNT) {
    const members = Array.from(finalGroup).slice(0, BATTERY_MERGE_COUNT);
    combineBatteries(members, mergedId, finalGroup);
    break; // combineBatteries may recurse into a fresh merge pass of its own
  }
}

function maybeUnlockSwitchboards() {
  if (!upgrades.switchboardUnlocked && totalBatteryKwhInstalled >= SWITCHBOARD_UNLOCK_KWH) {
    upgrades.switchboardUnlocked = true;
    showMilestoneBanner('🔌', `SWITCHBOARDS UNLOCKED! ${SWITCHBOARD_UNLOCK_KWH}kWh OF BATTERIES INSTALLED — RMB WITH GUN 0 TO PLACE ONE`);
  }
}

// ---------- Switchboards (gun 0, RMB, unlocked once 100kWh of batteries are installed)
// — wire batteries to inverters, and inverters to a switchboard, to energize it. An
// energized switchboard turns on its building's window lights and any nearby street
// lamps (see updateSwitchboardEnergize/applyNearbyLighting). ----------
const matSwitchboardBody = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.4 });
const switchboards = [];
function createSwitchboardMesh(point, normal) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(SWITCHBOARD_DIMS.w, SWITCHBOARD_THICK, SWITCHBOARD_DIMS.h), matSwitchboardBody);
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.isSurface = true;
  const dialMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  for (let i = 0; i < 3; i++) {
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 10), dialMat);
    dial.rotation.x = Math.PI / 2;
    dial.position.set(-0.15 + i * 0.15, SWITCHBOARD_THICK / 2 + 0.011, 0.1);
    group.add(dial);
  }
  group.add(body);
  const sign = makeTextSprite('OFFLINE', { fontSize: 36, color: '#ff8a7f', border: '#ff5a3c', scale: 0.28 });
  sign.position.set(0, SWITCHBOARD_THICK / 2 + 0.25, SWITCHBOARD_DIMS.h * 0.4);
  group.add(sign);
  const up = new THREE.Vector3(0, 1, 0);
  group.quaternion.setFromUnitVectors(up, normal);
  group.position.copy(point).addScaledVector(normal, SWITCHBOARD_THICK / 2 + 0.01);
  return { group, body, sign };
}
function isSwitchboardSpotFree(point) {
  for (const s of switchboards) if (s.pos.distanceTo(point) < 0.8) return false;
  return true;
}
function placeSwitchboard(point, normal) {
  const { group, body, sign } = createSwitchboardMesh(point, normal);
  scene.add(group);
  worldMeshes.push(body);
  const swb = { mesh: group, pos: point.clone(), normal: normal.clone(), wiredCables: new Set(), energized: false, sign };
  switchboards.push(swb);
  return swb;
}

// building window lights + nearby street lamps switch on/off together with a switchboard
function applyNearbyLighting(pos, on) {
  const b = findBuildingContaining(pos.x, pos.z);
  if (b && b.windowMeshes) {
    b.windowMeshes.forEach((wm) => {
      wm.material.color.setHex(on ? 0xffd98a : 0x2a3a44);
      wm.material.emissive.setHex(on ? 0xffb347 : 0x0b1a22);
      wm.material.emissiveIntensity = on ? 1.4 : 0.3;
    });
  }
  streetLamps.forEach((lamp) => {
    if (lamp.pos.distanceTo(pos) < 20) setStreetLampOn(lamp, on);
  });
}

// component-wide check (not strict path-tracing, matching collectInverterNetwork's own
// fidelity level): a switchboard is energized if its connected cable component contains
// at least one battery AND at least one powered-on inverter, anywhere in the component
function isSwitchboardEnergized(swb) {
  const visitedObjs = new Set([swb]);
  const queue = [swb];
  let sawBattery = false, sawPoweredInverter = false;
  while (queue.length) {
    const cur = queue.shift();
    for (const c of cables) {
      let other = null;
      if (c.startAnchor && c.startAnchor.obj === cur) other = c.endAnchor;
      else if (c.endAnchor && c.endAnchor.obj === cur) other = c.startAnchor;
      if (!other || visitedObjs.has(other.obj)) continue;
      visitedObjs.add(other.obj);
      if (other.type === 'battery') sawBattery = true;
      if (other.type === 'inverter' && other.obj.poweredOn) sawPoweredInverter = true;
      if (other.type === 'inverter' || other.type === 'switchboard' || other.type === 'battery') queue.push(other.obj);
    }
  }
  return sawBattery && sawPoweredInverter;
}

function updateSwitchboardEnergize() {
  switchboards.forEach((swb) => {
    const now = isSwitchboardEnergized(swb);
    if (now === swb.energized) return;
    swb.energized = now;
    updateTextSprite(swb.sign, now ? 'ENERGIZED' : 'OFFLINE', now
      ? { fontSize: 36, color: '#8aff9e', border: '#4dff88' }
      : { fontSize: 36, color: '#ff8a7f', border: '#ff5a3c' });
    applyNearbyLighting(swb.pos, now);
  });
}

function fireInverter() {
  if (inverterFireCooldown > 0) return;
  inverterFireCooldown = 0.28;
  const target = getInverterPlacementTarget();
  if (target && isInverterSpotFree(target.point)) {
    placeInverter(target.point, target.normal, 0);
  }
}

// ---------- Gun 0: Batteries (LMB) & Switchboards (RMB) — unlocked at
// POWER_SYSTEMS_FOR_GUN0 successful array power-ons ----------
let batteryFireCooldown = 0;
function fireBattery() {
  if (batteryFireCooldown > 0) return;
  batteryFireCooldown = 0.28;
  const target = getBatteryPlacementTarget();
  if (target && isBatterySpotFree(target.point)) {
    placeBattery(target.point, target.normal, 0);
  }
}
let switchboardFireCooldown = 0;
function fireSwitchboard() {
  if (!upgrades.switchboardUnlocked) {
    showToast(`SWITCHBOARDS LOCKED — INSTALL ${SWITCHBOARD_UNLOCK_KWH}kWh OF BATTERIES FIRST (${totalBatteryKwhInstalled}/${SWITCHBOARD_UNLOCK_KWH})`);
    return;
  }
  if (switchboardFireCooldown > 0) return;
  switchboardFireCooldown = 0.35;
  const target = getBatteryPlacementTarget(); // reuses the same wall-mount snap logic
  if (target && isSwitchboardSpotFree(target.point)) {
    placeSwitchboard(target.point, target.normal);
    showToast('SWITCHBOARD PLACED — WIRE BATTERIES→INVERTER→SWITCHBOARD TO ENERGIZE IT');
  }
}

// ---------- Weapon 7: Bulk Inverter Gun (shop purchase) — places a Tier 1 (10kW) unit
// directly, skipping the usual 3x tier-0-proximity-merge grind ----------
let bulkInverterCooldown = 0;
function fireBulkInverter() {
  if (bulkInverterCooldown > 0) return;
  bulkInverterCooldown = 0.35;
  const target = getInverterPlacementTarget();
  if (target && isInverterSpotFree(target.point)) {
    placeInverter(target.point, target.normal, 1);
    showToast('TIER 1 INVERTER PLACED');
  }
}

// ---------- Weapon 6: Panel Repair Tool (shop purchase) — aim at a burnt panel and
// fire to un-char it, restoring its wattage to the array ----------
let repairCooldown = 0;
function firePanelRepair() {
  if (repairCooldown > 0) return;
  repairCooldown = 0.3;
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(panels.map((p) => p.mesh), true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !panels.some((p) => p.mesh === obj)) obj = obj.parent;
  const p = panels.find((pp) => pp.mesh === obj);
  if (!p) return;
  if (!p.burnt) { showToast('THAT PANEL ISN\'T DAMAGED'); return; }
  if (p.burning) { showToast('PUT THE FIRE OUT FIRST'); return; }
  // burning never deducted the panel's wattage (a charred panel still counts
  // electrically, see collectInverterNetwork) — repairing is purely cosmetic,
  // restoring the clean panel material with no change to totalWattsInstalled
  p.burnt = false;
  const body = p.mesh.children.find((c) => c.material !== matPanelFrame);
  if (body) body.material = p.size > PANEL_SIZE + 0.01 ? matPanelLarge : matPanel;
  showToast('PANEL REPAIRED');
}

// ---------- Weapon 8: Demo Tool — a shop purchase (gated on 100 given rock + 100
// given timber even appearing for sale; costs 200/200 to actually buy), with 3 tiers
// unlocked automatically by further donations after purchase:
//   tier 1 (just bought): LMB breaks up one rubble chunk for 20 rock/timber at once
//   tier 2 (500 given rock + 500 given timber): RMB drag-collects rubble, up to 100
//     units per drag; LMB can also single-pick-up loose cable/panel/inverter scrap
//   tier 3 (100 given panel + 100 given cable + 100 given inverter): RMB drag now
//     collects ANY loose salvage (all 5 types), still up to 100 units per drag
// ---------------------------------------------------------------------------------
function creditScrap(type, n) {
  if (type === 'panel') carriedPanelScrap += n;
  else if (type === 'inverter') carriedInverterScrap += n;
  else if (type === 'rock') carriedRockScrap += n;
  else if (type === 'timber') carriedTimberScrap += n;
  else if (type === 'metal') carriedMetalScrap += n;
  else carriedCableScrap += n;
}

// removes one tagged rubble chunk and credits n units of its scrap type
function harvestRubbleChunk(idx, n) {
  const chunk = salvageableRubble[idx];
  scene.remove(chunk.mesh);
  const gi = groundColliders.indexOf(chunk.mesh);
  if (gi >= 0) groundColliders.splice(gi, 1);
  salvageableRubble.splice(idx, 1);
  creditScrap(chunk.type, n);
  return chunk.type;
}

// picks up one already-dropped scrap pickup (cable/panel/inverter/rock/timber)
function harvestScrapPickup(idx) {
  const s = scraps[idx];
  const type = s.userData.scrapType;
  scene.remove(s);
  scraps.splice(idx, 1);
  creditScrap(type, 1);
  return type;
}

// baseline interaction, no tool required — aim at a rock/timber rubble chunk and
// press E to pick up exactly one unit; falls back to the normal inverter-switch
// interact if nothing salvageable is under the crosshair
function handleInteractKey() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(salvageableRubble.map((r) => r.mesh), false);
  if (hits.length && hits[0].distance <= 6) {
    const idx = salvageableRubble.findIndex((r) => r.mesh === hits[0].object);
    if (idx >= 0) {
      const type = harvestRubbleChunk(idx, 1);
      showToast(`PICKED UP 1 ${type.toUpperCase()}`);
      return;
    }
  }
  toggleInverterSwitch();
}

let demoToolCooldown = 0;
function fireDemoTool() {
  if (demoToolCooldown > 0) return;
  demoToolCooldown = 0.3;
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);

  // tier 2+: a loose scrap pile under the crosshair gets picked up directly, one unit
  if (upgrades.demoToolTier >= 2) {
    const scrapHits = centerRay.intersectObjects(scraps, false);
    if (scrapHits.length && scrapHits[0].distance <= 6) {
      const idx = scraps.indexOf(scrapHits[0].object);
      if (idx >= 0) {
        const type = harvestScrapPickup(idx);
        showToast(`PICKED UP 1 ${type.toUpperCase()}`);
        return;
      }
    }
  }

  const hits = centerRay.intersectObjects(salvageableRubble.map((r) => r.mesh), false);
  if (!hits.length || hits[0].distance > 8) { showToast('AIM AT A ROCK/TIMBER CHUNK IN A RUBBLE PILE'); return; }
  const idx = salvageableRubble.findIndex((r) => r.mesh === hits[0].object);
  if (idx < 0) return;
  const type = harvestRubbleChunk(idx, 20);
  showToast(`BROKE UP RUBBLE — +20 ${type.toUpperCase()}`);
}

// tier 2+: RMB "drag" (held, swept around with the crosshair) vacuums up nearby
// matching items — rubble only at tier 2, any loose scrap too at tier 3 — up to 100
// units in one drag session
let demoDrag = null; // { collected, tick }
function updateDemoDrag(dt) {
  if (!demoDrag) return;
  demoDrag.tick -= dt;
  if (demoDrag.tick > 0) return;
  demoDrag.tick = 0.12;
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const candidates = salvageableRubble.map((r) => r.mesh).concat(upgrades.demoToolTier >= 3 ? scraps : []);
  const hits = centerRay.intersectObjects(candidates, false);
  if (!hits.length || hits[0].distance > 8) return;
  const obj = hits[0].object;
  const rubbleIdx = salvageableRubble.findIndex((r) => r.mesh === obj);
  if (rubbleIdx >= 0) { harvestRubbleChunk(rubbleIdx, 1); demoDrag.collected++; }
  else {
    const scrapIdx = scraps.indexOf(obj);
    if (scrapIdx >= 0) { harvestScrapPickup(scrapIdx); demoDrag.collected++; }
  }
  if (demoDrag.collected >= 100) { showToast('DRAG COLLECT CAP REACHED (100)'); demoDrag = null; }
}

function findInverterUnderCrosshair() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(inverters.map((i) => i.mesh), true);
  if (!hits.length) return null;
  let obj = hits[0].object;
  while (obj && !inverters.some((i) => i.mesh === obj)) obj = obj.parent;
  return inverters.find((i) => i.mesh === obj) || null;
}

function pickUpNearestInverter() {
  let best = -1, bestDist = 3.2;
  for (let i = 0; i < inverters.length; i++) {
    if (inverters[i].tier !== 0) continue; // merged units are permanent
    const d = inverters[i].pos.distanceTo(camera.position);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best < 0) return;
  const inv = inverters[best];
  scene.remove(inv.mesh);
  const wi = worldMeshes.indexOf(inv.mesh.children[0]);
  if (wi >= 0) worldMeshes.splice(wi, 1);
  if (inv.groupId && inverterGroups.has(inv.groupId)) inverterGroups.get(inv.groupId).delete(inv);
  inverters.splice(best, 1);
}

// gun-4 RMB: tier-0 units pick up (proximity-based, matches the panel gun's feel); tier >= 1
// "big" units instead toggle selection for the manual 3-way combine
function handleInverterRightClick() {
  const targeted = findInverterUnderCrosshair();
  if (targeted && targeted.tier >= 1) { toggleInverterSelection(targeted); return; }
  pickUpNearestInverter();
}

function toggleInverterSwitch() {
  if (!isLocked) return;
  const inv = findInverterUnderCrosshair();
  if (!inv) { showToast('AIM AT AN INVERTER TO SWITCH IT'); return; }
  if (inv.wiredCables.size === 0) { showToast('NO PANELS WIRED TO THIS INVERTER'); return; }
  if (inv.poweredOn) {
    inv.poweredOn = false;
    updateInverterIndicator(inv);
    showToast(inv.burning ? 'INVERTER OFF — STILL ON FIRE, SPRAY IT DOWN' : 'SOLAR ARRAY OFFLINE');
    updateSwitchboardEnergize();
    return;
  }
  if (inv.burning) { showToast('PUT THE FIRE OUT BEFORE SWITCHING IT BACK ON'); return; }
  const { watts: arrayWatts, capacityWatts } = collectInverterNetwork(inv);
  if (arrayWatts > capacityWatts) {
    triggerInverterOverload(inv, arrayWatts, capacityWatts);
    return;
  }
  inv.poweredOn = true;
  updateInverterIndicator(inv);
  showToast('SOLAR ARRAY ONLINE');
  if (!upgrades.deliveryUnlocked) {
    upgrades.deliveryUnlocked = true;
    spawnDeliveryTruck();
    showMilestoneBanner('🚚', 'DELIVERY UPGRADE! A TRUCK ARRIVED — WALK UP TO IT FOR AMMO UP TO 150');
  }
  // each successful power-on counts as one more "separate power system installed"
  totalPowerSystemsActivated++;
  if (!upgrades.gun0Unlocked && totalPowerSystemsActivated >= POWER_SYSTEMS_FOR_GUN0) {
    upgrades.gun0Unlocked = true;
    showMilestoneBanner('🔋', 'GUN 0 UNLOCKED! PRESS 0 — BATTERIES (LMB) & SWITCHBOARDS (RMB)');
  }
  updateSwitchboardEnergize();
}

// ---------- Area-fill drag tool (unlocked at 100 panels placed) ----------
// Pointer lock means mouse movement is always camera-look, so "dragging an area"
// works by picking a corner where RMB went down, then swinging the view to the far
// corner while still held — the rectangle is the plane between the two aim points.
let areaDrag = null; // { corner, normal, right, fwd, startYaw, startPitch, valid }

function beginAreaDragCandidate() {
  const target = getPlacementTarget();
  areaDrag = { startYaw: yaw, startPitch: pitch, valid: false, corner: null, normal: null, right: null, fwd: null };
  if (!target) return;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), target.normal);
  areaDrag.corner = target.point.clone();
  areaDrag.normal = target.normal.clone();
  areaDrag.right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  areaDrag.fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  areaDrag.valid = true;
}

// Projects the current camera aim ray onto the drag's corner plane, then returns the
// list of free grid-cell positions spanning from the corner to that projected point.
function computeAreaCells() {
  if (!areaDrag || !areaDrag.valid) return null;
  const rayOrigin = camera.position;
  const rayDir = new THREE.Vector3();
  camera.getWorldDirection(rayDir);
  const denom = rayDir.dot(areaDrag.normal);
  if (Math.abs(denom) < 1e-5) return null;
  const t = areaDrag.corner.clone().sub(rayOrigin).dot(areaDrag.normal) / denom;
  if (t < 0 || t > MAX_PLACE_DIST * 2) return null;
  const aimPoint = rayOrigin.clone().addScaledVector(rayDir, t);

  const rel = aimPoint.clone().sub(areaDrag.corner);
  let cellU = Math.round(rel.dot(areaDrag.right) / PANEL_SIZE);
  let cellV = Math.round(rel.dot(areaDrag.fwd) / PANEL_SIZE);
  cellU = Math.max(-AREA_SPAN_CAP, Math.min(AREA_SPAN_CAP, cellU));
  cellV = Math.max(-AREA_SPAN_CAP, Math.min(AREA_SPAN_CAP, cellV));
  const minU = Math.min(0, cellU), maxU = Math.max(0, cellU);
  const minV = Math.min(0, cellV), maxV = Math.max(0, cellV);

  const cells = [];
  for (let iu = minU; iu <= maxU; iu++) {
    for (let iv = minV; iv <= maxV; iv++) {
      const raw = areaDrag.corner.clone()
        .addScaledVector(areaDrag.right, iu * PANEL_SIZE)
        .addScaledVector(areaDrag.fwd, iv * PANEL_SIZE);
      // clip to the real surface footprint, not just the infinite math-plane — this is
      // what keeps the grid from painting panels out past the actual wall/roof edge
      const onSurface = pointOnPlacementSurface(raw, areaDrag.normal);
      if (onSurface && isSpotFree(onSurface)) cells.push(onSurface);
      if (cells.length >= MAX_AREA_CELLS) break;
    }
    if (cells.length >= MAX_AREA_CELLS) break;
  }
  return { cells, normal: areaDrag.normal };
}

// centered block fill for the 1000-panel block-place unlock: same surface-clipped grid
// logic as the area tool, but anchored on the crosshair's aim point instead of a drag
function computeBlockCells(target) {
  if (!target) return null;
  const size = target.size;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), target.normal);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const half = (BLOCK_PLACE_SIZE - 1) / 2;
  const cells = [];
  for (let iu = -half; iu <= half; iu++) {
    for (let iv = -half; iv <= half; iv++) {
      const raw = target.point.clone().addScaledVector(right, iu * size).addScaledVector(fwd, iv * size);
      const onSurface = pointOnPlacementSurface(raw, target.normal);
      if (onSurface && isSpotFree(onSurface, size)) cells.push(onSurface);
    }
  }
  return { cells, normal: target.normal, size };
}

function updateAreaDragPreview() {
  const result = areaDrag && areaDrag.valid ? computeAreaCells() : null;
  if (!result || result.cells.length === 0) {
    ghostAreaMesh.visible = false;
    ghostAreaMesh.count = 0;
    return;
  }
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), result.normal);
  const m = new THREE.Matrix4();
  result.cells.forEach((p, i) => {
    const pos = p.clone().addScaledVector(result.normal, PANEL_THICK / 2 + 0.01);
    m.compose(pos, q, new THREE.Vector3(1, 1, 1));
    ghostAreaMesh.setMatrixAt(i, m);
  });
  ghostAreaMesh.count = result.cells.length;
  ghostAreaMesh.instanceMatrix.needsUpdate = true;
  ghostAreaMesh.visible = true;
}

function commitAreaFill() {
  const result = computeAreaCells();
  ghostAreaMesh.visible = false;
  ghostAreaMesh.count = 0;
  if (!result || result.cells.length === 0) return;
  result.cells.forEach((p) => placePanel(p, result.normal, true));
  showToast(`AREA FILLED: ${result.cells.length} PANELS`);
}

function endAreaDrag() {
  if (!areaDrag) return;
  const gestureSize = Math.abs(yaw - areaDrag.startYaw) + Math.abs(pitch - areaDrag.startPitch);
  const didDrag = gestureSize > 0.035;
  if (areaDrag.valid && didDrag) {
    commitAreaFill();
  } else {
    pickUpNearestPanel();
  }
  ghostAreaMesh.visible = false;
  ghostAreaMesh.count = 0;
  areaDrag = null;
}

// ---------- Panel connectivity groups + streak celebration ----------
const groups = new Map(); // groupId -> Set<panelObj>
let nextGroupId = 1;
const STREAK_THRESHOLDS = [5, 10, 20, 50];
const activeGlowPulses = [];
let toastTimer = 0;

function panelsAdjacent(a, b) {
  const threshold = ((a.size || PANEL_SIZE) + (b.size || PANEL_SIZE)) / 2 * 1.15;
  return a.pos.distanceTo(b.pos) < threshold && a.normal.dot(b.normal) > 0.9;
}

function showToast(text, duration = 1.6) {
  streakToastEl.textContent = text;
  streakToastEl.classList.add('show');
  toastTimer = duration;
}

let milestoneBannerTimer = 0;
function showMilestoneBanner(stars, title, duration = 3.4) {
  milestoneBannerEl.classList.remove('danger');
  milestoneBannerStarsEl.textContent = stars;
  milestoneBannerStarsEl.style.display = stars ? 'block' : 'none';
  milestoneBannerTitleEl.textContent = title;
  milestoneBannerEl.classList.add('show');
  milestoneBannerTimer = duration;
}

function showDangerBanner(title, duration = 3.8) {
  showMilestoneBanner('⚠', title, duration);
  milestoneBannerEl.classList.add('danger');
}

function spawnGroupGlow(panelSet) {
  const group = new THREE.Group();
  panelSet.forEach((p) => {
    const edges = new THREE.EdgesGeometry(ghostGeo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 1 }));
    line.position.copy(p.pos).addScaledVector(p.normal, PANEL_THICK / 2 + 0.02);
    line.quaternion.copy(p.mesh.quaternion);
    group.add(line);
  });
  scene.add(group);
  activeGlowPulses.push({ group, t: 1.3, dur: 1.3 });
}

function placePanel(point, normal, silent = false, size = PANEL_SIZE) {
  const isLarge = size > PANEL_SIZE + 0.01;
  const group = new THREE.Group();
  const body = new THREE.Mesh(isLarge ? ghostGeoLarge : ghostGeo, isLarge ? matPanelLarge : matPanel);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(size + 0.06, PANEL_THICK * 0.6, size + 0.06), matPanelFrame);
  frame.position.y = -PANEL_THICK * 0.3;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(frame, body);

  const up = new THREE.Vector3(0, 1, 0);
  group.quaternion.setFromUnitVectors(up, normal);
  group.position.copy(point).addScaledVector(normal, PANEL_THICK / 2 + 0.005);
  scene.add(group);

  groundColliders.push(group);
  worldMeshes.push(body);
  const watts = isLarge ? PANEL_WATTS_LARGE : PANEL_WATTS_SMALL;
  totalWattsInstalled += watts;
  const panel = { mesh: group, pos: point.clone(), normal: normal.clone(), groupId: null, size, watts };
  panels.push(panel);
  totalPanelsPlaced++;
  if (!unlockedAreaTool && totalPanelsPlaced >= AREA_TOOL_UNLOCK_COUNT) {
    unlockedAreaTool = true;
    showToast('AREA TOOL UNLOCKED — HOLD RMB, LOOK TO THE FAR CORNER, RELEASE TO BUILD');
  }
  if (!upgrades.blockPlacementUnlocked && totalPanelsPlaced >= BLOCK_PLACE_UNLOCK_COUNT) {
    upgrades.blockPlacementUnlocked = true;
    showToast(`BLOCK PLACEMENT UNLOCKED — PRESS B TO TOGGLE, LMB DROPS A ${BLOCK_PLACE_SIZE * BLOCK_PLACE_SIZE}-PANEL BLOCK`);
  }

  // merge into whichever adjacent panel groups this one touches
  const touchedGroupIds = new Set();
  for (const other of panels) {
    if (other === panel || !other.groupId) continue;
    if (panelsAdjacent(panel, other)) touchedGroupIds.add(other.groupId);
  }
  let prevSize = 0;
  let mergedId;
  if (touchedGroupIds.size === 0) {
    mergedId = nextGroupId++;
    groups.set(mergedId, new Set());
  } else {
    const ids = Array.from(touchedGroupIds);
    mergedId = ids[0];
    const mergedSet = groups.get(mergedId);
    for (let i = 1; i < ids.length; i++) {
      const other = groups.get(ids[i]);
      other.forEach((p) => { p.groupId = mergedId; mergedSet.add(p); });
      groups.delete(ids[i]);
    }
    prevSize = mergedSet.size;
  }
  const finalGroup = groups.get(mergedId);
  finalGroup.add(panel);
  panel.groupId = mergedId;

  if (!silent) {
    const newSize = finalGroup.size;
    let hitThreshold = null;
    for (const th of STREAK_THRESHOLDS) {
      if (prevSize < th && newSize >= th) hitThreshold = th;
    }
    if (hitThreshold) {
      spawnGroupGlow(finalGroup);
      showToast(`${hitThreshold} PANELS CONNECTED!`);
    }
  }
}

function removePanelFromGroups(panel) {
  const gid = panel.groupId;
  if (!gid) return;
  const group = groups.get(gid);
  if (!group) return;
  group.delete(panel);
  groups.delete(gid);
  if (group.size <= 1) return;

  // former group may have split into multiple pieces — recompute via BFS
  const remaining = Array.from(group);
  const visited = new Set();
  for (const start of remaining) {
    if (visited.has(start)) continue;
    const comp = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const cur = queue.pop();
      comp.push(cur);
      for (const other of remaining) {
        if (visited.has(other)) continue;
        if (panelsAdjacent(cur, other)) { visited.add(other); queue.push(other); }
      }
    }
    const newId = nextGroupId++;
    groups.set(newId, new Set(comp));
    comp.forEach((p) => { p.groupId = newId; });
  }
}

function pickUpNearestPanel() {
  let best = -1, bestDist = 3.2;
  for (let i = 0; i < panels.length; i++) {
    const d = panels[i].pos.distanceTo(camera.position);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best >= 0) {
    const p = panels[best];
    scene.remove(p.mesh);
    const gi = groundColliders.indexOf(p.mesh);
    if (gi >= 0) groundColliders.splice(gi, 1);
    const wi = worldMeshes.indexOf(p.mesh.children.find((c) => c.material === matPanel || c.material === matPanelLarge));
    if (wi >= 0) worldMeshes.splice(wi, 1);
    removePanelFromGroups(p);
    panels.splice(best, 1);
    totalWattsInstalled -= p.watts;
    // capped at effMagSize() normally, but never claws back a truck-resupplied ammo pool
    // that's already sitting above that (see reload()'s matching >= check)
    ammo = Math.min(Math.max(effMagSize(), ammo), ammo + 1);
  }
}

function fire() {
  if (reloading || fireCooldown > 0) return;

  // Map 2 replaces the Solar Panel Gun's LMB entirely with the tree cutter — see
  // fireTreeCutter/map2Trees, built only when MAP_ID === 2. Same ammo/cooldown
  // economy as the normal panel gun, just a different action.
  if (MAP_ID === 2) {
    if (ammo <= 0) { reload(); return; }
    fireCooldown = FIRE_COOLDOWN * upgrades.fireRateMul;
    ammo--;
    flashTimer = 0.06;
    muzzleFlash.intensity = 3.5;
    fireTreeCutter();
    return;
  }

  if (blockPlaceMode && upgrades.blockPlacementUnlocked) {
    const target = getPlacementTarget();
    const result = target ? computeBlockCells(target) : null;
    if (!result || result.cells.length === 0) return;
    if (ammo < result.cells.length) { reload(); return; }
    fireCooldown = FIRE_COOLDOWN * upgrades.fireRateMul;
    ammo -= result.cells.length;
    flashTimer = 0.06;
    muzzleFlash.intensity = 3.5;
    result.cells.forEach((p) => placePanel(p, result.normal, true, result.size));
    showToast(`BLOCK PLACED: ${result.cells.length} PANELS`);
    return;
  }

  if (ammo <= 0) { reload(); return; }
  fireCooldown = FIRE_COOLDOWN * upgrades.fireRateMul;
  ammo--;
  flashTimer = 0.06;
  muzzleFlash.intensity = 3.5;

  const target = getPlacementTarget();
  if (target && isSpotFree(target.point, target.size)) {
    placePanel(target.point, target.normal, false, target.size);
  }
}

// ---------- Cable gun — 6mm dual-sheath DC cable, routed to hug surfaces ----------
// Each cable stores its user-placed "raw" waypoints ({point, normal} — the normal is
// whichever surface that waypoint was anchored to). Rendering never draws a straight
// line between two points on *different* surface orientations (e.g. a roof point and
// a wall point) — it inserts a right-angle elbow at the corner first, so the cable
// visually runs along the roof, turns, then runs down the wall, like real conduit.
const CABLE_RADIUS = 0.03;
const CABLE_SNAP_DIST = 0.9;
const CABLE_FLUSH = 0.045; // how far the cable sits off the surface it's hugging
const cableUnitGeo = new THREE.CylinderGeometry(CABLE_RADIUS, CABLE_RADIUS, 1, 6);
const FLEX_CABLE_RADIUS = 0.055; // 16mm 4C+E orange circular flex — inverter-to-inverter links
const flexUnitGeo = new THREE.CylinderGeometry(FLEX_CABLE_RADIUS, FLEX_CABLE_RADIUS, 1, 8);
const cables = []; // { rawPoints: {point,normal}[], points: Vector3[] (flat, for scrap-drop), mesh: Group }
const scraps = [];
let cableActive = null; // { points: {point,normal}[], startAnchor: {type,obj}, endAnchor, previewLine }

function alignCylinderBetween(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 0.001) { mesh.scale.set(0.0001, 0.0001, 0.0001); return; }
  mesh.scale.set(1, len, 1);
  mesh.position.copy(a).lerp(b, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}

// which world axis is "fixed" for points lying on this surface: roofs/ground/crate
// tops are flat in Y, walls are flat in whichever horizontal axis their normal points along
function surfaceAxis(n) {
  if (Math.abs(n.y) > 0.5) return 'y';
  return Math.abs(n.x) >= Math.abs(n.z) ? 'x' : 'z';
}

// a corner point that shares A's fixed axis with B's other two coordinates — walking
// A -> elbow keeps you on surface A, and elbow -> B keeps you on surface B
function elbowBetween(pA, nA, pB) {
  const axis = surfaceAxis(nA);
  const elbow = pB.clone();
  elbow[axis] = pA[axis];
  return elbow;
}

// expands raw waypoints into the actual legs to render, inserting elbow corners
// wherever consecutive waypoints sit on differently-oriented surfaces. Each leg keeps
// the raw-waypoint index it came from so the router tool (gun 3) can map a click on
// the rendered cable back to which raw segment to edit.
function buildRoutedLegs(rawPoints) {
  const legs = [];
  for (let i = 0; i < rawPoints.length - 1; i++) {
    const a = rawPoints[i], b = rawPoints[i + 1];
    if (surfaceAxis(a.normal) === surfaceAxis(b.normal)) {
      legs.push({ a, b, rawSegIndex: i });
    } else {
      const elbowP = elbowBetween(a.point, a.normal, b.point);
      const elbowN = a.normal.clone().add(b.normal).normalize();
      const elbow = { point: elbowP, normal: elbowN };
      legs.push({ a, b: elbow, rawSegIndex: i });
      legs.push({ a: elbow, b, rawSegIndex: i });
    }
  }
  return legs;
}

function buildCableSegment(pt0, n0, pt1, n1, group, rawSegIndex, heavy) {
  const p0 = pt0.clone().addScaledVector(n0, CABLE_FLUSH);
  const p1 = pt1.clone().addScaledVector(n1, CABLE_FLUSH);
  const dir = new THREE.Vector3().subVectors(p1, p0);
  if (dir.length() < 0.02) return;

  if (heavy) {
    // inverter-to-inverter link: one thick bundled orange flex cord, not dual strands
    const s = new THREE.Mesh(flexUnitGeo, matFlexOrange);
    alignCylinderBetween(s, p0, p1);
    s.castShadow = true;
    s.userData.rawSegIndex = rawSegIndex;
    group.add(s);
    return;
  }

  const dirN = dir.clone().normalize();
  const upRef = Math.abs(dirN.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const perp = new THREE.Vector3().crossVectors(dir, upRef).normalize().multiplyScalar(0.045);
  const s1 = new THREE.Mesh(cableUnitGeo, matCableRed);
  alignCylinderBetween(s1, p0.clone().add(perp), p1.clone().add(perp));
  s1.castShadow = true;
  s1.userData.rawSegIndex = rawSegIndex;
  const s2 = new THREE.Mesh(cableUnitGeo, matCableBlack);
  alignCylinderBetween(s2, p0.clone().sub(perp), p1.clone().sub(perp));
  s2.castShadow = true;
  s2.userData.rawSegIndex = rawSegIndex;
  group.add(s1, s2);
}

// (re)builds a cable's rendered mesh from its current rawPoints — used both when a
// run is first finished and whenever the router tool edits an existing run
function rebuildCableMesh(cableObj) {
  if (cableObj.mesh) scene.remove(cableObj.mesh);
  if (cableObj.sparkMesh) { scene.remove(cableObj.sparkMesh); cableObj.sparkMesh = null; }
  const group = new THREE.Group();
  const heavy = !!(cableObj.startAnchor && cableObj.endAnchor
    && cableObj.startAnchor.type === 'inverter' && cableObj.endAnchor.type === 'inverter');
  const legs = buildRoutedLegs(cableObj.rawPoints);
  legs.forEach((leg) => buildCableSegment(leg.a.point, leg.a.normal, leg.b.point, leg.b.normal, group, leg.rawSegIndex, heavy));
  group.userData.cableRef = cableObj;
  scene.add(group);
  cableObj.mesh = group;
  cableObj.points = cableObj.rawPoints.map((p) => p.point);
  cableObj.routedPath = [legs[0].a.point, ...legs.map((leg) => leg.b.point)];
}

function findNearestPanel(point, maxDist) {
  let best = null, bestDist = maxDist;
  for (const p of panels) {
    const d = p.pos.distanceTo(point);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// Cable anchors can be a solar panel OR an inverter — used both to start/extend a
// run and to decide whether a click finishes it.
function findNearestAnchor(point, maxDist) {
  let best = null, bestDist = maxDist, bestType = null;
  for (const p of panels) {
    const d = p.pos.distanceTo(point);
    if (d < bestDist) { bestDist = d; best = p; bestType = 'panel'; }
  }
  for (const inv of inverters) {
    const d = inv.pos.distanceTo(point);
    if (d < bestDist) { bestDist = d; best = inv; bestType = 'inverter'; }
  }
  for (const b of batteries) {
    const d = b.pos.distanceTo(point);
    if (d < bestDist) { bestDist = d; best = b; bestType = 'battery'; }
  }
  for (const s of switchboards) {
    const d = s.pos.distanceTo(point);
    if (d < bestDist) { bestDist = d; best = s; bestType = 'switchboard'; }
  }
  return best ? { obj: best, type: bestType } : null;
}

function anchorThickness(anchor) {
  if (anchor.type === 'panel') return PANEL_THICK;
  if (anchor.type === 'battery') return BATTERY_THICK;
  if (anchor.type === 'switchboard') return SWITCHBOARD_THICK;
  return INVERTER_THICK;
}

// BFS out from an inverter across wired cables to find every panel AND every other
// inverter reachable — inverter-to-inverter cable links now stack capacity together
// (a chained pair of 20kW inverters can jointly carry 40kW), so the whole connected
// network shares one combined watts-vs-capacity budget.
function collectInverterNetwork(startInv) {
  const visitedPanels = new Set();
  const visitedInverters = new Set([startInv]);
  const queue = [startInv];

  // physically-touching panels form one electrical block with no cable needed between
  // them — discovering any one member pulls in the whole block, and every member's own
  // cables get explored too, so one cable from anywhere in the block reaches the rest
  function admitPanel(p) {
    if (visitedPanels.has(p)) return;
    const blockMembers = (p.groupId && groups.has(p.groupId)) ? groups.get(p.groupId) : [p];
    blockMembers.forEach((member) => {
      if (!visitedPanels.has(member)) { visitedPanels.add(member); queue.push(member); }
    });
  }

  while (queue.length) {
    const cur = queue.shift();
    for (const c of cables) {
      let other = null;
      if (c.startAnchor && c.startAnchor.obj === cur) other = c.endAnchor;
      else if (c.endAnchor && c.endAnchor.obj === cur) other = c.startAnchor;
      if (!other) continue;
      if (other.type === 'panel') {
        admitPanel(other.obj);
      } else if (other.type === 'inverter' && !visitedInverters.has(other.obj)) {
        visitedInverters.add(other.obj);
        queue.push(other.obj); // keep traversing — chained inverters join the same network
      }
    }
  }
  let watts = 0;
  visitedPanels.forEach((p) => { watts += p.watts; });
  let capacityWatts = 0;
  visitedInverters.forEach((inv) => { capacityWatts += inverterCapacityKw(inv.tier) * 1000; });
  return { panels: visitedPanels, inverters: visitedInverters, watts, capacityWatts };
}

function raycastWorldHit() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(worldMeshes, false);
  for (const hit of hits) {
    if (hit.distance > MAX_PLACE_DIST) continue;
    if (!hit.face || !hit.face.normal) continue;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { point: hit.point, normal };
  }
  return null;
}

function cableClick() {
  const hit = raycastWorldHit();
  if (!hit) return;

  if (!cableActive) {
    const anchor = findNearestAnchor(hit.point, CABLE_SNAP_DIST);
    if (!anchor) {
      if (upgrades.buildingJumpUnlocked && hit.normal.y > 0.55) { handleJumpClick(hit.point); return; }
      showToast('CABLE MUST START ON A PANEL OR INVERTER');
      return;
    }
    const startPt = anchor.obj.pos.clone().addScaledVector(anchor.obj.normal, anchorThickness(anchor) / 2 + 0.02);
    cableActive = { points: [{ point: startPt, normal: anchor.obj.normal.clone() }], startAnchor: anchor, endAnchor: null, previewLine: null };
    return;
  }

  const anchor = findNearestAnchor(hit.point, CABLE_SNAP_DIST);
  if (anchor) {
    const endPt = anchor.obj.pos.clone().addScaledVector(anchor.obj.normal, anchorThickness(anchor) / 2 + 0.02);
    cableActive.points.push({ point: endPt, normal: anchor.obj.normal.clone() });
    cableActive.endAnchor = anchor;
    finishCable();
  } else {
    cableActive.points.push({ point: hit.point.clone(), normal: hit.normal.clone() });
  }
}

function cableRightClick() {
  if (!cableActive) { removeCableUnderCrosshair(); return; }
  if (cableActive.points.length >= 2) finishCable();
  else cancelCable();
}

function wireAnchor(anchor, cableObj) {
  if (!anchor) return;
  if (anchor.type === 'panel') markPanelConnected(anchor.obj);
  else anchor.obj.wiredCables.add(cableObj);
}

function finishCable() {
  if (!cableActive || cableActive.points.length < 2) { cancelCable(); return; }
  const cableObj = { rawPoints: cableActive.points.slice(), points: [], mesh: null, startAnchor: cableActive.startAnchor, endAnchor: cableActive.endAnchor };
  rebuildCableMesh(cableObj);
  cables.push(cableObj);
  wireAnchor(cableActive.startAnchor, cableObj);
  wireAnchor(cableActive.endAnchor, cableObj);
  if (cableActive.previewLine) scene.remove(cableActive.previewLine);
  cableActive = null;
  refreshAllInverterSigns();
  checkLiveOverloads(); // wiring more array into an already-running inverter can overload it immediately
  updateSwitchboardEnergize();
  showToast('CABLE RUN CONNECTED');
}

function cancelCable() {
  if (!cableActive) return;
  if (cableActive.previewLine) scene.remove(cableActive.previewLine);
  cableActive = null;
}

const matTimberScrap = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.85, metalness: 0.0 });
const matMetalScrap = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.75 });
const matInverterScrap = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.4, metalness: 0.6 });

// five scrap types, each visually distinct: cable = coiled wire (torus), panel = a
// broken shard (flat box), inverter = a scorched electronics chunk (small dark box),
// rock = a grey lump (small dodecahedron), timber = a splintered beam (thin brown box)
function dropScrap(point, type = 'cable') {
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(point.x, point.y + 40, point.z), DOWN);
  const hits = ray.intersectObjects(groundColliders, false);
  const groundY = hits.length ? hits[0].point.y : 0;
  let scrap, restY;
  if (type === 'panel') {
    scrap = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.16), matScrap);
    scrap.rotation.y = rand(0, Math.PI);
    restY = 0.03;
  } else if (type === 'inverter') {
    scrap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.1), matInverterScrap);
    scrap.rotation.y = rand(0, Math.PI);
    restY = 0.07;
  } else if (type === 'rock') {
    scrap = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13), matScrap);
    scrap.rotation.set(rand(0, Math.PI), rand(0, Math.PI), 0);
    restY = 0.11;
  } else if (type === 'timber') {
    scrap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.08), matTimberScrap);
    scrap.rotation.y = rand(0, Math.PI);
    restY = 0.05;
  } else if (type === 'metal') {
    scrap = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 0.1), matMetalScrap);
    scrap.rotation.y = rand(0, Math.PI);
    restY = 0.04;
  } else {
    scrap = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.045, 6, 10), matScrap);
    scrap.rotation.x = Math.PI / 2;
    restY = 0.05;
  }
  scrap.position.set(point.x, groundY + restY, point.z);
  scrap.castShadow = true;
  scrap.receiveShadow = true;
  scrap.userData.scrapType = type;
  scene.add(scrap);
  scraps.push(scrap);
}

function unwireAnchor(anchor, cableObj) {
  if (!anchor || anchor.type === 'panel') return;
  anchor.obj.wiredCables.delete(cableObj);
  if (anchor.type === 'inverter' && anchor.obj.wiredCables.size === 0 && anchor.obj.poweredOn) {
    anchor.obj.poweredOn = false;
    updateInverterIndicator(anchor.obj);
  }
  if (anchor.type === 'inverter' || anchor.type === 'battery' || anchor.type === 'switchboard') updateSwitchboardEnergize();
}

// tears down a cable: drops scrap along its length, unwires either end, removes its mesh
function destroyCable(cableObj, withScrap = true) {
  const idx = cables.indexOf(cableObj);
  if (idx < 0) return;
  if (withScrap) {
    for (let i = 0; i < cableObj.points.length - 1; i++) {
      const mid = cableObj.points[i].clone().lerp(cableObj.points[i + 1], 0.5);
      dropScrap(mid);
    }
  }
  unwireAnchor(cableObj.startAnchor, cableObj);
  unwireAnchor(cableObj.endAnchor, cableObj);
  scene.remove(cableObj.mesh);
  if (cableObj.sparkMesh) scene.remove(cableObj.sparkMesh);
  cables.splice(idx, 1);
  refreshAllInverterSigns();
}

function removeCableUnderCrosshair() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(cables.map((c) => c.mesh), true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !obj.userData.cableRef) obj = obj.parent;
  if (!obj) return;
  destroyCable(obj.userData.cableRef, true);
  showToast('CABLE REMOVED — SCRAP LEFT ON THE GROUND');
}

// ---------- Inverter overload: too much array wattage for the inverter's rated
// capacity -> fire, smoke, the inverter is destroyed, its direct cables burn away,
// and every panel in the array is charred (visually disabled, left in place) ----------
const activeFires = [];
// Fires are static billboards (one shared canvas texture, no per-frame mesh/light
// updates) everywhere except within this radius, which now only covers "basically on
// top of it" — the animated 3D flame/smoke/light group (5 cones + 4 spheres + a
// PointLight) was still the dominant per-fire cost even with the 1-2s flicker
// throttle, and a big multi-building fire could have dozens of these live at once.
// Cranked down hard (16 -> 2.5) rather than removed outright, so a couple of fires
// right next to the player can still glow/flicker, but a burning district stays cheap.
const FIRE_LOD_RADIUS = 2.5;

// one shared texture/material for every far-fire billboard — cheap to instance many of
const matFireBillboard = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const flameGrad = ctx.createRadialGradient(32, 70, 2, 32, 70, 30);
  flameGrad.addColorStop(0, 'rgba(255,225,150,0.95)');
  flameGrad.addColorStop(0.45, 'rgba(255,120,40,0.85)');
  flameGrad.addColorStop(1, 'rgba(255,80,20,0)');
  ctx.fillStyle = flameGrad;
  ctx.fillRect(0, 36, 64, 60);
  const smokeGrad = ctx.createRadialGradient(32, 26, 2, 32, 26, 28);
  smokeGrad.addColorStop(0, 'rgba(70,70,70,0.55)');
  smokeGrad.addColorStop(1, 'rgba(70,70,70,0)');
  ctx.fillStyle = smokeGrad;
  ctx.fillRect(0, 0, 64, 58);
  const tex = new THREE.CanvasTexture(canvas);
  return new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
})();

// persistent:false = a brief decorative flash (used for the "hit while live" zap effect);
// persistent:true = an ongoing fire that stays until removeFireEffect() is called —
// used for burning inverters/panels that need the water gun to put out
// the detailed flame/smoke/light group is expensive (10 meshes + a point light) and is
// only ever built the first time a fire is actually near the player — a whole array
// igniting at once far away costs almost nothing until the player goes to look at it
function buildFireDetail(f) {
  if (f.group) return;
  const group = new THREE.Group();
  const flames = [];
  for (let i = 0; i < 5; i++) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.12 + Math.random() * 0.08, 0.35 + Math.random() * 0.25, 6),
      new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff6a2a : 0xffb347, transparent: true, opacity: 0.85 })
    );
    flame.position.set((Math.random() - 0.5) * 0.35, 0.15 + Math.random() * 0.15, (Math.random() - 0.5) * 0.35);
    group.add(flame);
    flames.push(flame);
  }
  const smokes = [];
  for (let i = 0; i < 4; i++) {
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(0.16 + Math.random() * 0.08, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.5 })
    );
    smoke.position.set((Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3);
    smoke.userData.riseSpeed = 0.35 + Math.random() * 0.25;
    smoke.userData.baseScale = smoke.scale.x;
    group.add(smoke);
    smokes.push(smoke);
  }
  const light = new THREE.PointLight(0xff6a2a, 3.2, 5, 2);
  light.position.y = 0.3;
  group.add(light);
  group.position.copy(f.pos);
  scene.add(group);
  f.group = group;
  f.flames = flames;
  f.smokes = smokes;
  f.light = light;
}

function spawnFireEffect(pos, persistent = false) {
  const farSprite = new THREE.Sprite(matFireBillboard);
  farSprite.position.copy(pos).addScaledVector(new THREE.Vector3(0, 1, 0), 0.3);
  farSprite.scale.set(1.1, 1.65, 1);
  scene.add(farSprite);

  const f = { group: null, flames: null, smokes: null, light: null, farSprite, pos: pos.clone(), t: 4.5, dur: 4.5, persistent, near: null, flickerT: 0, flickerInterval: 1 + Math.random() };
  activeFires.push(f);
  const near = camera.position.distanceToSquared(pos) < FIRE_LOD_RADIUS * FIRE_LOD_RADIUS;
  f.near = near;
  farSprite.visible = !near;
  if (near) buildFireDetail(f);
  return f;
}

function removeFireEffect(f) {
  if (!f) return;
  if (f.group) scene.remove(f.group);
  if (f.farSprite) scene.remove(f.farSprite);
  const idx = activeFires.indexOf(f);
  if (idx >= 0) activeFires.splice(idx, 1);
}

function updateFires(dt) {
  for (let i = activeFires.length - 1; i >= 0; i--) {
    const f = activeFires[i];

    const near = camera.position.distanceToSquared(f.pos) < FIRE_LOD_RADIUS * FIRE_LOD_RADIUS;
    if (near !== f.near) {
      f.near = near;
      if (near) buildFireDetail(f);
      if (f.group) f.group.visible = near;
      f.farSprite.visible = !near;
    }
    if (!near) {
      // far fires skip all per-frame flame/smoke/light animation — the billboard is static
      if (!f.persistent) {
        f.t -= dt;
        if (f.t <= 0) { removeFireEffect(f); }
      }
      continue;
    }

    // Flames/smoke no longer re-randomize every frame (that constant per-frame
    // scale/opacity churn was the "flashing" and the perf cost) — instead they
    // hold a fixed pose and only swap to a new one every 1-2s, like two
    // alternating flame frames and two alternating smoke frames.
    f.flickerT += dt;
    const flip = f.flickerT >= f.flickerInterval;
    if (flip) {
      f.flickerT = 0;
      f.flickerInterval = 1 + Math.random();
      f.flames.forEach((fl) => {
        const s = 0.7 + Math.random() * 0.6;
        fl.scale.set(s, s, s);
      });
      f.smokes.forEach((sm) => {
        sm.userData.frame = sm.userData.frame ? 0 : 1;
        const spread = sm.userData.frame ? 1 : 0.6;
        sm.position.set(
          (Math.random() - 0.5) * 0.3 * spread,
          0.3 + sm.userData.frame * 0.25,
          (Math.random() - 0.5) * 0.3 * spread
        );
        sm.scale.setScalar(sm.userData.baseScale * (sm.userData.frame ? 1.3 : 1));
      });
    }

    if (f.persistent) {
      if (flip) {
        f.flames.forEach((fl) => { fl.material.opacity = 0.85; });
        f.smokes.forEach((sm) => { sm.material.opacity = sm.userData.frame ? 0.25 : 0.5; });
      }
      f.light.intensity = 3.2;
      continue;
    }
    f.t -= dt;
    const life = Math.max(0, f.t / f.dur);
    if (flip) {
      f.flames.forEach((fl) => { fl.material.opacity = 0.85 * life; });
      f.smokes.forEach((sm) => { sm.material.opacity = Math.max(0, (sm.userData.frame ? 0.25 : 0.5) * life); });
    }
    f.light.intensity = 3.2 * life;
    if (f.t <= 0) { removeFireEffect(f); }
  }
}

function burnPanel(p) {
  if (p.burnt) return;
  p.burnt = true;
  const body = p.mesh.children.find((c) => c.material === matPanel || c.material === matPanelLarge);
  if (body) body.material = new THREE.MeshStandardMaterial({ color: 0x120f0d, roughness: 0.95, metalness: 0.1, emissive: 0x1a0800, emissiveIntensity: 0.15 });
}

function destroyInverter(inv) {
  if (inv.fireRecord) { removeFireEffect(inv.fireRecord); inv.fireRecord = null; }
  removeInverterFromWorld(inv);
  if (inv.groupId && inverterGroups.has(inv.groupId)) inverterGroups.get(inv.groupId).delete(inv);
  selectedInverters.delete(inv);
}

// Overload sets the WHOLE connected network (and its array) ON FIRE rather than
// destroying it outright — chained inverters share one electrical bus, so if it's over
// capacity everything on it is at risk. Everything stays live (poweredOn) and burning
// until the player manually turns each inverter off (E) and sprays it and its panels
// out with the water gun; spraying anything still live is fatal.
function triggerInverterOverload(inv, arrayWatts, capacityWatts) {
  const { panels: arrayPanels, inverters: networkInverters } = collectInverterNetwork(inv);
  const unitWord = networkInverters.size > 1 ? `${networkInverters.size}-INVERTER CHAIN` : 'INVERTER';
  showDangerBanner(`⚠ OVERLOAD — ${(arrayWatts / 1000).toFixed(1)}kW ARRAY ON A ${(capacityWatts / 1000).toFixed(0)}kW ${unitWord} — TURN IT OFF AND PUT IT OUT`);

  networkInverters.forEach((netInv) => {
    if (netInv.burning) return;
    netInv.burning = true;
    netInv.spreadTimer = 0;
    netInv.hasSpread = false;
    netInv.fireRecord = spawnFireEffect(netInv.pos.clone(), true);
  });
  let i = 0;
  arrayPanels.forEach((p) => {
    burnPanel(p);
    if (!p.burning) {
      p.burning = true;
      p.spreadTimer = 0;
      p.hasSpread = false;
      if (i < 25) p.fireRecord = spawnFireEffect(p.pos.clone(), true);
    }
    i++;
  });
  // any cable directly between two members of the burning network is now a live hazard
  cables.forEach((c) => {
    const startIn = c.startAnchor && ((c.startAnchor.type === 'inverter' && networkInverters.has(c.startAnchor.obj)) || (c.startAnchor.type === 'panel' && arrayPanels.has(c.startAnchor.obj)));
    const endIn = c.endAnchor && ((c.endAnchor.type === 'inverter' && networkInverters.has(c.endAnchor.obj)) || (c.endAnchor.type === 'panel' && arrayPanels.has(c.endAnchor.obj)));
    if (startIn && endIn) c.burning = true;
  });
}

// which building's footprint (x,z) falls inside — used so fire can spread to every
// array mounted on the same building, not just the one that overloaded
function findBuildingContaining(x, z) {
  const allBoxes = buildingBoxes.concat(megaBuildingBoxes);
  return allBoxes.find((b) => x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1) || null;
}

// generic ignite used only by spreading — doesn't touch switch state, just sets it burning
function igniteObject(type, obj) {
  if (obj.burning) return;
  if (type === 'panel') burnPanel(obj);
  obj.burning = true;
  obj.spreadTimer = 0;
  obj.fireRecord = spawnFireEffect(obj.pos.clone(), true);
}

// ---------- Building fire + gradual collapse ----------
// A burning array's fire ticks every 15s: any directly cable-linked object catches
// instantly (a "whole nearby array" bridges in one tick), while the BUILDING it's
// mounted on lights 2 more of its pre-mapped wall/roof fire blocks per tick — several
// ticks are needed before the whole building is alight. Once fully engulfed it then
// disappears in visible steps, one every 15s, ending as a rubble pile.
const buildingFireState = new Map(); // buildingBox -> { blocks, litCount, demolishing, collapsing, floorGroups, floorIdx, pileTop, rubbleSpawned }
const SPREAD_INTERVAL = 15;
const BUILDING_BLOCKS_PER_TICK = 2;

// evenly-spaced points across all 4 walls + the roof, sized roughly like a panel's
// footprint apart — this is what actually lights up tick by tick, not random spots
function computeBuildingBlocks(b) {
  const blocks = [];
  const midY = Math.max(1.5, b.topY * 0.5);
  const wallRowY = [b.topY * 0.25, b.topY * 0.6].map((y) => Math.max(1.2, y));
  const spots = [0.2, 0.4, 0.6, 0.8];
  wallRowY.forEach((y) => {
    spots.forEach((t) => {
      blocks.push({ x: b.minX, y, z: b.minZ + (b.maxZ - b.minZ) * t });
      blocks.push({ x: b.maxX, y, z: b.minZ + (b.maxZ - b.minZ) * t });
      blocks.push({ x: b.minX + (b.maxX - b.minX) * t, y, z: b.minZ });
      blocks.push({ x: b.minX + (b.maxX - b.minX) * t, y, z: b.maxZ });
    });
  });
  const roofY = b.topY + 0.6;
  [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.5]].forEach(([tx, tz]) => {
    blocks.push({ x: b.minX + (b.maxX - b.minX) * tx, y: roofY, z: b.minZ + (b.maxZ - b.minZ) * tz });
  });
  // shuffle so the lit order doesn't always march the same predictable direction
  for (let i = blocks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  }
  return blocks;
}

function getBuildingFireState(b) {
  let st = buildingFireState.get(b);
  if (!st) {
    st = { blocks: computeBuildingBlocks(b), litCount: 0, demolishing: false, collapsing: false, rubbleSpawned: false, fires: [] };
    buildingFireState.set(b, st);
  }
  return st;
}

function advanceBuildingFire(b) {
  const st = getBuildingFireState(b);
  if (st.demolishing || st.rubbleSpawned) return;
  const toLight = Math.min(BUILDING_BLOCKS_PER_TICK, st.blocks.length - st.litCount);
  for (let i = 0; i < toLight; i++) {
    const spot = st.blocks[st.litCount];
    st.fires.push(spawnFireEffect(new THREE.Vector3(spot.x, spot.y, spot.z), true));
    st.litCount++;
  }
  if (st.litCount >= st.blocks.length) {
    st.demolishing = true;
    showDangerBanner('🔥 BUILDING FULLY ALIGHT — COLLAPSING');
    beginBuildingCollapse(b, st);
  }
}

// once the walls/roof are gone, anything that was mounted on this building (panels,
// inverters, and the cable runs between them) has nothing left to hang on — they fall
// and land in a scrap pile on the ground directly beneath where each was installed,
// rather than being left floating in mid-air
function collapseInstalledEquipment(b) {
  const margin = 0.5;
  const inBounds = (x, z) => x >= b.minX - margin && x <= b.maxX + margin && z >= b.minZ - margin && z <= b.maxZ + margin;

  Array.from(cables).forEach((c) => {
    const sIn = c.startAnchor && inBounds(c.startAnchor.obj.pos.x, c.startAnchor.obj.pos.z);
    const eIn = c.endAnchor && inBounds(c.endAnchor.obj.pos.x, c.endAnchor.obj.pos.z);
    if (sIn || eIn) destroyCable(c, true);
  });

  Array.from(panels).forEach((p) => {
    if (!inBounds(p.pos.x, p.pos.z)) return;
    if (p.fireRecord) removeFireEffect(p.fireRecord);
    scene.remove(p.mesh);
    const gi = groundColliders.indexOf(p.mesh);
    if (gi >= 0) groundColliders.splice(gi, 1);
    const bodyMesh = p.mesh.children.find((c) => c.material === matPanel || c.material === matPanelLarge);
    const wi = worldMeshes.indexOf(bodyMesh);
    if (wi >= 0) worldMeshes.splice(wi, 1);
    removePanelFromGroups(p);
    const idx = panels.indexOf(p);
    if (idx >= 0) panels.splice(idx, 1);
    totalWattsInstalled -= p.watts;
    dropScrap(p.pos, 'panel');
  });

  Array.from(inverters).forEach((inv) => {
    if (!inBounds(inv.pos.x, inv.pos.z)) return;
    if (inv.fireRecord) removeFireEffect(inv.fireRecord);
    removeInverterFromWorld(inv);
    if (inv.groupId && inverterGroups.has(inv.groupId)) inverterGroups.get(inv.groupId).delete(inv);
    selectedInverters.delete(inv);
    dropScrap(inv.pos, 'inverter');
  });
}

// approximate vertical thickness of a box-geometry mesh at its current scale — used to
// figure out how tall each "floor" is once it lands, so the next one stacks on top of it
function meshThickness(mesh) {
  const params = mesh.geometry && mesh.geometry.parameters;
  const h = (params && params.height) || 0.5;
  return h * mesh.scale.y;
}

// the roof+parapets fall together as the topmost floor, then each window-band row falls
// (top row first, since that's what a real floor-by-floor pancake collapse would do),
// and the building shell itself falls last, flattened down into a floor-thick slab so it
// doesn't land as one giant box
function buildCollapseFloors(b) {
  const floors = [];
  const topGroup = [b.roofMesh, ...b.parapetMeshes.map((pm) => pm.mesh)].filter(Boolean);
  if (topGroup.length) floors.push(topGroup);
  [...b.windowMeshes].reverse().forEach((wm) => floors.push([wm]));
  if (b.bodyMesh) {
    b.bodyMesh.scale.y = 0.15;
    b.bodyMesh.position.y = b.topY - (b.topY * 0.15) / 2;
    floors.push([b.bodyMesh]);
  }
  return floors;
}

// once the walls/roof are gone, the remaining structure (roof, parapets, floor bands,
// and finally the shell itself) drops floor by floor, each one landing on top of the
// last, until the whole building has pancaked down into one walkable rubble pile
function beginBuildingCollapse(b, st) {
  // the building's open flames go out the moment it starts collapsing — each one just
  // keeps decaying/smoking for 5 more seconds (reusing the existing non-persistent
  // flame/smoke fade — see updateFires) instead of burning indefinitely
  st.fires.forEach((f) => { f.persistent = false; f.dur = 5; f.t = 5; });
  st.fires = [];

  if (b.roofMesh) {
    const gi = groundColliders.indexOf(b.roofMesh);
    if (gi >= 0) groundColliders.splice(gi, 1);
    const pi = placementSurfaces.indexOf(b.roofMesh);
    if (pi >= 0) placementSurfaces.splice(pi, 1);
  }
  b.parapetMeshes.forEach((pm) => {
    const ci = wallColliders.indexOf(pm.wallBox);
    if (ci >= 0) wallColliders.splice(ci, 1);
  });
  if (b.wallRef) {
    const ci = wallColliders.indexOf(b.wallRef);
    if (ci >= 0) wallColliders.splice(ci, 1);
  }
  if (b.bodyMesh) {
    const wi = worldMeshes.indexOf(b.bodyMesh);
    if (wi >= 0) worldMeshes.splice(wi, 1);
    const pi = placementSurfaces.indexOf(b.bodyMesh);
    if (pi >= 0) placementSurfaces.splice(pi, 1);
  }

  collapseInstalledEquipment(b);

  st.floorGroups = buildCollapseFloors(b);
  st.floorIdx = 0;
  st.pileTop = 0;
  st.fallVy = 0;
  st.fallOffset = 0;
  st.groupStartY = st.floorGroups.length ? st.floorGroups[0].map((m) => m.position.y) : [];
  st.collapsing = st.floorGroups.length > 0;
  if (!st.collapsing) finishDemolition(b, st);
}

// rubble chunks tagged as salvageable, sitting on top of a demolished building's pile —
// the Demo Tool (weapon 8, unlocked the first time any building fully collapses) aims at
// one and converts it into carryable rock/timber scrap; see fireDemoTool below
const salvageableRubble = []; // { mesh, type: 'rock'|'timber' }

function finishDemolition(b, st) {
  st.rubbleSpawned = true;
  st.collapsing = false;
  const midX = (b.minX + b.maxX) / 2, midZ = (b.minZ + b.maxZ) / 2;
  const pileRadius = Math.max(2, Math.min(b.maxX - b.minX, b.maxZ - b.minZ) / 2);
  // plain decorative boulders filling out the pile (not individually salvageable —
  // just bulk, same dodecahedron look as every other rubble pile in the game)
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, rr = Math.random() * pileRadius;
    const rubble = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.5, 1.2)), matScrap);
    rubble.position.set(midX + Math.cos(a) * rr, st.pileTop + rand(0.3, 0.9), midZ + Math.sin(a) * rr);
    rubble.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    rubble.castShadow = true;
    rubble.receiveShadow = true;
    scene.add(rubble);
    groundColliders.push(rubble); // rubble pile stays walkable
  }
  // the salvageable chunks: the collapsed floors break up into a mixed pile of
  // boulders (rock), bent metal beams, and splintered timber — the Demo Tool (or the
  // baseline E interact) converts each one into carryable scrap
  for (let i = 0; i < 12; i++) {
    const type = ['rock', 'metal', 'timber'][i % 3];
    const a = Math.random() * Math.PI * 2, rr = Math.random() * pileRadius;
    const pos = new THREE.Vector3(midX + Math.cos(a) * rr, st.pileTop + rand(0.4, 1.1), midZ + Math.sin(a) * rr);
    let mesh;
    if (type === 'rock') mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.35, 0.6)), matScrap);
    else if (type === 'metal') mesh = new THREE.Mesh(new THREE.BoxGeometry(rand(1.0, 1.8), 0.14, 0.14), matMetalScrap);
    else mesh = new THREE.Mesh(new THREE.BoxGeometry(rand(1.2, 2.0), 0.18, 0.18), matTimberScrap);
    mesh.position.copy(pos);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * 0.4);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    groundColliders.push(mesh);
    salvageableRubble.push({ mesh, type });
  }
  // no auto-unlock here anymore — rock/metal/timber start out only collectible one at
  // a time with E (see handleInteractKey); the Demo Tool itself is a shop purchase
  // gated on 100 given rock + 100 given timber (see maybeAddDemoToolToShop)
}

// per-frame: whichever floor is currently falling accelerates under gravity until its
// lowest point reaches the top of the pile so far, then it's added to the walkable
// rubble and the next floor up starts its fall — a sequential pancake collapse rather
// than the whole building vanishing/shrinking at once
function updateBuildingCollapse(dt) {
  const GRAVITY = 26;
  buildingFireState.forEach((st, b) => {
    if (!st.collapsing || st.rubbleSpawned) return;
    const group = st.floorGroups[st.floorIdx];
    st.fallVy += GRAVITY * dt;
    st.fallOffset += st.fallVy * dt;
    const thickness = Math.max(...group.map(meshThickness));
    const minStartY = Math.min(...st.groupStartY);
    const landY = st.pileTop + thickness / 2;
    let offset = st.fallOffset;
    let landed = false;
    if (minStartY - offset <= landY) {
      offset = minStartY - landY;
      landed = true;
    }
    group.forEach((m, i) => { m.position.y = st.groupStartY[i] - offset; });
    if (landed) {
      group.forEach((m) => {
        m.rotation.x += (Math.random() - 0.5) * 0.25;
        m.rotation.z += (Math.random() - 0.5) * 0.25;
        groundColliders.push(m);
      });
      st.pileTop += thickness;
      st.floorIdx++;
      st.fallVy = 0;
      st.fallOffset = 0;
      if (st.floorIdx >= st.floorGroups.length) {
        finishDemolition(b, st);
      } else {
        st.groupStartY = st.floorGroups[st.floorIdx].map((m) => m.position.y);
      }
    }
  });
}

function spreadTick(type, obj) {
  cables.forEach((c) => {
    let other = null;
    if (c.startAnchor && c.startAnchor.obj === obj) other = c.endAnchor;
    else if (c.endAnchor && c.endAnchor.obj === obj) other = c.startAnchor;
    if (!other) return;
    c.burning = true;
    igniteObject(other.type, other.obj);
  });
  const b = findBuildingContaining(obj.pos.x, obj.pos.z);
  if (b) advanceBuildingFire(b);
}

function updateFireSpread(dt) {
  inverters.forEach((inv) => {
    if (!inv.burning) return;
    inv.spreadTimer = (inv.spreadTimer || 0) + dt;
    if (inv.spreadTimer >= SPREAD_INTERVAL) { inv.spreadTimer -= SPREAD_INTERVAL; spreadTick('inverter', inv); }
  });
  panels.forEach((p) => {
    if (!p.burning) return;
    p.spreadTimer = (p.spreadTimer || 0) + dt;
    if (p.spreadTimer >= SPREAD_INTERVAL) { p.spreadTimer -= SPREAD_INTERVAL; spreadTick('panel', p); }
  });
  updateBuildingCollapse(dt);
}

// spraying a burning-but-switched-off inverter finally, safely tears it down
// every successful extinguish (inverter or panel) counts toward the water gun's
// powder upgrade — see registerExtinguish below
const POWDER_UNLOCK_COUNT = 10;
let extinguishedFireCount = 0;
function registerExtinguish() {
  extinguishedFireCount++;
  if (!upgrades.powderUnlocked && extinguishedFireCount >= POWDER_UNLOCK_COUNT) {
    upgrades.powderUnlocked = true;
    showToast('POWDER UPGRADE UNLOCKED — HOLD RMB WHILE SPRAYING TO SAFE LIVE GEAR WITHOUT GETTING ELECTROCUTED');
  }
}

function extinguishInverter(inv) {
  if (inv.fireRecord) { removeFireEffect(inv.fireRecord); inv.fireRecord = null; }
  showToast('FIRE OUT — INVERTER SAFED');
  Array.from(inv.wiredCables).forEach((c) => destroyCable(c, true)); // cable falls apart, drops scrap
  dropScrap(inv.pos, 'inverter');
  destroyInverter(inv);
  registerExtinguish();
}

// spraying a burning-but-safe (network off) panel puts its fire out; it stays in place,
// permanently charred (see burnPanel), just no longer actively burning
function extinguishPanel(p) {
  if (p.fireRecord) { removeFireEffect(p.fireRecord); p.fireRecord = null; }
  p.burning = false;
  showToast('PANEL FIRE OUT');
  registerExtinguish();
}

// is this panel currently part of ANY powered-on inverter's network? (touching-block +
// cable reachability, mirroring collectInverterNetwork but starting from a panel)
function isPanelElectrified(p) {
  for (const inv of inverters) {
    if (!inv.poweredOn) continue;
    if (collectInverterNetwork(inv).panels.has(p)) return true;
  }
  return false;
}

function isAnchorElectrified(anchor) {
  if (!anchor) return false;
  if (anchor.type === 'inverter') return anchor.obj.poweredOn;
  if (anchor.type === 'switchboard') return anchor.obj.energized;
  if (anchor.type === 'battery') return false; // batteries don't carry mains current in this model
  return isPanelElectrified(anchor.obj);
}

function electrocutePlayer() {
  showDangerBanner('⚡ ELECTROCUTED!');
  camera.position.set(SPAWN_POS.x, effStandHeight(), SPAWN_POS.z);
  velocity.set(0, 0, 0);
  airLaunch.set(0, 0, 0);
  grounded = false;
}

// hitting a still-live inverter/panel with water destroys it outright (in addition to
// electrocuting the player) — no soft burning state, it just fails catastrophically
function destroyLiveInverterHit(inv) {
  Array.from(inv.wiredCables).forEach((c) => destroyCable(c, true));
  dropScrap(inv.pos, 'inverter');
  destroyInverter(inv);
}
function destroyLivePanelHit(p) {
  if (p.fireRecord) removeFireEffect(p.fireRecord);
  const dropPos = p.pos.clone();
  scene.remove(p.mesh);
  const gi = groundColliders.indexOf(p.mesh);
  if (gi >= 0) groundColliders.splice(gi, 1);
  const bodyMesh = p.mesh.children.find((c) => c.material === matPanel || c.material === matPanelLarge);
  const wi = worldMeshes.indexOf(bodyMesh);
  if (wi >= 0) worldMeshes.splice(wi, 1);
  removePanelFromGroups(p);
  const idx = panels.indexOf(p);
  if (idx >= 0) panels.splice(idx, 1);
  totalWattsInstalled -= p.watts;
  dropScrap(dropPos, 'panel');
}

// ---------- Water gun (gun 5, unlocked by donating scrap to the salvage cleric) ----------
const WATER_RANGE = 10;
let waterSprayCooldown = 0;

function raycastWaterTarget() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  let best = null, bestDist = WATER_RANGE;

  const invHits = centerRay.intersectObjects(inverters.map((i) => i.mesh), true);
  if (invHits.length && invHits[0].distance < bestDist) {
    let obj = invHits[0].object;
    while (obj && !inverters.some((i) => i.mesh === obj)) obj = obj.parent;
    const inv = inverters.find((i) => i.mesh === obj);
    if (inv) { best = { type: 'inverter', obj: inv, point: invHits[0].point }; bestDist = invHits[0].distance; }
  }
  const panelHits = centerRay.intersectObjects(panels.map((p) => p.mesh), true);
  if (panelHits.length && panelHits[0].distance < bestDist) {
    let obj = panelHits[0].object;
    while (obj && !panels.some((p) => p.mesh === obj)) obj = obj.parent;
    const p = panels.find((pp) => pp.mesh === obj);
    if (p) { best = { type: 'panel', obj: p, point: panelHits[0].point }; bestDist = panelHits[0].distance; }
  }
  const cableHits = centerRay.intersectObjects(cables.map((c) => c.mesh), true);
  if (cableHits.length && cableHits[0].distance < bestDist) {
    let obj = cableHits[0].object;
    while (obj && !obj.userData.cableRef) obj = obj.parent;
    if (obj) { best = { type: 'cable', obj: obj.userData.cableRef, point: cableHits[0].point }; bestDist = cableHits[0].distance; }
  }
  return best;
}

// powder mode (unlocked at 10 extinguishes, held with RMB while spraying) still
// destroys anything still live, same as plain water — powder just can't fix a live
// circuit either — but it doesn't conduct back to the player, so no electrocution
function waterSprayTick(powder) {
  const hit = raycastWaterTarget();
  if (!hit) return;

  if (hit.type === 'inverter') {
    const inv = hit.obj;
    if (inv.poweredOn) {
      if (powder) {
        showDangerBanner('💨 POWDER SAFED A LIVE INVERTER');
        destroyLiveInverterHit(inv);
      } else {
        showDangerBanner('⚡ ELECTROCUTED — INVERTER WAS STILL LIVE');
        destroyLiveInverterHit(inv);
        electrocutePlayer();
      }
    } else if (inv.burning) {
      extinguishInverter(inv);
    }
  } else if (hit.type === 'panel') {
    const p = hit.obj;
    if (isPanelElectrified(p)) {
      if (powder) {
        showDangerBanner('💨 POWDER SAFED A LIVE PANEL');
        destroyLivePanelHit(p);
      } else {
        showDangerBanner('⚡ ELECTROCUTED — PANEL WAS STILL LIVE');
        destroyLivePanelHit(p);
        electrocutePlayer();
      }
    } else if (p.burning) {
      extinguishPanel(p);
    }
  } else if (hit.type === 'cable') {
    const c = hit.obj;
    if (c.burning && (isAnchorElectrified(c.startAnchor) || isAnchorElectrified(c.endAnchor))) {
      if (powder) {
        showDangerBanner('💨 POWDER SAFED A LIVE CABLE');
        destroyCable(c, false);
      } else {
        showDangerBanner('⚡ ELECTROCUTED — CABLE WAS LIVE AND BURNING');
        destroyCable(c, false);
        electrocutePlayer();
      }
    }
    // an operational (non-burning) cable is always safe to spray, whether live or not
  }
}

function updateWaterGun(dt) {
  if (waterSprayCooldown > 0) waterSprayCooldown -= dt;
  if (!(currentWeapon === 5 && mouseDown && isLocked)) { waterStreamMesh.visible = false; return; }

  const powder = upgrades.powderUnlocked && rmbDown;
  const hit = raycastWaterTarget();
  const gunTip = new THREE.Vector3(0.1, -0.1, -0.4).applyMatrix4(camera.matrixWorld);
  const end = hit ? hit.point : gunTip.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), WATER_RANGE);
  alignCylinderBetween(waterStreamMesh, gunTip, end);
  waterStreamMesh.material.color.setHex(powder ? 0xd8c9a0 : 0x69d6ff);
  waterStreamMesh.visible = true;

  if (waterSprayCooldown <= 0) {
    waterSprayCooldown = 0.2;
    waterSprayTick(powder);
  }
}

// ---------- Electrical spark animation — runs from a panel toward a powered inverter ----------
function poweredInverterEnd(cableObj) {
  if (cableObj.startAnchor && cableObj.startAnchor.type === 'inverter' && cableObj.startAnchor.obj.poweredOn) return 'start';
  if (cableObj.endAnchor && cableObj.endAnchor.type === 'inverter' && cableObj.endAnchor.obj.poweredOn) return 'end';
  return null;
}

function updateElectricalSparks(dt) {
  for (const cableObj of cables) {
    const invEnd = poweredInverterEnd(cableObj);
    if (!invEnd) {
      if (cableObj.sparkMesh) cableObj.sparkMesh.visible = false;
      continue;
    }
    if (!cableObj.sparkMesh) {
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), matSpark);
      const light = new THREE.PointLight(0x9fe8ff, 1.1, 2.2, 2);
      spark.add(light);
      scene.add(spark);
      cableObj.sparkMesh = spark;
      cableObj.sparkT = Math.random();
    }
    const path = cableObj.routedPath;
    if (!path || path.length < 2) continue;
    cableObj.sparkMesh.visible = true;
    cableObj.sparkT = (cableObj.sparkT + dt * 0.55) % 1;
    const tt = invEnd === 'end' ? cableObj.sparkT : 1 - cableObj.sparkT;
    const segCount = path.length - 1;
    const scaled = tt * segCount;
    const segIdx = Math.max(0, Math.min(segCount - 1, Math.floor(scaled)));
    const localT = scaled - segIdx;
    cableObj.sparkMesh.position.copy(path[segIdx]).lerp(path[segIdx + 1], localT);
  }
}

function updateCablePreview() {
  if (!cableActive) return;
  const hit = raycastWorldHit();
  if (cableActive.previewLine) { scene.remove(cableActive.previewLine); cableActive.previewLine = null; }
  const pts = cableActive.points.slice();
  if (hit) pts.push({ point: hit.point, normal: hit.normal });
  if (pts.length < 2) return;
  const legs = buildRoutedLegs(pts);
  const linePts = [legs[0].a.point];
  legs.forEach((leg) => linePts.push(leg.b.point));
  const geo = new THREE.BufferGeometry().setFromPoints(linePts);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xffe066, dashSize: 0.2, gapSize: 0.12 }));
  line.computeLineDistances();
  scene.add(line);
  cableActive.previewLine = line;
}

// ---------- Cable Router (gun 3) — grab an existing cable and bend it around
// obstacles, or straighten it back out ----------
let routerGrab = null; // { cableObj, insertAfter, previewPoint, previewNormal, previewLine }

function findCableLegUnderCrosshair() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(cables.map((c) => c.mesh), true);
  if (!hits.length) return null;
  const hitMesh = hits[0].object;
  let group = hitMesh;
  while (group && !group.userData.cableRef) group = group.parent;
  if (!group) return null;
  return { cableObj: group.userData.cableRef, rawSegIndex: hitMesh.userData.rawSegIndex, point: hits[0].point };
}

function routerLeftDown() {
  const hit = findCableLegUnderCrosshair();
  if (!hit) return;
  routerGrab = { cableObj: hit.cableObj, insertAfter: hit.rawSegIndex, previewPoint: null, previewNormal: null, previewLine: null };
}

function routerLeftUp() {
  if (!routerGrab) return;
  if (routerGrab.previewLine) scene.remove(routerGrab.previewLine);
  if (routerGrab.previewPoint) {
    const { cableObj, insertAfter, previewPoint, previewNormal } = routerGrab;
    cableObj.rawPoints.splice(insertAfter + 1, 0, { point: previewPoint, normal: previewNormal });
    rebuildCableMesh(cableObj);
    showToast('CABLE ROUTED AROUND BEND');
  }
  routerGrab = null;
}

function updateRouterPreview() {
  if (!routerGrab) return;
  const hit = raycastWorldHit();
  if (routerGrab.previewLine) { scene.remove(routerGrab.previewLine); routerGrab.previewLine = null; }
  if (!hit) { routerGrab.previewPoint = null; return; }
  routerGrab.previewPoint = hit.point.clone();
  routerGrab.previewNormal = hit.normal.clone();

  const { cableObj, insertAfter } = routerGrab;
  const a = cableObj.rawPoints[insertAfter], b = cableObj.rawPoints[insertAfter + 1];
  const legsBefore = buildRoutedLegs([a, { point: hit.point, normal: hit.normal }]);
  const legsAfter = buildRoutedLegs([{ point: hit.point, normal: hit.normal }, b]);
  const linePts = [legsBefore[0].a.point];
  legsBefore.concat(legsAfter).forEach((leg) => linePts.push(leg.b.point));
  const geo = new THREE.BufferGeometry().setFromPoints(linePts);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xff9a4d, dashSize: 0.15, gapSize: 0.1 }));
  line.computeLineDistances();
  scene.add(line);
  routerGrab.previewLine = line;
}

function routerRightClick() {
  const hit = findCableLegUnderCrosshair();
  if (!hit) {
    if (upgrades.salvageUnlocked) salvagePanelUnderCrosshair();
    return;
  }
  const { cableObj, rawSegIndex, point } = hit;
  // straighten: drop whichever endpoint of this leg is an interior (non-anchor) waypoint
  const candidates = [rawSegIndex, rawSegIndex + 1].filter((i) => i > 0 && i < cableObj.rawPoints.length - 1);
  if (!candidates.length) { showToast('CANNOT REMOVE A PANEL-ANCHORED END'); return; }
  candidates.sort((i, j) => cableObj.rawPoints[i].point.distanceTo(point) - cableObj.rawPoints[j].point.distanceTo(point));
  cableObj.rawPoints.splice(candidates[0], 1);
  rebuildCableMesh(cableObj);
  showToast('CABLE STRAIGHTENED');
}

// ---------- Progression: cable-connected-panel milestones ----------
const MILESTONES = [
  { count: 100, name: '100 PANELS CONNECTED', apply: () => {} },
  { count: 200, name: '200 PANELS CONNECTED', apply: () => {} },
  { count: 500, name: '500 CONNECTED — SPRINT UPGRADED', apply: () => { upgrades.sprintMul *= 1.35; } },
  { count: 1000, name: '1000 CONNECTED — JUMP UPGRADED', apply: () => { upgrades.jumpMul *= 1.35; } },
  { count: 1200, name: '1200 CONNECTED — PLAYER HEIGHT UPGRADED', apply: () => { upgrades.heightMul *= 1.15; } },
  { count: 1500, name: '1500 CONNECTED — NEW SOLAR PANEL OPTION UNLOCKED! (PRESS X)', apply: () => { upgrades.largePanelUnlocked = true; } },
  { count: 2000, name: '2000 CONNECTED — SALVAGE YARD UNLOCKED!', apply: () => { upgrades.salvageUnlocked = true; } },
  { count: 3000, name: '3000 CONNECTED — GOLD STAR ★ EVERYTHING UPGRADED', apply: () => applyGoldStarBuff() },
  { count: 5000, name: '5000 CONNECTED — GOLD STAR ★★', apply: () => applyGoldStarBuff() },
  { count: 10000, name: '10000 CONNECTED — GOLD STAR ★★★ BUILDING-JUMP UNLOCKED!', apply: () => { applyGoldStarBuff(); upgrades.buildingJumpUnlocked = true; } },
];

function applyGoldStarBuff() {
  upgrades.goldStars++;
  upgrades.sprintMul *= 1.15;
  upgrades.jumpMul *= 1.15;
  upgrades.magBonus += 6;
  upgrades.reloadMul *= 0.85;
  upgrades.fireRateMul *= 0.85;
  const intensity = 0.4 + upgrades.goldStars * 0.35;
  matPanel.emissive.setHex(0xffd54a);
  matPanel.emissiveIntensity = intensity;
  matPanelLarge.emissive.setHex(0xffd54a);
  matPanelLarge.emissiveIntensity = intensity;
}

const connectedPanelsSet = new Set();
let totalConnected = 0;
const reachedMilestones = new Set();

function markPanelConnected(panel) {
  if (connectedPanelsSet.has(panel)) return;
  connectedPanelsSet.add(panel);
  totalConnected++;
  checkMilestones();
}

function checkMilestones() {
  for (const m of MILESTONES) {
    if (totalConnected >= m.count && !reachedMilestones.has(m.count)) {
      reachedMilestones.add(m.count);
      m.apply();
      const stars = upgrades.goldStars > 0 ? '★'.repeat(upgrades.goldStars) : '✦';
      showMilestoneBanner(stars, m.name);
    }
  }
}

function nextMilestone() {
  return MILESTONES.find((m) => !reachedMilestones.has(m.count)) || null;
}

// ---------- Salvage Yard (2000 milestone) ----------
let carriedCableScrap = 0;
let carriedPanelScrap = 0;
let carriedInverterScrap = 0;
let carriedRockScrap = 0;
let carriedTimberScrap = 0;
let carriedMetalScrap = 0;
let credits = 0;
const SCRAP_UNLOCK_CABLE = 1000;
const SCRAP_UNLOCK_PANEL = 500;
let givenCableScrap = 0; // lifetime totals given to the cleric — never decrease, gate the water gun
let givenPanelScrap = 0;
let givenInverterScrap = 0;
let givenRockScrap = 0;
let givenTimberScrap = 0;
let givenMetalScrap = 0;
// once the shop counter is open, given totals double as a spendable pool for weapon
// purchases (see SHOP_ITEMS/purchaseSelectedShopItem below) — they still only ever
// grow from donations, but a purchase can draw them back down
const SHOP_UNLOCK_TOTAL = 3000; // sum of all six given totals

function salvagePanelUnderCrosshair() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(panels.map((p) => p.mesh), true);
  if (!hits.length) return;
  let obj = hits[0].object;
  while (obj && !panels.some((p) => p.mesh === obj)) obj = obj.parent;
  const panel = panels.find((p) => p.mesh === obj);
  if (!panel) return;
  const dropPos = panel.pos.clone();
  scene.remove(panel.mesh);
  const gi = groundColliders.indexOf(panel.mesh);
  if (gi >= 0) groundColliders.splice(gi, 1);
  const bodyMesh = panel.mesh.children.find((c) => c.material === matPanel || c.material === matPanelLarge);
  const wi = worldMeshes.indexOf(bodyMesh);
  if (wi >= 0) worldMeshes.splice(wi, 1);
  removePanelFromGroups(panel);
  const idx = panels.indexOf(panel);
  if (idx >= 0) panels.splice(idx, 1);
  totalWattsInstalled -= panel.watts;
  dropScrap(dropPos, 'panel');
  showToast('PANEL SALVAGED — PICK UP THE SCRAP');
}

function updateCleriSigns() {
  if (!salvageCleric.cableSign) return;
  updateTextSprite(salvageCleric.cableSign, `${givenCableScrap} cable`, { color: '#ffcf8a', border: '#ff9a4d', fontSize: 36 });
  updateTextSprite(salvageCleric.panelSign, `${givenPanelScrap} panel`, { color: '#8aff9e', border: '#4dff88', fontSize: 36 });
  updateTextSprite(salvageCleric.inverterSign, `${givenInverterScrap} inverter`, { color: '#9fd4ff', border: '#4ab0ff', fontSize: 36 });
  updateTextSprite(salvageCleric.rockSign, `${givenRockScrap} rock`, { color: '#d8d8d8', border: '#9a9a9a', fontSize: 36 });
  updateTextSprite(salvageCleric.metalSign, `${givenMetalScrap} metal`, { color: '#c3c8cc', border: '#9aa0a6', fontSize: 36 });
  updateTextSprite(salvageCleric.timberSign, `${givenTimberScrap} timber`, { color: '#e0b078', border: '#a86a3a', fontSize: 36 });
}

function updateSalvagePickups() {
  if (!upgrades.salvageUnlocked) return;
  for (let i = scraps.length - 1; i >= 0; i--) {
    if (scraps[i].position.distanceTo(camera.position) < 1.6) {
      const t = scraps[i].userData.scrapType;
      if (t === 'panel') carriedPanelScrap++;
      else if (t === 'inverter') carriedInverterScrap++;
      else if (t === 'rock') carriedRockScrap++;
      else if (t === 'timber') carriedTimberScrap++;
      else if (t === 'metal') carriedMetalScrap++;
      else carriedCableScrap++;
      scene.remove(scraps[i]);
      scraps.splice(i, 1);
    }
  }
  if (!salvageCleric.pos) return;
  const distToCleric = Math.hypot(camera.position.x - salvageCleric.pos.x, camera.position.z - salvageCleric.pos.z);
  const totalCarried = carriedCableScrap + carriedPanelScrap + carriedInverterScrap + carriedRockScrap + carriedTimberScrap + carriedMetalScrap;
  if (distToCleric < 3 && totalCarried > 0) {
    const earned = totalCarried * 10;
    credits += earned;
    givenCableScrap += carriedCableScrap;
    givenPanelScrap += carriedPanelScrap;
    givenInverterScrap += carriedInverterScrap;
    givenRockScrap += carriedRockScrap;
    givenTimberScrap += carriedTimberScrap;
    givenMetalScrap += carriedMetalScrap;
    showToast(`GAVE ${totalCarried} SCRAP → +${earned} CREDITS`);
    carriedCableScrap = 0;
    carriedPanelScrap = 0;
    carriedInverterScrap = 0;
    carriedRockScrap = 0;
    carriedTimberScrap = 0;
    carriedMetalScrap = 0;
    updateCleriSigns();
    if (!upgrades.waterGunUnlocked && givenCableScrap >= SCRAP_UNLOCK_CABLE && givenPanelScrap >= SCRAP_UNLOCK_PANEL) {
      upgrades.waterGunUnlocked = true;
      showMilestoneBanner('✦', 'WATER GUN UNLOCKED! PRESS 5');
    }
    const givenTotal = givenCableScrap + givenPanelScrap + givenInverterScrap + givenRockScrap + givenTimberScrap + givenMetalScrap;
    if (!upgrades.shopUnlocked && givenTotal >= SHOP_UNLOCK_TOTAL) {
      upgrades.shopUnlocked = true;
      buildShopCounter();
      showMilestoneBanner('🛒', 'WEAPON SHOP OPEN — SECOND COUNTER AT THE SALVAGE YARD');
    }
    maybeAddDemoToolToShop();
    maybeUpgradeDemoTool();
  }
}

// ---------- Building-to-building cable jump (10000 milestone) ----------
let jumpOrigin = null;

function handleJumpClick(point) {
  if (!jumpOrigin) {
    jumpOrigin = point.clone();
    showToast('LAUNCH POINT SET — AIM AT THE TARGET ROOF AND CLICK');
  } else {
    launchPlayerTo(point.clone());
    jumpOrigin = null;
  }
}

function launchPlayerTo(target) {
  const origin = camera.position.clone();
  const disp = new THREE.Vector3().subVectors(target, origin);
  const horizDist = Math.hypot(disp.x, disp.z);
  if (horizDist < 1) { showToast('TARGET TOO CLOSE'); return; }
  const peakHeight = Math.max(5, disp.y * 0.6 + 7);
  const vy0 = Math.sqrt(2 * GRAVITY * peakHeight);
  const tUp = vy0 / GRAVITY;
  const fallDist = Math.max(0, peakHeight - disp.y);
  const tDown = Math.sqrt(2 * fallDist / GRAVITY);
  const totalT = tUp + tDown;
  const horizSpeed = horizDist / Math.max(0.15, totalT);
  const dir = new THREE.Vector3(disp.x, 0, disp.z).normalize();
  velocity.y = vy0;
  airLaunch.set(dir.x * horizSpeed, 0, dir.z * horizSpeed);
  grounded = false;
  showToast('BOOSTED!');
}

const clock = new THREE.Clock();

function updateHud() {
  let weaponLine;
  if (currentWeapon === 1 && MAP_ID === 2) {
    const reloadMsg = reloading ? `<span class="bad">RELOADING…</span>` : `<b>${ammo}</b> / ${effMagSize()}`;
    weaponLine = `<b>1: Tree Cutter</b> — ${reloadMsg}<br>` +
      `<span class="good">LMB</span> aim at a tree to clear it (drops timber scrap) &nbsp; <span class="good">R</span> reload<br>` +
      `clear the trees shading the array so it isn't blocked`;
  } else if (currentWeapon === 1) {
    const reloadMsg = reloading ? `<span class="bad">RELOADING…</span>` : `<b>${ammo}</b> / ${effMagSize()}`;
    const areaMsg = unlockedAreaTool
      ? (areaDrag ? `<span class="good">dragging area…</span>` : `hold <span class="good">RMB</span>, look to far corner, release to build`)
      : `area tool: ${totalPanelsPlaced}/${AREA_TOOL_UNLOCK_COUNT} panels`;
    const sizeMsg = upgrades.largePanelUnlocked
      ? `&nbsp; <span class="key" style="font-size:11px;">X</span> panel: <b>${selectedPanelSize}</b>` : '';
    const blockMsg = upgrades.blockPlacementUnlocked
      ? `&nbsp; <span class="key" style="font-size:11px;">B</span> block mode: <b>${blockPlaceMode ? 'ON' : 'off'}</b>`
      : `&nbsp; block placement: ${totalPanelsPlaced}/${BLOCK_PLACE_UNLOCK_COUNT} panels`;
    const lmbMsg = blockPlaceMode && upgrades.blockPlacementUnlocked
      ? `<span class="good">LMB</span> fire (${BLOCK_PLACE_SIZE * BLOCK_PLACE_SIZE}-panel block, snaps to grid)`
      : `<span class="good">LMB</span> fire (snaps to grid)`;
    weaponLine = `<b>1: Solar Panel Gun</b> — ${reloadMsg}${sizeMsg}${blockMsg}<br>` +
      `${lmbMsg} &nbsp; <span class="good">RMB</span> pick up &nbsp; <span class="good">R</span> reload<br>` +
      areaMsg;
  } else if (currentWeapon === 2) {
    const cableMsg = cableActive
      ? `<span class="good">routing…</span> ${cableActive.points.length} point(s)`
      : (jumpOrigin ? `<span class="good">launch point set</span> — aim at target roof` : 'ready');
    const jumpMsg = upgrades.buildingJumpUnlocked
      ? `<br>no nearby panel? click a roof to set a launch point, click another roof to boost-jump there` : '';
    weaponLine = `<b>2: Cable Gun</b> — ${cableMsg}<br>` +
      `<span class="good">LMB</span> start/extend/finish on a panel, inverter, battery, or switchboard &nbsp; <span class="good">RMB</span> finish run / remove cable<br>` +
      `chain two inverters together with a cable to pool their kW capacity — shown as a heavier orange cable${jumpMsg}`;
  } else if (currentWeapon === 3) {
    const grabMsg = routerGrab ? `<span class="good">bending…</span> release to set` : 'ready';
    const salvageMsg = upgrades.salvageUnlocked ? ` &nbsp; no cable aimed? <span class="good">RMB</span> salvages a panel` : '';
    weaponLine = `<b>3: Cable Router</b> — ${grabMsg}<br>` +
      `<span class="good">LMB</span> hold on a cable, look to a new point, release to bend it there &nbsp; <span class="good">RMB</span> straighten a bend${salvageMsg}`;
  } else if (currentWeapon === 4) {
    const selMsg = selectedInverters.size ? ` — <span class="good">${selectedInverters.size}/3 selected</span>` : '';
    weaponLine = `<b>4: Inverter Gun</b>${selMsg}<br>` +
      `<span class="good">LMB</span> fire onto a wall (snaps to grid) &nbsp; <span class="good">RMB</span> tier-0: pick up · big units: select 3 same-tier to combine<br>` +
      `3 adjacent tier-0 units auto-combine &nbsp; <span class="key" style="font-size:11px;">E</span> switch a wired inverter — <span class="bad">exceed its kW rating and it catches fire</span>`;
  } else if (currentWeapon === 5) {
    const powderMsg = upgrades.powderUnlocked
      ? `<br>&nbsp; <span class="key" style="font-size:11px;">RMB</span> hold while spraying: <b>powder</b> — safes live gear without electrocuting you`
      : `<br>&nbsp; powder upgrade: ${extinguishedFireCount}/${POWDER_UNLOCK_COUNT} fires put out`;
    weaponLine = `<b>5: Water Gun</b> — hold <span class="good">LMB</span> to spray<br>` +
      `switch a burning inverter <b>off</b> first, then spray it and its panels to put the fire out<br>` +
      `<span class="bad">spraying anything still live destroys it and electrocutes you</span> — operational cables are safe to hit${powderMsg}`;
  } else if (currentWeapon === 6) {
    weaponLine = `<b>6: Panel Repair Tool</b><br>` +
      `<span class="good">LMB</span> aim at a charred panel to repair it and restore its wattage`;
  } else if (currentWeapon === 7) {
    weaponLine = `<b>7: Bulk Inverter Gun</b><br>` +
      `<span class="good">LMB</span> fire onto a wall to place a Tier 1 (10kW) inverter directly (snaps to grid)`;
  } else if (currentWeapon === 8) {
    const tier = upgrades.demoToolTier;
    const tierMsg = tier >= 3
      ? `<span class="good">RMB</span> hold + sweep to drag-collect <b>any</b> loose salvage, up to 100/drag`
      : tier >= 2
        ? `<span class="good">LMB</span> also picks up loose cable/panel/inverter scrap directly &nbsp; <span class="good">RMB</span> hold + sweep to drag-collect rubble, up to 100/drag`
        : `next tier at 500 given rock + 500 given timber`;
    weaponLine = `<b>8: Demo Tool</b> (tier ${tier})<br>` +
      `<span class="good">LMB</span> break up a rock/timber rubble chunk for +20<br>${tierMsg}`;
  } else if (currentWeapon === 0) {
    const swbMsg = upgrades.switchboardUnlocked
      ? `<span class="good">RMB</span> fire onto a wall to place a switchboard`
      : `switchboards: ${totalBatteryKwhInstalled}/${SWITCHBOARD_UNLOCK_KWH}kWh batteries installed`;
    weaponLine = `<b>0: Battery & Switchboard Gun</b> — ${totalBatteryKwhInstalled}kWh installed<br>` +
      `<span class="good">LMB</span> fire onto a wall to place a battery (snaps to grid, 5 combine into the next tier) &nbsp; ${swbMsg}<br>` +
      `wire batteries → an inverter → a switchboard (Cable Gun) to energize it and light up its building + nearby street lamps`;
  }

  const stars = '★'.repeat(upgrades.goldStars);
  const nm = nextMilestone();
  const progressMsg = nm ? `next: ${totalConnected}/${nm.count} connected` : 'all milestones reached';
  let map2Line = '';
  if (MAP_ID === 2) {
    const connectedKw = computeMap2ProgressKw();
    map2Line = `<br>Array: <b>${connectedKw.toFixed(0)}/500kW</b> goal (array total <b>1000kW</b>) — wire inverters to the array with the Cable Gun`;
  }
  let salvageLine = '';
  if (upgrades.salvageUnlocked) {
    salvageLine = `<br>Scrap carried: <b>${carriedCableScrap}</b> cable / <b>${carriedPanelScrap}</b> panel / <b>${carriedInverterScrap}</b> inverter / <b>${carriedRockScrap}</b> rock / <b>${carriedMetalScrap}</b> metal / <b>${carriedTimberScrap}</b> timber · Credits: <b>${credits}</b> — give it to the clerics at the Salvage Yard`;
    if (!upgrades.demoToolUnlocked) {
      salvageLine += `<br><span class="key" style="font-size:11px;">E</span> aim at a rock/timber chunk in a demolished building's rubble to pick up 1 at a time`;
    }
    if (!upgrades.waterGunUnlocked) {
      salvageLine += `<br>Water Gun: <b>${Math.min(givenCableScrap, SCRAP_UNLOCK_CABLE)}/${SCRAP_UNLOCK_CABLE}</b> cable, <b>${Math.min(givenPanelScrap, SCRAP_UNLOCK_PANEL)}/${SCRAP_UNLOCK_PANEL}</b> panel given`;
    }
    if (!upgrades.shopUnlocked) {
      const givenTotal = givenCableScrap + givenPanelScrap + givenInverterScrap + givenRockScrap + givenTimberScrap;
      salvageLine += `<br>Weapon shop: <b>${givenTotal}/${SHOP_UNLOCK_TOTAL}</b> total salvage given`;
    }
  }
  const weaponKeys = ['1', '2', '3', '4'];
  if (upgrades.waterGunUnlocked) weaponKeys.push('5');
  if (upgrades.weapon6Unlocked) weaponKeys.push('6');
  if (upgrades.weapon7Unlocked) weaponKeys.push('7');
  if (upgrades.demoToolUnlocked) weaponKeys.push('8');
  if (upgrades.gun0Unlocked) weaponKeys.push('0');
  hud.innerHTML = `${weaponLine}<br>` +
    `${crouching ? '<span class="bad">crouched</span>' : 'standing'} · ${grounded ? 'grounded' : 'airborne'} · <span class="key" style="font-size:11px;">${weaponKeys.join('/')}</span> switch weapon<br>` +
    `Connected: <b>${totalConnected}</b> ${stars} — ${progressMsg}${salvageLine}${map2Line}`;
  const kw = (totalWattsInstalled / 1000).toFixed(2);
  panelCountEl.innerHTML =
    `Panels laid: <b>${totalPanelsPlaced}</b><br>` +
    `Panels connected: <b>${totalConnected}</b><br>` +
    `Installed capacity: <b>${kw} kW</b> · Cables: ${cables.length}<br>` +
    `Inverters: <b>${inverters.length}</b><br>` +
    `Total kWh produced: <b>${totalKwhProduced}</b>`;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

  if (fireCooldown > 0) fireCooldown -= dt;
  if (inverterFireCooldown > 0) inverterFireCooldown -= dt;
  if (batteryFireCooldown > 0) batteryFireCooldown -= dt;
  if (switchboardFireCooldown > 0) switchboardFireCooldown -= dt;
  if (bulkInverterCooldown > 0) bulkInverterCooldown -= dt;
  if (repairCooldown > 0) repairCooldown -= dt;
  if (demoToolCooldown > 0) demoToolCooldown -= dt;
  updateDemoDrag(dt);
  updateElectricalSparks(dt);
  updateInverterProduction(dt);
  updateInverterSignFlash(dt);
  updateWaterGun(dt);
  updateFires(dt);
  updateMovingCars(dt);
  updateWanderers(dt);
  if (MAP_ID === 2) checkMap2Goal();
  updateFireSpread(dt);
  if (flashTimer > 0) { flashTimer -= dt; if (flashTimer <= 0) muzzleFlash.intensity = 0; }
  if (reloading) {
    reloadT -= dt;
    if (reloadT <= 0) { reloading = false; ammo = effMagSize(); }
  }
  if (mouseDown && currentWeapon === 1) fire();

  for (let i = activeGlowPulses.length - 1; i >= 0; i--) {
    const g = activeGlowPulses[i];
    g.t -= dt;
    const op = Math.max(0, g.t / g.dur);
    g.group.children.forEach((c) => { c.material.opacity = op; });
    if (g.t <= 0) {
      scene.remove(g.group);
      activeGlowPulses.splice(i, 1);
    }
  }
  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) streakToastEl.classList.remove('show');
  }
  if (milestoneBannerTimer > 0) {
    milestoneBannerTimer -= dt;
    if (milestoneBannerTimer <= 0) milestoneBannerEl.classList.remove('show');
  }
  if (isLocked) updateSalvagePickups();
  drawMap();
  updateDeliveryTruck();

  if (isLocked) {
    crouching = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');

    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x).multiplyScalar(-1);

    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.add(forward);
    if (keys.has('KeyS')) move.sub(forward);
    if (keys.has('KeyD')) move.add(right);
    if (keys.has('KeyA')) move.sub(right);
    if (move.lengthSq() > 0) move.normalize();

    const sprinting = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !crouching && grounded;
    const speed = crouching ? CROUCH_SPEED : (sprinting ? SPRINT_SPEED * upgrades.sprintMul : WALK_SPEED);

    const newPos = camera.position.clone();
    newPos.x += move.x * speed * dt + airLaunch.x * dt;
    newPos.z += move.z * speed * dt + airLaunch.z * dt;

    const targetEye = crouching ? effCrouchHeight() : effStandHeight();
    const feetY = camera.position.y - currentEyeHeight;
    currentEyeHeight += (targetEye - currentEyeHeight) * Math.min(1, CROUCH_LERP * dt);
    const headY = feetY + currentEyeHeight + 0.15;

    for (const wb of wallColliders) resolveWallPush(newPos, feetY, headY, wb);
    // keep inside the world bounds
    const bound = GROUND_SIZE / 2 - 2;
    newPos.x = Math.max(-bound, Math.min(bound, newPos.x));
    newPos.z = Math.max(-bound, Math.min(bound, newPos.z));

    camera.position.x = newPos.x;
    camera.position.z = newPos.z;

    if (keys.has('Space') && grounded && !crouching) {
      velocity.y = JUMP_SPEED * upgrades.jumpMul;
      grounded = false;
    }
  } else {
    currentEyeHeight += (effStandHeight() - currentEyeHeight) * Math.min(1, CROUCH_LERP * dt);
  }

  // gravity + ground snap
  velocity.y -= GRAVITY * dt;
  camera.position.y += velocity.y * dt;

  raycaster.set(new THREE.Vector3(camera.position.x, camera.position.y + 1.0, camera.position.z), DOWN);
  const hits = raycaster.intersectObjects(groundColliders, false);
  if (hits.length > 0) {
    const groundY = hits[0].point.y;
    if (camera.position.y - currentEyeHeight <= groundY + 0.06) {
      camera.position.y = groundY + currentEyeHeight;
      velocity.y = 0;
      grounded = true;
      airLaunch.set(0, 0, 0);
    } else {
      grounded = false;
    }
  } else {
    grounded = false;
  }

  if (camera.position.y < -20) {
    camera.position.set(SPAWN_POS.x, effStandHeight(), SPAWN_POS.z);
    velocity.set(0, 0, 0);
    airLaunch.set(0, 0, 0);
  }

  // ghost preview / area-drag preview / cable preview at aim point
  if (isLocked) {
    if (currentWeapon === 1 && areaDrag) {
      ghostMesh.visible = false;
      ghostInverterMesh.visible = false;
      updateAreaDragPreview();
    } else if (currentWeapon === 1 && MAP_ID === 2) {
      ghostMesh.visible = false;
      ghostAreaMesh.visible = false;
      ghostInverterMesh.visible = false;
    } else if (currentWeapon === 1) {
      ghostAreaMesh.visible = false;
      ghostInverterMesh.visible = false;
      const target = getPlacementTarget();
      if (target) {
        ghostMesh.visible = true;
        ghostMesh.geometry = target.size > PANEL_SIZE + 0.01 ? ghostGeoLarge : ghostGeo;
        const free = isSpotFree(target.point, target.size);
        ghostMesh.material = free ? matGhostGood : matGhostBad;
        const up = new THREE.Vector3(0, 1, 0);
        ghostMesh.quaternion.setFromUnitVectors(up, target.normal);
        ghostMesh.position.copy(target.point).addScaledVector(target.normal, PANEL_THICK / 2 + 0.01);
      } else {
        ghostMesh.visible = false;
      }
    } else if (currentWeapon === 2) {
      ghostMesh.visible = false;
      ghostAreaMesh.visible = false;
      ghostInverterMesh.visible = false;
      updateCablePreview();
    } else if (currentWeapon === 3) {
      ghostMesh.visible = false;
      ghostAreaMesh.visible = false;
      ghostInverterMesh.visible = false;
      updateRouterPreview();
    } else {
      ghostMesh.visible = false;
      ghostAreaMesh.visible = false;
      const target = getInverterPlacementTarget();
      if (target) {
        ghostInverterMesh.visible = true;
        const free = isInverterSpotFree(target.point);
        ghostInverterMesh.material = free ? matGhostGood : matGhostBad;
        const up = new THREE.Vector3(0, 1, 0);
        ghostInverterMesh.quaternion.setFromUnitVectors(up, target.normal);
        ghostInverterMesh.position.copy(target.point).addScaledVector(target.normal, INVERTER_THICK / 2 + 0.01);
      } else {
        ghostInverterMesh.visible = false;
      }
    }
    updateHud();
  } else {
    ghostMesh.visible = false;
    ghostAreaMesh.visible = false;
    ghostInverterMesh.visible = false;
  }

  renderer.render(scene, camera);
}

// ============================================================================
// Map 2: Solar Farm — Open Range. A separate world built far from Map 1's city
// (see MAP2_ORIGIN) — open ground, a lot of trees shading a fixed 1MW tilted
// array, and a battery hardstand. Weapon 1 is replaced with a tree cutter (see
// fire()/fireTreeCutter); gun 0 (batteries/switchboards) starts pre-unlocked.
// The goal is wiring 500kW of player-placed inverters to the array.
// ============================================================================
const map2Trees = []; // { trunk, leaves, wallBox } — only populated when MAP_ID === 2
const MAP2_ARRAY_TOTAL_W = 1000000;
const MAP2_ARRAY_SECTIONS = 20; // 1MW / 20 = 50kW per anchor
const MAP2_GOAL_KW = 500;
let map2GoalReached = false;

function buildCuttableTree(x, z) {
  const scale = rand(0.9, 1.6);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * scale, 0.24 * scale, 2.2 * scale, 8), matWood);
  trunk.position.set(x, 1.1 * scale, z);
  trunk.castShadow = true;
  scene.add(trunk);
  const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.3 * scale, 2.6 * scale, 8), matLeaf);
  leaves.position.set(x, 2.6 * scale, z);
  leaves.castShadow = true;
  scene.add(leaves);
  const r = 0.2 * scale;
  const wallBox = addWallBox(x - r, x + r, z - r, z + r, 0, 2.2 * scale);
  map2Trees.push({ trunk, leaves, wallBox });
}

function fireTreeCutter() {
  centerRay.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = centerRay.intersectObjects(map2Trees.map((t) => t.trunk), false);
  if (!hits.length || hits[0].distance > MAX_PLACE_DIST) return;
  const idx = map2Trees.findIndex((t) => t.trunk === hits[0].object);
  if (idx < 0) return;
  const tree = map2Trees[idx];
  scene.remove(tree.trunk);
  scene.remove(tree.leaves);
  const wi = wallColliders.indexOf(tree.wallBox);
  if (wi >= 0) wallColliders.splice(wi, 1);
  map2Trees.splice(idx, 1);
  showToast('TREE CLEARED');
}

// sum of inverterCapacityKw for every powered-on inverter actually reaching some of
// the array's wattage — the whole point of this map is wiring inverters INTO the
// array, so "connected" specifically means collectInverterNetwork sees array watts
function computeMap2ProgressKw() {
  let kw = 0;
  inverters.forEach((inv) => {
    if (!inv.poweredOn) return;
    if (collectInverterNetwork(inv).watts > 0) kw += inverterCapacityKw(inv.tier);
  });
  return kw;
}

function checkMap2Goal() {
  if (map2GoalReached) return;
  if (computeMap2ProgressKw() >= MAP2_GOAL_KW) {
    map2GoalReached = true;
    showMilestoneBanner('☀', `${MAP2_GOAL_KW}kW GOAL REACHED — ARRAY SUBSTANTIALLY ONLINE!`);
  }
}

function buildSolarFarmMap() {
  upgrades.gun0Unlocked = true;
  upgrades.switchboardUnlocked = true;

  const ox = MAP2_ORIGIN.x, oz = MAP2_ORIGIN.z;
  const matGrass = new THREE.MeshStandardMaterial({ color: 0x4a6a3a, roughness: 1.0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), matGrass);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(ox, 0, oz);
  ground.receiveShadow = true;
  ground.userData.isSurface = true;
  scene.add(ground);
  groundColliders.push(ground);
  placementSurfaces.push(ground);

  // ---- the fixed 1MW tilted array: 4 rows x 5 columns of large angled sections,
  // each a real `panels[]` entry (groupId: null, so each needs its own separate
  // cable to an inverter — no touching-group shortcut to the whole 1MW at once)
  const arrayCx = ox, arrayCz = oz - 40;
  const cols = 5, rows = 4;
  const spacingX = 9, spacingZ = 7;
  const sectionW = 8, sectionH = 5.5;
  const tiltMat = new THREE.MeshStandardMaterial({ color: 0x1a3a5a, roughness: 0.35, metalness: 0.4 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.6, metalness: 0.5 });
  const wattsPerSection = MAP2_ARRAY_TOTAL_W / MAP2_ARRAY_SECTIONS;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const sx = arrayCx + (c - (cols - 1) / 2) * (sectionW + spacingX);
      const sz = arrayCz + (r - (rows - 1) / 2) * spacingZ;
      const group = new THREE.Group();
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), frameMat);
      post.position.set(0, 1.1, 0);
      const panelMesh = new THREE.Mesh(new THREE.BoxGeometry(sectionW, 0.15, sectionH), tiltMat);
      panelMesh.position.set(0, 2.2, 0);
      panelMesh.rotation.x = -0.35; // tilted toward the sun
      panelMesh.castShadow = true;
      panelMesh.receiveShadow = true;
      group.add(post, panelMesh);
      group.position.set(sx, 0, sz);
      scene.add(group);
      worldMeshes.push(panelMesh);
      const anchorPos = new THREE.Vector3(sx, 2.2, sz + sectionH * 0.4);
      const panelEntry = { mesh: group, pos: anchorPos, normal: new THREE.Vector3(0, 1, 0), groupId: null, size: PANEL_SIZE, watts: wattsPerSection };
      panels.push(panelEntry);
    }
  }
  const arraySign = makeTextSprite(`SOLAR ARRAY — 1000kW`, { fontSize: 44, color: '#ffd54a', border: '#ff9a4d', scale: 0.6 });
  arraySign.position.set(arrayCx, 6.5, arrayCz);
  scene.add(arraySign);

  // ---- battery hardstand: a big paved pad with oversized battery-bank stacks.
  // Purely decorative for now — there's no cable to wire switchboards to it yet;
  // that's an intentionally deferred unlock, not an oversight (see NOTES.md).
  const hardstandCx = ox, hardstandCz = oz + 55;
  const hsMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.9 });
  const hardstand = new THREE.Mesh(new THREE.BoxGeometry(50, 0.08, 30), hsMat);
  hardstand.position.set(hardstandCx, 0.04, hardstandCz);
  hardstand.receiveShadow = true;
  hardstand.userData.isSurface = true;
  scene.add(hardstand);
  groundColliders.push(hardstand);
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x2f6a3a, roughness: 0.5, metalness: 0.3 });
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      const bx = hardstandCx - 20 + i * 8;
      const bz = hardstandCz - 8 + j * 8;
      const bank = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.2, 1.6), bankMat);
      bank.position.set(bx, 1.1, bz);
      bank.castShadow = true;
      bank.receiveShadow = true;
      bank.userData.isSurface = true;
      scene.add(bank);
      groundColliders.push(bank);
      addWallBox(bx - 1.75, bx + 1.75, bz - 0.8, bz + 0.8, 0, 2.2);
    }
  }
  const hsSign = makeTextSprite('BATTERY HARDSTAND', { fontSize: 40, color: '#8affc9', border: '#4dffa0', scale: 0.55 });
  hsSign.position.set(hardstandCx, 5, hardstandCz - 16);
  scene.add(hsSign);

  // ---- lots of trees scattered around, shading the array in places — clear a path
  // through the middle so it's not blocked from the start
  for (let i = 0; i < 130; i++) {
    const tx = ox + rand(-180, 180), tz = oz + rand(-180, 180);
    if (Math.abs(tx - arrayCx) < 35 && Math.abs(tz - arrayCz) < 25) continue; // keep the array clear
    if (Math.abs(tx - hardstandCx) < 30 && Math.abs(tz - hardstandCz) < 20) continue; // keep the hardstand clear
    if (Math.hypot(tx - ox, tz - (oz + 6)) < 8) continue; // keep spawn clear
    buildCuttableTree(tx, tz);
  }
}
if (MAP_ID === 2) buildSolarFarmMap();

animate();

window.__debug = {
  camera, scene, THREE, wallColliders, groundColliders, placementSurfaces, worldMeshes, panels, buildingBoxes, crateBoxes, BUILDING_DEFS,
  cables, groups, cableActive: () => cableActive,
  forceLock: (v) => { isLocked = v; },
  setYawPitch: (y, p) => { yaw = y; pitch = p; },
  pressKey: (code) => keys.add(code),
  releaseKey: (code) => keys.delete(code),
  fire, setWeapon, cableClick, cableRightClick, getPlacementTarget,
  beginAreaDragCandidate, endAreaDrag, commitAreaFill, computeAreaCells,
  areaDrag: () => areaDrag,
  routerLeftDown, routerLeftUp, routerRightClick, updateRouterPreview, routerGrab: () => routerGrab,
  buildRoutedLegs, surfaceAxis,
  getState: () => ({ isLocked, ammo, reloading, fireCooldown, currentWeapon, totalPanelsPlaced, unlockedAreaTool }),
  testFire: () => { fireCooldown = 0; reloading = false; fire(); },
  forceUnlockAreaTool: () => { unlockedAreaTool = true; totalPanelsPlaced = Math.max(totalPanelsPlaced, AREA_TOOL_UNLOCK_COUNT); },
  upgrades, MILESTONES, markPanelConnected, checkMilestones, nextMilestone,
  getProgress: () => ({ totalConnected, goldStars: upgrades.goldStars, carriedCableScrap, carriedPanelScrap, givenCableScrap, givenPanelScrap, credits, reached: Array.from(reachedMilestones) }),
  getWatts: () => totalWattsInstalled,
  bannerState: () => ({ shown: milestoneBannerEl.classList.contains('show'), title: milestoneBannerTitleEl.textContent, stars: milestoneBannerStarsEl.textContent }),
  megaBuildingBoxes, SALVAGE_YARD, scraps, salvagePanelUnderCrosshair, updateSalvagePickups,
  handleJumpClick, launchPlayerTo, jumpOrigin: () => jumpOrigin,
  velocity, airLaunch,
  setPanelSize: (s) => { selectedPanelSize = s; },
  panelSize: () => selectedPanelSize,
  inverters, inverterGroups, fireInverter, pickUpNearestInverter, toggleInverterSwitch, placeInverter,
  getInverterPlacementTarget, testFireInverter: () => { inverterFireCooldown = 0; fireInverter(); },
  findNearestAnchor, updateElectricalSparks,
  collectInverterNetwork, triggerInverterOverload, toggleInverterSelection, handleInverterRightClick,
  selectedInverters, activeFires, updateFires, updateInverterProduction, spawnFireEffect, FIRE_LOD_RADIUS,
  getTotalKwh: () => totalKwhProduced, INVERTER_CAPACITY_KW,
  findInverterUnderCrosshair, destroyCable,
  refreshInverterSign, refreshAllInverterSigns, checkLiveOverloads, updateInverterSignFlash, bandForLoadPercent,
  extinguishInverter, extinguishPanel, isPanelElectrified, isAnchorElectrified, electrocutePlayer,
  destroyLiveInverterHit, destroyLivePanelHit, raycastWaterTarget, waterSprayTick, updateWaterGun,
  spreadTick, updateFireSpread, findBuildingContaining, igniteObject,
  advanceBuildingFire, getBuildingFireState, updateBuildingCollapse, buildingFireState,
  salvageCleric, updateCleriSigns,
  SCRAP_UNLOCK_CABLE, SCRAP_UNLOCK_PANEL,
  removeFireEffect,
  computeBlockCells, blockPlaceMode: () => blockPlaceMode, setBlockPlaceMode: (v) => { blockPlaceMode = v; },
  BLOCK_PLACE_UNLOCK_COUNT, BLOCK_PLACE_SIZE, POWDER_UNLOCK_COUNT,
  extinguishedFireCount: () => extinguishedFireCount, registerExtinguish,
  rmbDown: () => rmbDown, pointOnPlacementSurface,
  spawnDeliveryTruck, updateDeliveryTruck, deliveryTruck: () => deliveryTruck, DELIVERY_AMMO_CAP,
  getAmmo: () => ammo, setAmmo: (v) => { ammo = v; },
  SHOP_ITEMS, SHOP_UNLOCK_TOTAL, buildShopCounter,
  findShopItemUnderCrosshair, selectShopItem, purchaseSelectedShopItem,
  selectedShopItem: () => selectedShopItem, shopItemMeshes,
  firePanelRepair, fireBulkInverter, fireDemoTool, salvageableRubble,
  handleInteractKey, harvestRubbleChunk, harvestScrapPickup, creditScrap,
  demoDrag: () => demoDrag, setDemoDrag: (v) => { demoDrag = v; }, updateDemoDrag,
  maybeAddDemoToolToShop, maybeUpgradeDemoTool, DEMO_TOOL_ITEM, DEMO_TOOL_SHOP_GATE,
  getScrapTotals: () => ({
    carried: { cable: carriedCableScrap, panel: carriedPanelScrap, inverter: carriedInverterScrap, rock: carriedRockScrap, metal: carriedMetalScrap, timber: carriedTimberScrap },
    given: { cable: givenCableScrap, panel: givenPanelScrap, inverter: givenInverterScrap, rock: givenRockScrap, metal: givenMetalScrap, timber: givenTimberScrap },
  }),
  setGiven: (type, v) => {
    if (type === 'cable') givenCableScrap = v;
    else if (type === 'panel') givenPanelScrap = v;
    else if (type === 'inverter') givenInverterScrap = v;
    else if (type === 'rock') givenRockScrap = v;
    else if (type === 'metal') givenMetalScrap = v;
    else if (type === 'timber') givenTimberScrap = v;
  },
  batteries, switchboards, streetLamps, placeBattery, placeSwitchboard,
  fireBattery, fireSwitchboard, updateSwitchboardEnergize, isSwitchboardEnergized,
  applyNearbyLighting, getBatteryPlacementTarget, isBatterySpotFree, isSwitchboardSpotFree,
  getTotalBatteryKwh: () => totalBatteryKwhInstalled,
  getPowerSystemsActivated: () => totalPowerSystemsActivated,
  setPowerSystemsActivated: (v) => { totalPowerSystemsActivated = v; },
  toggleMap, drawMap, mapOpen: () => mapOpen, mapZoom: () => mapZoom,
  setMapZoom: (v) => { mapZoom = v; }, mapCanvas,
  movingCars, updateMovingCars, wanderers, updateWanderers, pointOnLoop, LOOP_R, LOOP_PERIM,
  MAP_ID, MAP2_ORIGIN, map2Trees, fireTreeCutter, computeMap2ProgressKw, checkMap2Goal,
  map2GoalReached: () => map2GoalReached, inverterCapacityKw, MAP2_INVERTER_CAPACITY_KW,
};
