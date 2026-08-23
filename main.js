import * as THREE from 'three';

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
const PANEL_THICK = 0.06;
const MIN_PANEL_SPACING = PANEL_SIZE * 0.92;

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
camera.position.set(0, effStandHeight(), 6);

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
  wallColliders.push({ minX, maxX, minZ, maxZ, minY, maxY });
}

// ---------- Special zones (market square, park+lake, solar farm, salvage yard) — kept clear of buildings/crates ----------
const SALVAGE_YARD = { cx: 70, cz: -110, r: 14 };
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
  addWallBox(minX, maxX, minZ, maxZ, 0, h);

  // simple window strips for visual read
  const winMat = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.3, metalness: 0.4, emissive: 0x0b1a22, emissiveIntensity: 0.3 });
  const rows = Math.max(1, Math.floor(h / 3.2));
  for (let r = 0; r < rows; r++) {
    const wy = 1.8 + r * 3.2;
    if (wy > h - 1) break;
    const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.7, d * 0.96 + 0.02), winMat);
    band.position.set(cx, wy, cz);
    scene.add(band);
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
  const mkParapet = (pw, pd, px, pz) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(pw, parapetH, pd), matRoof);
    p.position.set(px, h + parapetH / 2 + 0.4, pz);
    p.castShadow = true;
    scene.add(p);
    addWallBox(px - pw / 2, px + pw / 2, pz - pd / 2, pz + pd / 2, h + 0.4, h + parapetH + 0.4);
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

  return { minX, maxX, minZ, maxZ, topY: h };
}

const buildingBoxes = BUILDING_DEFS.map(buildBuilding);

// ---------- Fire-escape style stairs so roofs are reachable on foot. Steps climb
// TOWARD the building (lowest step furthest out, highest step right at the roof-
// edge parapet gap) so the run actually connects to the roof surface. ----------
function buildAccessRamp(box, side) {
  const { minX, maxX, minZ, maxZ, topY } = box;
  const steps = Math.max(6, Math.round(topY / 0.9));
  const stepH = topY / steps;
  const stepDepth = 0.85;
  const stepWidth = 2.4;
  const wallGap = 0.5; // horizontal gap between the topmost step and the wall/parapet gap
  const alongX = (side === 'minX' || side === 'maxX');
  const sign = (side === 'minX' || side === 'minZ') ? -1 : 1;
  const wallCoord = alongX ? (side === 'minX' ? minX : maxX) : (side === 'minZ' ? minZ : maxZ);
  const midOther = alongX ? (minZ + maxZ) / 2 : (minX + maxX) / 2;

  for (let i = 0; i < steps; i++) {
    const distFromWall = wallGap + (steps - 1 - i) * stepDepth + stepDepth / 2;
    const y = stepH * (i + 0.5);
    const coord = wallCoord + sign * distFromWall;
    const geo = alongX
      ? new THREE.BoxGeometry(stepDepth * 1.3, stepH, stepWidth)
      : new THREE.BoxGeometry(stepWidth, stepH, stepDepth * 1.3);
    const stepMesh = new THREE.Mesh(geo, matCrate);
    if (alongX) stepMesh.position.set(coord, y, midOther); else stepMesh.position.set(midOther, y, coord);
    stepMesh.castShadow = true;
    stepMesh.receiveShadow = true;
    stepMesh.userData.isSurface = true;
    scene.add(stepMesh);
    groundColliders.push(stepMesh);
  }
}
BUILDING_DEFS.forEach((def, i) => { if (def.stairSide) buildAccessRamp(buildingBoxes[i], def.stairSide); });

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
  buildAccessRamp(box, def.stairSide);
  return box;
});

// ---------- Salvage Yard (unlocked at the 2000-connected milestone) ----------
{
  const { cx, cz, r } = SALVAGE_YARD;
  const yardFloor = new THREE.Mesh(new THREE.CircleGeometry(r, 32), matScrap);
  yardFloor.rotation.x = -Math.PI / 2;
  yardFloor.position.set(cx, 0.02, cz);
  yardFloor.receiveShadow = true;
  yardFloor.userData.isSurface = true;
  scene.add(yardFloor);
  groundColliders.push(yardFloor);

  // chain-link style fence posts ringing the yard
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), matRail);
    post.position.set(px, 1.2, pz);
    scene.add(post);
  }

  // scrap piles decorating the yard
  for (let i = 0; i < 12; i++) {
    const a = rand(0, Math.PI * 2), rr = rand(2, r - 3);
    const px = cx + Math.cos(a) * rr, pz = cz + Math.sin(a) * rr;
    const pile = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(0.5, 1.0)), matScrap);
    pile.position.set(px, 0.5, pz);
    pile.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    pile.castShadow = true;
    scene.add(pile);
  }

  [[-r + 1.5, 0], [r - 1.5, 0], [0, -r + 1.5], [0, r - 1.5]].forEach(([dx, dz]) => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffcf8a, emissive: 0xff9a4d, emissiveIntensity: 1.3 }));
    bulb.position.set(cx + dx, 2.4, cz + dz);
    scene.add(bulb);
    const light = new THREE.PointLight(0xff9a4d, 4, 12, 2);
    light.position.copy(bulb.position);
    scene.add(light);
  });

  // the salvage cleric — give it your scrap by walking up close; its signs track
  // lifetime totals toward the water gun unlock
  salvageCleric.group = buildPerson(cx, cz, 0, 'stand');
  salvageCleric.pos = new THREE.Vector3(cx, 0, cz);
  salvageCleric.cableSign = makeTextSprite('0/1000 cable', { fontSize: 40, color: '#ffcf8a', border: '#ff9a4d', scale: 0.38 });
  salvageCleric.cableSign.position.set(0, 2.4, 0);
  salvageCleric.panelSign = makeTextSprite('0/500 panel', { fontSize: 40, color: '#8aff9e', border: '#4dff88', scale: 0.38 });
  salvageCleric.panelSign.position.set(0, 2.05, 0);
  salvageCleric.group.add(salvageCleric.cableSign, salvageCleric.panelSign);
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
  if (e.code === 'KeyX' && upgrades.largePanelUnlocked && currentWeapon === 1) {
    selectedPanelSize = selectedPanelSize === 'small' ? 'large' : 'small';
    showToast(selectedPanelSize === 'large' ? 'LARGE PANEL SELECTED' : 'STANDARD PANEL SELECTED');
  }
  if (e.code === 'KeyE') toggleInverterSwitch();
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

let mouseDown = false;
document.addEventListener('mousedown', (e) => {
  if (!isLocked) return;
  if (currentWeapon === 1) {
    if (e.button === 0) mouseDown = true;
    if (e.button === 2) {
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
  } else {
    if (e.button === 0) mouseDown = true; // weapon 5: hold to spray
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    mouseDown = false;
    if (currentWeapon === 3) routerLeftUp();
  }
  if (e.button === 2 && currentWeapon === 1 && unlockedAreaTool) endAreaDrag();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Ammo state ----------
let ammo = MAG_SIZE;
let reloading = false;
let reloadT = 0;
let fireCooldown = 0;
let totalPanelsPlaced = 0;
let totalWattsInstalled = 0; // sum of every currently-laid panel's nameplate wattage
const AREA_TOOL_UNLOCK_COUNT = 100;
let unlockedAreaTool = false;

// ---------- Inverters (gun 4) ----------
const inverters = []; // { mesh, pos, normal, tier, groupId, wiredCables: Set<cableObj>, poweredOn, indicatorMat }
const inverterGroups = new Map(); // groupId -> Set<inverterObj>, same-tier adjacency clusters awaiting a 3-way merge
let nextInverterGroupId = 1;
let totalInvertersPlaced = 0;
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
  if (reloading || ammo === effMagSize()) return;
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

  const capacityKw = INVERTER_CAPACITY_KW[Math.min(tier, INVERTER_CAPACITY_KW.length - 1)];
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

function fireInverter() {
  if (inverterFireCooldown > 0) return;
  inverterFireCooldown = 0.28;
  const target = getInverterPlacementTarget();
  if (target && isInverterSpotFree(target.point)) {
    placeInverter(target.point, target.normal, 0);
  }
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
      const point = areaDrag.corner.clone()
        .addScaledVector(areaDrag.right, iu * PANEL_SIZE)
        .addScaledVector(areaDrag.fwd, iv * PANEL_SIZE);
      if (isSpotFree(point)) cells.push(point);
      if (cells.length >= MAX_AREA_CELLS) break;
    }
    if (cells.length >= MAX_AREA_CELLS) break;
  }
  return { cells, normal: areaDrag.normal };
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
    ammo = Math.min(effMagSize(), ammo + 1);
  }
}

function fire() {
  if (reloading || fireCooldown > 0) return;
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
  return best ? { obj: best, type: bestType } : null;
}

function anchorThickness(anchor) { return anchor.type === 'panel' ? PANEL_THICK : INVERTER_THICK; }

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
  visitedInverters.forEach((inv) => { capacityWatts += INVERTER_CAPACITY_KW[Math.min(inv.tier, INVERTER_CAPACITY_KW.length - 1)] * 1000; });
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
  showToast('CABLE RUN CONNECTED');
}

function cancelCable() {
  if (!cableActive) return;
  if (cableActive.previewLine) scene.remove(cableActive.previewLine);
  cableActive = null;
}

function dropScrap(point, type = 'cable') {
  const ray = new THREE.Raycaster();
  ray.set(new THREE.Vector3(point.x, point.y + 40, point.z), DOWN);
  const hits = ray.intersectObjects(groundColliders, false);
  const groundY = hits.length ? hits[0].point.y : 0;
  // cable scrap = coiled wire (torus); panel scrap = a broken shard (flat box) — visually distinct
  const scrap = type === 'panel'
    ? new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.16), matScrap)
    : new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.045, 6, 10), matScrap);
  if (type !== 'panel') scrap.rotation.x = Math.PI / 2;
  else scrap.rotation.y = rand(0, Math.PI);
  scrap.position.set(point.x, groundY + (type === 'panel' ? 0.03 : 0.05), point.z);
  scrap.castShadow = true;
  scrap.receiveShadow = true;
  scrap.userData.scrapType = type;
  scene.add(scrap);
  scraps.push(scrap);
}

function unwireAnchor(anchor, cableObj) {
  if (!anchor || anchor.type !== 'inverter') return;
  anchor.obj.wiredCables.delete(cableObj);
  if (anchor.obj.wiredCables.size === 0 && anchor.obj.poweredOn) {
    anchor.obj.poweredOn = false;
    updateInverterIndicator(anchor.obj);
  }
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
const FIRE_LOD_RADIUS = 16; // full animated fire (incl. the point light) only this close; a
                             // cheap static billboard stands in everywhere else, since a
                             // city-wide spread can have many simultaneous fires at once

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
function spawnFireEffect(pos, persistent = false) {
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
  group.position.copy(pos);
  scene.add(group);

  const farSprite = new THREE.Sprite(matFireBillboard);
  farSprite.position.copy(pos).addScaledVector(new THREE.Vector3(0, 1, 0), 0.3);
  farSprite.scale.set(1.1, 1.65, 1);
  farSprite.visible = false;
  scene.add(farSprite);

  const f = { group, flames, smokes, light, farSprite, pos: pos.clone(), t: 4.5, dur: 4.5, persistent, near: true };
  activeFires.push(f);
  return f;
}

function removeFireEffect(f) {
  if (!f) return;
  scene.remove(f.group);
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
      f.group.visible = near;
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

    if (f.persistent) {
      f.t = (f.t - dt) % f.dur; // loops forever, only used to drive the flicker cycle
      f.flames.forEach((fl) => {
        const s = 0.7 + Math.random() * 0.6;
        fl.scale.set(s, s, s);
        fl.material.opacity = 0.85;
      });
      f.smokes.forEach((sm) => {
        sm.position.y += sm.userData.riseSpeed * dt;
        sm.scale.multiplyScalar(1 + dt * 0.4);
        sm.material.opacity = Math.max(0, 0.5 * (1 - sm.scale.x / (sm.userData.baseScale * 4)));
        if (sm.scale.x > sm.userData.baseScale * 4) { // recycle back to the base once it's puffed out
          sm.position.set((Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3);
          sm.scale.setScalar(sm.userData.baseScale);
        }
      });
      f.light.intensity = 3.2 + Math.sin(f.t * 9) * 0.4;
      continue;
    }
    f.t -= dt;
    const life = Math.max(0, f.t / f.dur);
    f.flames.forEach((fl) => {
      const s = 0.7 + Math.random() * 0.6;
      fl.scale.set(s, s, s);
      fl.material.opacity = 0.85 * life;
    });
    f.smokes.forEach((sm) => {
      sm.position.y += sm.userData.riseSpeed * dt;
      sm.scale.multiplyScalar(1 + dt * 0.4);
      sm.material.opacity = Math.max(0, 0.5 * life);
    });
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
function withinBuildingBox(pos, b) {
  return pos.x >= b.minX - 1 && pos.x <= b.maxX + 1 && pos.z >= b.minZ - 1 && pos.z <= b.maxZ + 1;
}

// generic ignite used only by spreading — doesn't touch switch state, just sets it burning
function igniteObject(type, obj) {
  if (obj.burning) return;
  if (type === 'panel') burnPanel(obj);
  obj.burning = true;
  obj.spreadTimer = 0;
  obj.hasSpread = false;
  obj.fireRecord = spawnFireEffect(obj.pos.clone(), true);
}

// after 30s left unattended, a burning inverter/panel spreads fire to every other
// array on the SAME building (regardless of wiring) and along every cable it's part
// of (regardless of whether that circuit is even powered — fire doesn't care) — this
// can chain across an entire connected city if everything's cabled together
function spreadFireFrom(type, obj) {
  const b = findBuildingContaining(obj.pos.x, obj.pos.z);
  if (b) {
    panels.forEach((p) => { if (!p.burning && withinBuildingBox(p.pos, b)) igniteObject('panel', p); });
    inverters.forEach((inv) => { if (!inv.burning && withinBuildingBox(inv.pos, b)) igniteObject('inverter', inv); });
  }
  cables.forEach((c) => {
    let other = null;
    if (c.startAnchor && c.startAnchor.obj === obj) other = c.endAnchor;
    else if (c.endAnchor && c.endAnchor.obj === obj) other = c.startAnchor;
    if (!other) return;
    c.burning = true;
    igniteObject(other.type, other.obj);
  });
}

function updateFireSpread(dt) {
  inverters.forEach((inv) => {
    if (!inv.burning || inv.hasSpread) return;
    inv.spreadTimer = (inv.spreadTimer || 0) + dt;
    if (inv.spreadTimer >= 30) { inv.hasSpread = true; spreadFireFrom('inverter', inv); }
  });
  panels.forEach((p) => {
    if (!p.burning || p.hasSpread) return;
    p.spreadTimer = (p.spreadTimer || 0) + dt;
    if (p.spreadTimer >= 30) { p.hasSpread = true; spreadFireFrom('panel', p); }
  });
}

// spraying a burning-but-switched-off inverter finally, safely tears it down
function extinguishInverter(inv) {
  if (inv.fireRecord) { removeFireEffect(inv.fireRecord); inv.fireRecord = null; }
  showToast('FIRE OUT — INVERTER SAFED');
  Array.from(inv.wiredCables).forEach((c) => destroyCable(c, true)); // cable falls apart, drops scrap
  destroyInverter(inv);
}

// spraying a burning-but-safe (network off) panel puts its fire out; it stays in place,
// permanently charred (see burnPanel), just no longer actively burning
function extinguishPanel(p) {
  if (p.fireRecord) { removeFireEffect(p.fireRecord); p.fireRecord = null; }
  p.burning = false;
  showToast('PANEL FIRE OUT');
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
  return anchor.type === 'inverter' ? anchor.obj.poweredOn : isPanelElectrified(anchor.obj);
}

function electrocutePlayer() {
  showDangerBanner('⚡ ELECTROCUTED!');
  camera.position.set(0, effStandHeight(), 6);
  velocity.set(0, 0, 0);
  airLaunch.set(0, 0, 0);
  grounded = false;
}

// hitting a still-live inverter/panel with water destroys it outright (in addition to
// electrocuting the player) — no soft burning state, it just fails catastrophically
function destroyLiveInverterHit(inv) {
  Array.from(inv.wiredCables).forEach((c) => destroyCable(c, true));
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

function waterSprayTick() {
  const hit = raycastWaterTarget();
  if (!hit) return;

  if (hit.type === 'inverter') {
    const inv = hit.obj;
    if (inv.poweredOn) {
      showDangerBanner('⚡ ELECTROCUTED — INVERTER WAS STILL LIVE');
      destroyLiveInverterHit(inv);
      electrocutePlayer();
    } else if (inv.burning) {
      extinguishInverter(inv);
    }
  } else if (hit.type === 'panel') {
    const p = hit.obj;
    if (isPanelElectrified(p)) {
      showDangerBanner('⚡ ELECTROCUTED — PANEL WAS STILL LIVE');
      destroyLivePanelHit(p);
      electrocutePlayer();
    } else if (p.burning) {
      extinguishPanel(p);
    }
  } else if (hit.type === 'cable') {
    const c = hit.obj;
    if (c.burning && (isAnchorElectrified(c.startAnchor) || isAnchorElectrified(c.endAnchor))) {
      showDangerBanner('⚡ ELECTROCUTED — CABLE WAS LIVE AND BURNING');
      destroyCable(c, false);
      electrocutePlayer();
    }
    // an operational (non-burning) cable is always safe to spray, whether live or not
  }
}

function updateWaterGun(dt) {
  if (waterSprayCooldown > 0) waterSprayCooldown -= dt;
  if (!(currentWeapon === 5 && mouseDown && isLocked)) { waterStreamMesh.visible = false; return; }

  const hit = raycastWaterTarget();
  const gunTip = new THREE.Vector3(0.1, -0.1, -0.4).applyMatrix4(camera.matrixWorld);
  const end = hit ? hit.point : gunTip.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), WATER_RANGE);
  alignCylinderBetween(waterStreamMesh, gunTip, end);
  waterStreamMesh.visible = true;

  if (waterSprayCooldown <= 0) {
    waterSprayCooldown = 0.2;
    waterSprayTick();
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
let credits = 0;
const SCRAP_UNLOCK_CABLE = 1000;
const SCRAP_UNLOCK_PANEL = 500;
let givenCableScrap = 0; // lifetime totals given to the cleric — never decrease, gate the water gun
let givenPanelScrap = 0;

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
  updateTextSprite(salvageCleric.cableSign, `${Math.min(givenCableScrap, SCRAP_UNLOCK_CABLE)}/${SCRAP_UNLOCK_CABLE} cable`, { color: '#ffcf8a', border: '#ff9a4d', fontSize: 40 });
  updateTextSprite(salvageCleric.panelSign, `${Math.min(givenPanelScrap, SCRAP_UNLOCK_PANEL)}/${SCRAP_UNLOCK_PANEL} panel`, { color: '#8aff9e', border: '#4dff88', fontSize: 40 });
}

function updateSalvagePickups() {
  if (!upgrades.salvageUnlocked) return;
  for (let i = scraps.length - 1; i >= 0; i--) {
    if (scraps[i].position.distanceTo(camera.position) < 1.6) {
      if (scraps[i].userData.scrapType === 'panel') carriedPanelScrap++; else carriedCableScrap++;
      scene.remove(scraps[i]);
      scraps.splice(i, 1);
    }
  }
  if (!salvageCleric.pos) return;
  const distToCleric = Math.hypot(camera.position.x - salvageCleric.pos.x, camera.position.z - salvageCleric.pos.z);
  if (distToCleric < 3 && (carriedCableScrap > 0 || carriedPanelScrap > 0)) {
    const earned = (carriedCableScrap + carriedPanelScrap) * 10;
    credits += earned;
    givenCableScrap += carriedCableScrap;
    givenPanelScrap += carriedPanelScrap;
    showToast(`GAVE ${carriedCableScrap} CABLE + ${carriedPanelScrap} PANEL SCRAP → +${earned} CREDITS`);
    carriedCableScrap = 0;
    carriedPanelScrap = 0;
    updateCleriSigns();
    if (!upgrades.waterGunUnlocked && givenCableScrap >= SCRAP_UNLOCK_CABLE && givenPanelScrap >= SCRAP_UNLOCK_PANEL) {
      upgrades.waterGunUnlocked = true;
      showMilestoneBanner('✦', 'WATER GUN UNLOCKED! PRESS 5');
    }
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
  if (currentWeapon === 1) {
    const reloadMsg = reloading ? `<span class="bad">RELOADING…</span>` : `<b>${ammo}</b> / ${effMagSize()}`;
    const areaMsg = unlockedAreaTool
      ? (areaDrag ? `<span class="good">dragging area…</span>` : `hold <span class="good">RMB</span>, look to far corner, release to build`)
      : `area tool: ${totalPanelsPlaced}/${AREA_TOOL_UNLOCK_COUNT} panels`;
    const sizeMsg = upgrades.largePanelUnlocked
      ? `&nbsp; <span class="key" style="font-size:11px;">X</span> panel: <b>${selectedPanelSize}</b>` : '';
    weaponLine = `<b>1: Solar Panel Gun</b> — ${reloadMsg}${sizeMsg}<br>` +
      `<span class="good">LMB</span> fire (snaps to grid) &nbsp; <span class="good">RMB</span> pick up &nbsp; <span class="good">R</span> reload<br>` +
      areaMsg;
  } else if (currentWeapon === 2) {
    const cableMsg = cableActive
      ? `<span class="good">routing…</span> ${cableActive.points.length} point(s)`
      : (jumpOrigin ? `<span class="good">launch point set</span> — aim at target roof` : 'ready');
    const jumpMsg = upgrades.buildingJumpUnlocked
      ? `<br>no nearby panel? click a roof to set a launch point, click another roof to boost-jump there` : '';
    weaponLine = `<b>2: Cable Gun</b> — ${cableMsg}<br>` +
      `<span class="good">LMB</span> start/extend/finish on a panel or inverter &nbsp; <span class="good">RMB</span> finish run / remove cable<br>` +
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
  } else {
    weaponLine = `<b>5: Water Gun</b> — hold <span class="good">LMB</span> to spray<br>` +
      `switch a burning inverter <b>off</b> first, then spray it and its panels to put the fire out<br>` +
      `<span class="bad">spraying anything still live destroys it and electrocutes you</span> — operational cables are safe to hit`;
  }

  const stars = '★'.repeat(upgrades.goldStars);
  const nm = nextMilestone();
  const progressMsg = nm ? `next: ${totalConnected}/${nm.count} connected` : 'all milestones reached';
  let salvageLine = '';
  if (upgrades.salvageUnlocked) {
    salvageLine = `<br>Scrap carried: <b>${carriedCableScrap}</b> cable / <b>${carriedPanelScrap}</b> panel · Credits: <b>${credits}</b> — give it to the cleric at the Salvage Yard`;
    if (!upgrades.waterGunUnlocked) {
      salvageLine += `<br>Water Gun: <b>${Math.min(givenCableScrap, SCRAP_UNLOCK_CABLE)}/${SCRAP_UNLOCK_CABLE}</b> cable, <b>${Math.min(givenPanelScrap, SCRAP_UNLOCK_PANEL)}/${SCRAP_UNLOCK_PANEL}</b> panel given`;
    }
  }
  const weaponKeys = upgrades.waterGunUnlocked ? '1/2/3/4/5' : '1/2/3/4';
  hud.innerHTML = `${weaponLine}<br>` +
    `${crouching ? '<span class="bad">crouched</span>' : 'standing'} · ${grounded ? 'grounded' : 'airborne'} · <span class="key" style="font-size:11px;">${weaponKeys}</span> switch weapon<br>` +
    `Connected: <b>${totalConnected}</b> ${stars} — ${progressMsg}${salvageLine}`;
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
  updateElectricalSparks(dt);
  updateInverterProduction(dt);
  updateInverterSignFlash(dt);
  updateWaterGun(dt);
  updateFires(dt);
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
    camera.position.set(0, effStandHeight(), 6);
    velocity.set(0, 0, 0);
    airLaunch.set(0, 0, 0);
  }

  // ghost preview / area-drag preview / cable preview at aim point
  if (isLocked) {
    if (currentWeapon === 1 && areaDrag) {
      ghostMesh.visible = false;
      ghostInverterMesh.visible = false;
      updateAreaDragPreview();
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
  spreadFireFrom, updateFireSpread, findBuildingContaining, igniteObject,
  salvageCleric, updateCleriSigns,
  SCRAP_UNLOCK_CABLE, SCRAP_UNLOCK_PANEL,
  removeFireEffect,
};
