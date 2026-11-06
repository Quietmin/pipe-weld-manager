// =====================================================================
// 배관 용접 관리 시스템 - 메인 로직
// =====================================================================
"use strict";

const STORAGE_KEY = "weldmgr_v1";
const STATUS_META = {
  NONE:      { label: "미착수",     color: "#aab3c0" },
  DELIVERED: { label: "스풀입고",   color: "#26a69a" },
  FITUP:     { label: "Fit-up",    color: "#2b7fff" },
  WELDED:    { label: "용접완료",   color: "#ff9800" },
  PASS:      { label: "NDE합격",   color: "#4caf50" },
  FAIL:      { label: "NDE불합격", color: "#f44336" }
};
const NDE_TYPES = ["RT", "UT", "PT", "MT", "VT"];
// DN(mm) -> NPS(inch) : Dia-Inch 집계용
const DN_INCH = { 15:0.5, 20:0.75, 25:1, 32:1.25, 40:1.5, 50:2, 65:2.5, 80:3, 90:3.5, 100:4, 125:5, 150:6, 200:8, 250:10, 300:12, 350:14, 400:16, 450:18, 500:20, 600:24 };
function lineInch(line) { return DN_INCH[line.dn] || line.dn / 25.4; }
function jointInch(line, j) { return j.dn ? (DN_INCH[j.dn] || j.dn / 25.4) : lineInch(line); }
function fmtDI(v) { return (Math.round(v * 10) / 10).toLocaleString(); }

// ---------- 상태 ----------
let state = { records: {}, spools: {} };
let currentView = "dash";                // 첫 화면: 대시보드
let currentSystem = "ALL";               // 배관 계통 필터
let currentLine = PIPE_DATA.lines[0].id; // 기본: 첫 라인
let selectedKey = null;
let showLabels = true;

function jointKey(lineId, no) { return lineId + "|" + no; }
function getRec(key) { return state.records[key] || null; }
function ensureRec(key) {
  if (!state.records[key]) state.records[key] = { fitupDate:"", weldDate:"", welder:"", ndeType:"RT", ndeDate:"", ndeResult:"", repairs: [] };
  if (!state.records[key].repairs) state.records[key].repairs = [];
  return state.records[key];
}
function getSpoolRec(lineId, spool) { return state.spools[lineId + "|" + spool] || null; }

// 시연 모드 (?demo=1) — 예시 데이터를 읽기 전용으로 로드, 실제 저장소를 건드리지 않음
const DEMO_MODE = new URLSearchParams(location.search).has("demo");

function save() {
  if (DEMO_MODE) return; // 시연 모드에서는 저장하지 않음
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ records: state.records, spools: state.spools, savedAt: new Date().toISOString() }));
}
function load() {
  if (DEMO_MODE && typeof DEMO_DATA !== "undefined") {
    state.records = JSON.parse(JSON.stringify(DEMO_DATA.records));
    state.spools = JSON.parse(JSON.stringify(DEMO_DATA.spools));
    return;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const d = JSON.parse(raw); state.records = d.records || {}; state.spools = d.spools || {}; }
  } catch (e) { console.warn("저장 데이터 로드 실패", e); }
}

// ---------- 상태 판정 ----------
// Field 조인트: 미착수 → Fit-up → 용접완료 → NDE합격/불합격 (+Repair)
// Shop 조인트: 스풀 입고일 기준 "스풀입고", 개별 실적 입력 시 그 기준으로 표시
function jointStatus(lineId, j) {
  const rec = getRec(jointKey(lineId, j.no));
  if (rec) {
    const reps = rec.repairs || [];
    const last = reps.length ? reps[reps.length - 1] : null;
    if (last && last.result === "합격") return "PASS";
    if (last && last.result === "불합격") return "FAIL";
    if (rec.ndeResult === "불합격") return "FAIL"; // 보수 진행 중이어도 재검 합격 전까지 불합격 표시
    if (rec.ndeResult === "합격") return "PASS";
    if (rec.weldDate) return "WELDED";
    if (rec.fitupDate) return "FITUP";
  }
  if (j.type === "S") {
    // Field 조인트가 아닌 Shop 조인트는 스풀 입고 여부로 표시 (스풀 경계 표기 "S01/S02"는 해당 없음)
    const sp = getSpoolRec(lineId, j.spool);
    if (sp && sp.deliveryDate) return "DELIVERED";
  }
  return "NONE";
}

function effectiveNdeResult(rec) {
  if (!rec) return "";
  const reps = rec.repairs || [];
  if (reps.length) {
    const last = reps[reps.length - 1];
    if (last.result) return last.result + " (R" + reps.length + ")";
    if (rec.ndeResult === "불합격") return "불합격→보수중";
  }
  return rec.ndeResult || "";
}

// ---------- 계통 ----------
// 계통 코드: line.system 지정값 우선, 없으면 라인번호 2번째 블록 (예: 150-FG1-GK1-00006 → FG1)
function lineSystem(line) {
  if (line.system) return line.system;
  const parts = line.id.split("-");
  return parts.length > 1 ? parts[1] : line.id;
}
function allSystems() {
  const map = {}; // code -> {code, name, count}
  PIPE_DATA.lines.forEach(l => {
    const c = lineSystem(l);
    if (!map[c]) map[c] = { code: c, name: l.systemName || "", count: 0 };
    map[c].count++;
    if (!map[c].name && l.systemName) map[c].name = l.systemName;
  });
  return Object.values(map).sort((a, b) => a.code.localeCompare(b.code));
}
function systemLines() {
  return currentSystem === "ALL" ? PIPE_DATA.lines : PIPE_DATA.lines.filter(l => lineSystem(l) === currentSystem);
}
function visibleLines() {
  const base = systemLines();
  return currentLine === "ALL" ? base : base.filter(l => l.id === currentLine);
}

// =====================================================================
// 3D 뷰어 (Three.js)
// =====================================================================
let scene, camera, renderer, controls, raycaster;
const lineGroups = {};   // lineId -> THREE.Group
const jointMeshes = [];  // 모든 조인트 메쉬
const meshByKey = {};    // key -> mesh
let selectRing = null;
const LINE_OFFSET_Z = 10; // 라인 간 배치 간격 (m)

function mmToVec(line, lineIdx, p) {
  // [E,N,EL](mm) -> three.js (x=E, y=EL, z=-N) m
  // line.origin([E,N,EL] 전역 기준좌표)이 있으면 실좌표로 배치되어 같은 계통 라인이 실제 위치 관계로 연결됨.
  // 없으면 라인별 간격(LINE_OFFSET_Z)으로 나란히 배치.
  if (line.origin) {
    return new THREE.Vector3(
      (p[0] + line.origin[0]) / 1000,
      (p[2] + line.origin[2]) / 1000,
      -(p[1] + line.origin[1]) / 1000
    );
  }
  const row = lineIdx % 12, col = Math.floor(lineIdx / 12);
  return new THREE.Vector3(p[0] / 1000 + col * 60, p[2] / 1000, -p[1] / 1000 + row * LINE_OFFSET_Z);
}

function init3D() {
  const canvas = document.getElementById("canvas3d");
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputEncoding = THREE.sRGBEncoding;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2430);
  scene.fog = new THREE.Fog(0x1d2430, 120, 320);

  camera = new THREE.PerspectiveCamera(55, 2, 0.1, 500);
  camera.position.set(15, 18, 25);

  controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x3c4654, 1.25));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(20, 40, 15);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0x88aaff, 0.35); // 반대편 보조광
  dir2.position.set(-25, 20, -20);
  scene.add(dir2);

  const grid = new THREE.GridHelper(120, 60, 0x3a4658, 0x27303e);
  grid.position.y = 0;
  scene.add(grid);

  raycaster = new THREE.Raycaster();

  // 선택 링
  selectRing = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.55 })
  );
  selectRing.visible = false;
  scene.add(selectRing);

  buildAllLines();

  canvas.addEventListener("pointerdown", e => { canvas._downXY = [e.clientX, e.clientY]; });
  canvas.addEventListener("pointerup", e => {
    const d = canvas._downXY;
    if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return; // 드래그 제외
    pick(e);
  });
  window.addEventListener("resize", resize3D);
  resize3D();
  animate();
}

const _lblCache = new Map();
function makeLabelSprite(text, color) {
  const key = text + "|" + (color || "");
  if (_lblCache.has(key)) {
    const sp0 = new THREE.Sprite(new THREE.SpriteMaterial({ map: _lblCache.get(key), depthTest: false, transparent: true }));
    sp0.scale.set(1.6, 0.8, 1);
    return sp0;
  }
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.font = "bold 40px 'Segoe UI', sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(10,13,18,0.75)";
  const w = ctx.measureText(text).width + 24;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect((128 - w) / 2, 6, w, 52, 10) : ctx.rect((128 - w) / 2, 6, w, 52);
  ctx.fill();
  ctx.fillStyle = color || "#fff";
  ctx.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(cv);
  _lblCache.set(key, tex);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.6, 0.8, 1);
  return sp;
}

function buildAllLines() {
  PIPE_DATA.lines.forEach((line, idx) => {
    const g = new THREE.Group();
    const pipeR = Math.max(line.od * 1.25, 140) / 1000; // 시인성 위해 실제보다 굵게
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9fb0c6, metalness: 0.45, roughness: 0.3 });

    // 파이프 (노드 간 실린더)
    for (let i = 0; i < line.nodes.length - 1; i++) {
      const a = mmToVec(line, idx, line.nodes[i]);
      const b = mmToVec(line, idx, line.nodes[i + 1]);
      const len = a.distanceTo(b);
      if (len < 1e-6) continue;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(pipeR, pipeR, len, 18), pipeMat);
      cyl.position.copy(a).lerp(b, 0.5);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(cyl);
      // 엘보 표현(코너 구)
      const ball = new THREE.Mesh(new THREE.SphereGeometry(pipeR * 1.15, 16, 12), pipeMat);
      ball.position.copy(b);
      g.add(ball);
    }
    // 시작/끝 플랜지 느낌
    const start = mmToVec(line, idx, line.nodes[0]);
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(pipeR * 1.9, pipeR * 1.9, pipeR * 0.9, 20),
      new THREE.MeshStandardMaterial({ color: 0xc3cedd, metalness: 0.5, roughness: 0.35 }));
    flange.position.copy(start);
    const dirv = mmToVec(line, idx, line.nodes[1]).sub(start).normalize();
    flange.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirv);
    g.add(flange);

    // 라인 이름 라벨 (작고 반투명하게 — 화면 가리지 않도록)
    const nameLbl = makeLabelSprite(line.id, "#9fc7ff");
    nameLbl.scale.set(2.6, 1.3, 1);
    nameLbl.material.opacity = 0.6;
    nameLbl.position.copy(start).add(new THREE.Vector3(0, 2.8, 0));
    nameLbl.userData.isLineName = true;
    g.add(nameLbl);

    // 조인트 마커 (어두운 외곽선 포함 — 배관/배경과 구분)
    const jr = Math.max(pipeR * 2.0, 0.3);
    line.joints.forEach(j => {
      const key = jointKey(line.id, j.no);
      const geo = j.type === "F"
        ? new THREE.OctahedronGeometry(jr * 1.25)   // 현장 용접 = 팔면체
        : new THREE.SphereGeometry(jr, 18, 14);     // 공장 용접 = 구
      const mat = new THREE.MeshStandardMaterial({ color: 0xb7bfca, metalness: 0.15, roughness: 0.45, emissive: 0x000000 });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(mmToVec(line, idx, j.pos));
      m.userData = { key, lineId: line.id, no: j.no, type: j.type, baseScale: 1 };
      // 외곽선 (뒤집힌 면)
      const outline = new THREE.Mesh(geo.clone(),
        new THREE.MeshBasicMaterial({ color: 0x0c1016, side: THREE.BackSide }));
      outline.scale.setScalar(1.16);
      m.add(outline);
      g.add(m);
      jointMeshes.push(m);
      meshByKey[key] = m;

      const lbl = makeLabelSprite(String(j.no), j.type === "F" ? "#ffc46b" : "#e6eefc");
      lbl.scale.set(1.25, 0.62, 1);
      lbl.position.copy(m.position).add(new THREE.Vector3(0, jr * 2.9, 0));
      lbl.userData.isJointLabel = true;
      g.add(lbl);
    });

    lineGroups[line.id] = g;
    scene.add(g);
  });
}

function updateJointColors() {
  PIPE_DATA.lines.forEach(line => {
    line.joints.forEach(j => {
      const m = meshByKey[jointKey(line.id, j.no)];
      if (!m) return;
      const st = jointStatus(line.id, j);
      m.userData.status = st;
      m.material.color.set(STATUS_META[st].color);
      if (st === "FAIL") {
        m.material.emissive.set(0xaa1100);
        m.material.emissiveIntensity = 0.8;
      } else {
        // 상태색이 은은히 발광해 어두운 환경에서도 또렷하게
        m.material.emissive.set(STATUS_META[st].color);
        m.material.emissiveIntensity = st === "NONE" ? 0.08 : 0.3;
      }
    });
  });
}

function updateLineVisibility() {
  const visIds = new Set(visibleLines().map(l => l.id));
  PIPE_DATA.lines.forEach(line => {
    lineGroups[line.id].visible = visIds.has(line.id);
  });
  updateLabelVisibility();
}

function updateLabelVisibility() {
  const multi = visibleLines().length > 1; // 라인명은 여러 라인 볼 때만 (단일 라인은 헤더에 이미 표시)
  Object.values(lineGroups).forEach(g => {
    g.children.forEach(c => {
      if (!c.userData) return;
      if (c.userData.isJointLabel) c.visible = showLabels;
      if (c.userData.isLineName) c.visible = multi;
    });
  });
}

function fitView() {
  const box = new THREE.Box3();
  let has = false;
  Object.values(lineGroups).forEach(g => {
    if (!g.visible) return;
    g.children.forEach(c => { if (c.isMesh) { box.expandByObject(c); has = true; } });
  });
  if (!has) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  // 화각(FOV) 기준 거리 계산 — 대상 전체가 화면에 들어오도록
  const fovRad = camera.fov * Math.PI / 180;
  const dist = Math.max((size / 2) / Math.tan(fovRad / 2) * 0.95, 8);
  camera.position.copy(center).add(new THREE.Vector3(dist * 0.6, dist * 0.55, dist * 0.6));
  controls.target.copy(center);
  controls.update();
}

function pick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const xy = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(xy, camera);
  const vis = jointMeshes.filter(m => m.parent.visible);
  const hits = raycaster.intersectObjects(vis, false);
  if (hits.length) selectJoint(hits[0].object.userData.key, true);
}

function resize3D() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  // 불합격 조인트 펄스
  jointMeshes.forEach(m => {
    if (m.userData.status === "FAIL") {
      const s = 1 + 0.3 * Math.abs(Math.sin(t * 4));
      m.scale.setScalar(s);
      m.material.emissiveIntensity = 0.6 + 0.6 * Math.abs(Math.sin(t * 4));
    } else if (m.scale.x !== 1) {
      m.scale.setScalar(1);
    }
  });
  if (selectRing.visible && selectedKey && meshByKey[selectedKey]) {
    selectRing.position.copy(meshByKey[selectedKey].position);
    const r = meshByKey[selectedKey].geometry.boundingSphere ? meshByKey[selectedKey].geometry.boundingSphere.radius : 0.3;
    selectRing.scale.setScalar(r * 1.8 + 0.12 * Math.sin(t * 3));
  }
  controls.update();
  renderer.render(scene, camera);
}

// =====================================================================
// UI 렌더링
// =====================================================================
function renderSystemSelect() {
  const sel = document.getElementById("sysSelect");
  const systems = allSystems();
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "ALL";
  optAll.textContent = "전체 계통 (" + PIPE_DATA.lines.length + "개 라인)";
  sel.appendChild(optAll);
  systems.forEach(s => {
    const o = document.createElement("option");
    o.value = s.code;
    o.textContent = s.code + (s.name ? " — " + s.name : "") + " (라인 " + s.count + "개)";
    sel.appendChild(o);
  });
  sel.value = currentSystem;
}

// 라인 선택 드롭다운 (검색형 — 수백 개 라인 대응)
function allLabel() {
  return currentSystem === "ALL" ? "전체 라인" : currentSystem + " 계통 전체";
}
function renderLineTabs() {
  renderSystemSelect();
  const btn = document.getElementById("lpBtn");
  const n = systemLines().length;
  btn.textContent = (currentLine === "ALL" ? allLabel() + " (" + n + "개)" : currentLine) + "  ▾";
  renderLineList();
}
function renderLineList() {
  const list = document.getElementById("lpList");
  const q = document.getElementById("lpSearch").value.trim().toLowerCase();
  const lines = systemLines().filter(l => !q || l.id.toLowerCase().includes(q));
  list.innerHTML = "";
  const pick = id => { currentLine = id; closeLinePicker(); refreshAll(); fitView(); };
  if (!q) {
    const d = document.createElement("div");
    d.className = "lp-item" + (currentLine === "ALL" ? " active" : "");
    d.innerHTML = `<b>📂 ${allLabel()}</b><span class="muted">${systemLines().length}개 모아보기</span>`;
    d.onclick = () => pick("ALL");
    list.appendChild(d);
  }
  lines.forEach(l => {
    const di = statusDiaInch([l]);
    const pct = di.total ? Math.round(di.PASS / di.total * 100) : 0;
    let fails = 0;
    l.joints.forEach(j => { if (jointStatus(l.id, j) === "FAIL") fails++; });
    const d = document.createElement("div");
    d.className = "lp-item" + (currentLine === l.id ? " active" : "");
    d.innerHTML = `<span><b>${l.id}</b> <span class="muted">${l.dn}A</span>${fails ? ` <span style="color:var(--c-fail)">⚠${fails}</span>` : ""}</span>
      <span class="muted">완료 ${pct}%</span>`;
    d.onclick = () => pick(l.id);
    list.appendChild(d);
  });
  const cnt = document.createElement("div");
  cnt.className = "lp-count";
  cnt.textContent = q ? `검색 결과 ${lines.length}개` : `라인 ${lines.length}개`;
  list.appendChild(cnt);
}
function openLinePicker() {
  document.getElementById("lpDrop").classList.add("open");
  const s = document.getElementById("lpSearch");
  s.value = "";
  renderLineList();
  s.focus();
}
function closeLinePicker() {
  document.getElementById("lpDrop").classList.remove("open");
}

function collectJoints() {
  const out = [];
  visibleLines().forEach(line => {
    line.joints.forEach(j => out.push({ line, j, key: jointKey(line.id, j.no), status: jointStatus(line.id, j) }));
  });
  return out;
}

function renderDashboard() {
  const items = collectJoints();
  const cnt = { NONE: 0, DELIVERED: 0, FITUP: 0, WELDED: 0, PASS: 0, FAIL: 0 };
  items.forEach(it => cnt[it.status]++);
  const total = items.length || 1;
  const weldDone = cnt.WELDED + cnt.PASS + cnt.FAIL + cnt.DELIVERED; // 입고 스풀은 공장용접 완료 간주
  const ndeJudged = cnt.PASS + cnt.FAIL;
  const weldRate = Math.round(weldDone / total * 100);
  const passRate = ndeJudged ? Math.round(cnt.PASS / ndeJudged * 100) : 0;

  const db = document.getElementById("dashboard");
  db.innerHTML = "";
  Object.keys(STATUS_META).forEach(st => {
    const c = document.createElement("div");
    c.className = "chip" + (st === "FAIL" ? " fail-chip" + (cnt.FAIL ? " has-fail" : "") : "");
    c.innerHTML = `<span class="dot" style="background:${STATUS_META[st].color}"></span>
      <span class="lbl">${STATUS_META[st].label}</span><span class="val">${cnt[st]}</span>`;
    if (st === "FAIL") c.onclick = () => { document.getElementById("fStatus").value = "FAIL"; renderJointTable(); switchTab("joints"); };
    db.appendChild(c);
  });
  const r1 = document.createElement("div");
  r1.className = "chip rate";
  r1.innerHTML = `<span class="lbl">용접 진행률</span><span class="val">${weldRate}%</span>`;
  db.appendChild(r1);
  const r2 = document.createElement("div");
  r2.className = "chip rate";
  r2.innerHTML = `<span class="lbl">NDE 합격률</span><span class="val">${passRate}%</span>`;
  db.appendChild(r2);
}

function renderJointTable() {
  const tbody = document.querySelector("#jointTable tbody");
  const fs = document.getElementById("fStatus").value;
  const ft = document.getElementById("fType").value;
  const fd = document.getElementById("fDate").value;
  const fk = document.getElementById("fDateKind").value;

  let items = collectJoints();
  if (fs) items = items.filter(it => it.status === fs);
  if (ft) items = items.filter(it => it.j.type === ft);
  if (fd) {
    items = items.filter(it => {
      const r = getRec(it.key);
      if (!r) return false;
      const weldHit = r.weldDate === fd || (r.repairs || []).some(rp => rp.weldDate === fd);
      const ndeHit = r.ndeDate === fd || (r.repairs || []).some(rp => rp.ndeDate === fd);
      if (fk === "weld") return weldHit;
      if (fk === "nde") return ndeHit;
      return weldHit || ndeHit;
    });
  }

  tbody.innerHTML = "";
  items.forEach(it => {
    const r = getRec(it.key);
    const tr = document.createElement("tr");
    if (it.key === selectedKey) tr.classList.add("selected");
    const res = effectiveNdeResult(r);
    tr.innerHTML = `
      <td><span class="st-dot ${it.status === "FAIL" ? "fail" : ""}" style="background:${STATUS_META[it.status].color}"></span><span class="muted" style="font-size:11px">${STATUS_META[it.status].label}</span></td>
      <td><b>${it.j.no}</b>${currentLine === "ALL" ? `<div class="muted" style="font-size:10px">${it.line.dn}A</div>` : ""}</td>
      <td><span class="jtype ${it.j.type}">${it.j.type === "F" ? "Field" : "Shop"}</span></td>
      <td>${it.j.spool}</td>
      <td>${r && r.weldDate ? r.weldDate : '<span class="muted">-</span>'}</td>
      <td>${r && r.welder ? r.welder : '<span class="muted">-</span>'}</td>
      <td>${r && r.ndeDate ? (r.ndeType ? r.ndeType + " " : "") + r.ndeDate : '<span class="muted">-</span>'}</td>
      <td style="color:${res.startsWith("불") ? "var(--c-fail)" : res.startsWith("합") ? "var(--c-pass)" : "var(--muted)"}">${res || "-"}</td>`;
    tr.onclick = () => selectJoint(it.key, false);
    tbody.appendChild(tr);
  });
}

function renderSpools() {
  const el = document.getElementById("tab-spools");
  el.innerHTML = "";
  visibleLines().forEach(line => {
    const title = document.createElement("div");
    title.className = "sec-title";
    title.textContent = line.id + " — 스풀 " + line.spools.length + "개 (공장 제작)";
    el.appendChild(title);
    const tbl = document.createElement("table");
    tbl.innerHTML = `<thead><tr><th>스풀</th><th>Shop 조인트</th><th>입고일</th><th>진행</th></tr></thead>`;
    const tb = document.createElement("tbody");
    line.spools.forEach(sp => {
      const joints = line.joints.filter(j => j.spool === sp);
      const spRec = getSpoolRec(line.id, sp);
      const done = joints.filter(j => ["DELIVERED", "WELDED", "PASS"].includes(jointStatus(line.id, j))).length;
      const pct = joints.length ? Math.round(done / joints.length * 100) : (spRec && spRec.deliveryDate ? 100 : 0);
      const tr = document.createElement("tr");
      tr.style.cursor = "default";
      tr.innerHTML = `
        <td><b>${sp}</b></td>
        <td class="muted">${joints.length ? joints.map(j => j.no).join(", ") : "-"}</td>
        <td><input type="date" class="cell-date" value="${spRec && spRec.deliveryDate ? spRec.deliveryDate : ""}"></td>
        <td><div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div></td>`;
      tr.querySelector("input").onchange = ev => {
        const k = line.id + "|" + sp;
        if (!state.spools[k]) state.spools[k] = {};
        state.spools[k].deliveryDate = ev.target.value;
        save(); refreshAll(false);
        toast(sp + " 입고일 저장: " + (ev.target.value || "삭제"));
      };
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    el.appendChild(tbl);
  });
}

// ---------- 용접사 통계 ----------
function welderStats(lines) {
  const map = {}; // name -> {welds, judged, fails}
  const add = name => {
    if (!map[name]) map[name] = { welds: 0, judged: 0, fails: 0 };
    return map[name];
  };
  (lines || systemLines()).forEach(line => {
    line.joints.forEach(j => {
      const r = getRec(jointKey(line.id, j.no));
      if (!r) return;
      if (r.weldDate && r.welder) {
        const w = add(r.welder.trim());
        w.welds++;
        if (r.ndeResult === "합격" || r.ndeResult === "불합격") {
          w.judged++;
          if (r.ndeResult === "불합격") w.fails++;
        }
      }
      (r.repairs || []).forEach(rp => {
        if (rp.weldDate && rp.welder) {
          const w = add(rp.welder.trim());
          w.welds++;
          if (rp.result === "합격" || rp.result === "불합격") {
            w.judged++;
            if (rp.result === "불합격") w.fails++;
          }
        }
      });
    });
  });
  return map;
}

function renderStats() {
  const el = document.getElementById("tab-stats");
  el.innerHTML = "";

  // 라인별 진척
  const t1 = document.createElement("div");
  t1.className = "sec-title";
  t1.textContent = "라인별 진척 현황" + (currentSystem !== "ALL" ? " — " + currentSystem + " 계통" : "");
  el.appendChild(t1);
  systemLines().forEach(line => {
    const sts = line.joints.map(j => jointStatus(line.id, j));
    const total = sts.length;
    const weld = sts.filter(s => ["WELDED", "PASS", "FAIL", "DELIVERED"].includes(s)).length;
    const pass = sts.filter(s => s === "PASS").length;
    const fail = sts.filter(s => s === "FAIL").length;
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <b>${line.id}</b><span class="muted">${line.dn}A${line.rev ? " · Rev." + line.rev : ""} · 조인트 ${total}개</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="progress-wrap" style="flex:1"><div class="progress-bar" style="width:${Math.round(weld / total * 100)}%"></div></div>
        <span>용접 ${Math.round(weld / total * 100)}%</span>
      </div>
      <div class="muted" style="margin-top:5px">NDE 합격 ${pass} · <span style="color:${fail ? "var(--c-fail)" : "inherit"}">불합격 ${fail}</span></div>`;
    el.appendChild(card);
  });

  // 용접사별 불합격률
  const t2 = document.createElement("div");
  t2.className = "sec-title";
  t2.textContent = "용접사별 실적 / 불합격률 (Repair 용접 포함)";
  el.appendChild(t2);
  const stats = welderStats();
  const names = Object.keys(stats).sort((a, b) => stats[b].welds - stats[a].welds);
  if (!names.length) {
    const d = document.createElement("div");
    d.className = "stat-card muted";
    d.textContent = "용접 실적이 아직 없습니다. 조인트에 용접일·용접사를 입력하면 자동 집계됩니다.";
    el.appendChild(d);
  } else {
    const tbl = document.createElement("table");
    tbl.innerHTML = `<thead><tr><th>용접사</th><th>용접 건수</th><th>NDE 판정</th><th>불합격</th><th>불합격률</th></tr></thead>`;
    const tb = document.createElement("tbody");
    names.forEach(n => {
      const s = stats[n];
      const rate = s.judged ? (s.fails / s.judged * 100) : null;
      const tr = document.createElement("tr");
      tr.style.cursor = "default";
      tr.innerHTML = `
        <td><b>${n}</b></td>
        <td>${s.welds}</td>
        <td>${s.judged}</td>
        <td style="color:${s.fails ? "var(--c-fail)" : "inherit"}">${s.fails}</td>
        <td class="${rate === null ? "muted" : rate >= 5 ? "fail-rate-high" : "fail-rate-ok"}">${rate === null ? "판정 전" : rate.toFixed(1) + "%"}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    el.appendChild(tbl);
    const note = document.createElement("div");
    note.className = "sec-title";
    note.textContent = "※ 불합격률 = 불합격 ÷ NDE 판정 건수. 5% 이상 빨간색 표시.";
    el.appendChild(note);
  }

  // 불합격 조인트 목록
  const fails = [];
  systemLines().forEach(line => line.joints.forEach(j => {
    if (jointStatus(line.id, j) === "FAIL") fails.push({ line, j });
  }));
  if (fails.length) {
    const t3 = document.createElement("div");
    t3.className = "sec-title";
    t3.innerHTML = `<span style="color:var(--c-fail)">⚠ NDE 불합격 조인트 (${fails.length}건) — 보수 필요</span>`;
    el.appendChild(t3);
    fails.forEach(f => {
      const r = getRec(jointKey(f.line.id, f.j.no));
      const card = document.createElement("div");
      card.className = "stat-card";
      card.style.cursor = "pointer";
      card.style.borderColor = "var(--c-fail)";
      card.innerHTML = `<b>J.${f.j.no}</b> — ${f.line.id} · ${f.j.spool} · 용접사: ${r && r.welder || "-"} · Repair ${r && r.repairs ? r.repairs.length : 0}회`;
      card.onclick = () => selectJoint(jointKey(f.line.id, f.j.no), true);
      el.appendChild(card);
    });
  }
}

// =====================================================================
// 대시보드 페이지 (첫 화면) — 전체 프로젝트 기준
// =====================================================================
const STACK_ORDER = ["PASS", "FAIL", "WELDED", "FITUP", "DELIVERED", "NONE"];

function statusDiaInch(lines) {
  // 상태별 Dia-Inch 합계
  const di = { NONE: 0, DELIVERED: 0, FITUP: 0, WELDED: 0, PASS: 0, FAIL: 0, total: 0, joints: 0 };
  lines.forEach(line => {
    line.joints.forEach(j => {
      const inch = jointInch(line, j);
      const st = jointStatus(line.id, j);
      di[st] += inch;
      di.total += inch;
      di.joints++;
    });
  });
  return di;
}

function stackBarHtml(di) {
  if (!di.total) return '<div class="stack-bar"></div>';
  let html = '<div class="stack-bar">';
  STACK_ORDER.forEach(st => {
    const w = di[st] / di.total * 100;
    if (w > 0) html += `<div style="width:${w}%;background:${STATUS_META[st].color}" title="${STATUS_META[st].label} ${fmtDI(di[st])} D/I"></div>`;
  });
  return html + "</div>";
}

function renderDashPage() {
  const el = document.getElementById("dashPage");
  const all = PIPE_DATA.lines;
  const di = statusDiaInch(all);
  const passPct = di.total ? Math.round(di.PASS / di.total * 100) : 0;
  const judgedDI = di.PASS + di.FAIL;
  const ndePassRate = judgedDI ? Math.round(di.PASS / judgedDI * 100) : 0;

  // 불합격 조인트 수
  let failJoints = 0;
  all.forEach(l => l.joints.forEach(j => { if (jointStatus(l.id, j) === "FAIL") failJoints++; }));
  // 스풀 입고율
  let spoolTotal = 0, spoolIn = 0;
  all.forEach(l => l.spools.forEach(sp => {
    spoolTotal++;
    const r = getSpoolRec(l.id, sp);
    if (r && r.deliveryDate) spoolIn++;
  }));

  const today = new Date().toISOString().slice(0, 10);
  let todayWeld = 0, todayNde = 0;
  all.forEach(l => l.joints.forEach(j => {
    const r = getRec(jointKey(l.id, j.no));
    if (!r) return;
    if (r.weldDate === today || (r.repairs || []).some(rp => rp.weldDate === today)) todayWeld++;
    if (r.ndeDate === today || (r.repairs || []).some(rp => rp.ndeDate === today)) todayNde++;
  }));

  // ---- KPI 타일 ----
  let html = `<div class="kpi-grid">
    <div class="kpi hl">
      <div class="k-label">총 용접량 (Dia-Inch)</div>
      <div class="k-value">${fmtDI(di.total)} <small>D/I</small></div>
      <div class="k-sub">조인트 ${di.joints}개 · 라인 ${all.length}개 · 계통 ${allSystems().length}개</div>
    </div>
    <div class="kpi good">
      <div class="k-label">완료 Dia-Inch (NDE 합격까지)</div>
      <div class="k-value">${fmtDI(di.PASS)} <small>D/I · ${passPct}%</small></div>
      <div class="k-sub">용접+비파괴검사 합격 완료 기준</div>
    </div>
    <div class="kpi">
      <div class="k-label">용접완료·NDE 대기</div>
      <div class="k-value">${fmtDI(di.WELDED)} <small>D/I</small></div>
      <div class="k-sub">스풀입고(공장분) ${fmtDI(di.DELIVERED)} D/I 별도</div>
    </div>
    <div class="kpi ${ndePassRate < 95 && judgedDI ? "" : "good"}">
      <div class="k-label">NDE 합격률</div>
      <div class="k-value">${judgedDI ? ndePassRate + "<small>%</small>" : "-"}</div>
      <div class="k-sub">판정 ${fmtDI(judgedDI)} D/I 기준</div>
    </div>
    <div class="kpi ${failJoints ? "bad pulse" : ""}">
      <div class="k-label">NDE 불합격 (보수 필요)</div>
      <div class="k-value">${failJoints} <small>건</small></div>
      <div class="k-sub">${failJoints ? "아래 목록에서 클릭 → 3D 확인" : "불합격 없음"}</div>
    </div>
    <div class="kpi">
      <div class="k-label">스풀 입고율</div>
      <div class="k-value">${spoolTotal ? Math.round(spoolIn / spoolTotal * 100) : 0} <small>% (${spoolIn}/${spoolTotal})</small></div>
      <div class="k-sub">공장 제작 스풀 기준</div>
    </div>
    <div class="kpi">
      <div class="k-label">오늘 실적 (${today.slice(5)})</div>
      <div class="k-value">${todayWeld} <small>용접</small>&nbsp; ${todayNde} <small>NDE</small></div>
      <div class="k-sub">용접일·검사일이 오늘인 조인트</div>
    </div>
  </div>`;

  // ---- 계통별 진행현황 ----
  html += `<div class="dash-cols"><div class="dash-sec" style="flex:1.4">
    <h2>🔗 계통별 진행 현황 <span class="muted">(Dia-Inch 기준 · 막대 클릭 시 해당 계통 3D 보기)</span></h2>`;
  allSystems().forEach(s => {
    const lines = all.filter(l => lineSystem(l) === s.code);
    const sdi = statusDiaInch(lines);
    const pct = sdi.total ? Math.round(sdi.PASS / sdi.total * 100) : 0;
    html += `<div class="sys-row" data-sys="${s.code}" style="cursor:pointer" title="클릭: ${s.code} 계통 3D 보기">
      <div class="sr-head">
        <span><b>${s.code}</b>${s.name ? " — " + s.name : ""} <span class="muted">(라인 ${s.count}개 · ${fmtDI(sdi.total)} D/I)</span></span>
        <span><b style="color:var(--c-pass)">${pct}%</b> 완료${sdi.FAIL ? ` · <span style="color:var(--c-fail)">불합격 ${fmtDI(sdi.FAIL)} D/I</span>` : ""}</span>
      </div>
      ${stackBarHtml(sdi)}
    </div>`;
  });
  html += `<div class="bar-legend">${STACK_ORDER.map(st => `<span><i style="background:${STATUS_META[st].color}"></i>${STATUS_META[st].label}</span>`).join("")}</div></div>`;

  // ---- 용접사별 불량률 ----
  const ws = welderStats(all);
  const names = Object.keys(ws).sort((a, b) => {
    const ra = ws[a].judged ? ws[a].fails / ws[a].judged : -1;
    const rb = ws[b].judged ? ws[b].fails / ws[b].judged : -1;
    return rb - ra || ws[b].welds - ws[a].welds;
  });
  html += `<div class="dash-sec"><h2>👷 용접사별 불량률 <span class="muted">(Repair 용접 포함 · 5%↑ 빨강)</span></h2>`;
  if (!names.length) {
    html += `<div class="muted">용접 실적이 없습니다. 작업화면에서 용접일·용접사를 입력하면 자동 집계됩니다.</div>`;
  } else {
    names.forEach(n => {
      const s = ws[n];
      const rate = s.judged ? s.fails / s.judged * 100 : null;
      const barColor = rate === null ? "#5a6475" : rate >= 5 ? "var(--c-fail)" : "var(--c-pass)";
      const barW = rate === null ? 0 : Math.max(rate, 2);
      html += `<div class="welder-row">
        <b>${n}</b>
        <div class="wr-bar"><div style="width:${Math.min(barW, 100)}%;background:${barColor}"></div></div>
        <div class="wr-nums">${rate === null ? "판정 전" : `<b style="color:${barColor}">${rate.toFixed(1)}%</b>`} · ${s.welds}건/불${s.fails}</div>
      </div>`;
    });
    html += `<div class="bar-legend"><span>막대 = 불량률(불합격 ÷ NDE 판정)</span><span>건수 = 총 용접 건수</span></div>`;
  }
  html += `</div></div>`;

  // ---- 라인별 현황 + 불합격 목록 ----
  html += `<div class="dash-cols"><div class="dash-sec" style="flex:1.4">
    <h2>📋 라인별 현황</h2>
    <div class="dash-line-row hdr"><span>라인번호</span><span>조인트</span><span>완료 D/I</span><span>진척</span></div>`;
  all.forEach(line => {
    const ldi = statusDiaInch([line]);
    const pct = ldi.total ? Math.round(ldi.PASS / ldi.total * 100) : 0;
    html += `<div class="dash-line-row" data-line="${line.id}" style="cursor:pointer" title="클릭: 3D 보기">
      <span><b>${line.id}</b> <span class="muted">${line.dn}A${line.rev ? " Rev." + line.rev : ""}</span></span>
      <span class="muted">${line.joints.length}개</span>
      <span>${fmtDI(ldi.PASS)} / ${fmtDI(ldi.total)}</span>
      <span style="color:${pct === 100 ? "var(--c-pass)" : "inherit"}"><b>${pct}%</b></span>
    </div>`;
  });
  html += `</div><div class="dash-sec"><h2 style="color:${failJoints ? "var(--c-fail)" : "inherit"}">⚠ NDE 불합격 조인트</h2>`;
  if (!failJoints) {
    html += `<div class="muted">현재 불합격 조인트가 없습니다. 👍</div>`;
  } else {
    all.forEach(line => line.joints.forEach(j => {
      if (jointStatus(line.id, j) !== "FAIL") return;
      const r = getRec(jointKey(line.id, j.no));
      html += `<div class="dash-fail-card" data-key="${jointKey(line.id, j.no)}">
        <b>J.${j.no}</b> — ${line.id} · ${j.spool} · ${j.type === "F" ? "Field" : "Shop"}<br>
        <span class="muted">용접사 ${r && r.welder || "-"} · NDE ${r && r.ndeDate || "-"} · Repair ${r && r.repairs ? r.repairs.length : 0}회 — 클릭하여 3D 확인</span>
      </div>`;
    }));
  }
  html += `</div></div>`;

  el.innerHTML = html;

  // 클릭 바인딩: 계통 → 작업화면 그 계통, 라인/불합격 → 해당 위치로
  el.querySelectorAll(".sys-row").forEach(d => d.onclick = () => {
    currentSystem = d.dataset.sys; currentLine = "ALL";
    switchView("work"); refreshAll(); fitView();
  });
  el.querySelectorAll(".dash-line-row[data-line]").forEach(d => d.onclick = () => {
    const line = PIPE_DATA.lines.find(l => l.id === d.dataset.line);
    currentSystem = lineSystem(line); currentLine = line.id;
    switchView("work"); refreshAll(); fitView();
  });
  el.querySelectorAll(".dash-fail-card").forEach(d => d.onclick = () => {
    switchView("work");
    selectJoint(d.dataset.key, true);
  });
}

function switchView(v) {
  currentView = v;
  document.body.classList.toggle("dash-mode", v === "dash");
  document.getElementById("vtDash").classList.toggle("active", v === "dash");
  document.getElementById("vtWork").classList.toggle("active", v === "work");
  if (v === "dash") {
    renderDashPage();
  } else {
    // 숨겨져 있던 캔버스 크기 재계산 (첫 진입 시 카메라도 맞춤)
    const first = !switchView._workEntered;
    switchView._workEntered = true;
    setTimeout(() => { resize3D(); if (first) fitView(); }, 30);
  }
}

// ---------- 상세 패널 ----------
function selectJoint(key, focus3d) {
  selectedKey = key;
  const [lineId, noStr] = key.split("|");
  const line_ = PIPE_DATA.lines.find(l => l.id === lineId);
  if (currentSystem !== "ALL" && line_ && lineSystem(line_) !== currentSystem) {
    currentSystem = lineSystem(line_);
    currentLine = lineId;
    renderLineTabs(); updateLineVisibility();
  } else if (currentLine !== "ALL" && currentLine !== lineId) {
    currentLine = lineId; renderLineTabs(); updateLineVisibility();
  }
  renderJointTable();
  renderDetail();
  const m = meshByKey[key];
  if (m) {
    selectRing.visible = true;
    if (focus3d) {
      controls.target.copy(m.position);
      const off = camera.position.clone().sub(controls.target).normalize().multiplyScalar(16);
      camera.position.copy(m.position).add(off.length() ? off : new THREE.Vector3(10, 8, 10));
      controls.update();
    }
  }
}

function renderDetail() {
  const el = document.getElementById("detail");
  if (!selectedKey) { el.classList.remove("open"); return; }
  const [lineId, noStr] = selectedKey.split("|");
  const line = PIPE_DATA.lines.find(l => l.id === lineId);
  const j = line.joints.find(x => x.no === Number(noStr));
  const rec = ensureRec(selectedKey);
  const st = jointStatus(lineId, j);

  el.classList.add("open");
  el.innerHTML = `
    <span class="close" id="dClose">✕</span>
    <h3>Joint ${j.no} <span class="jtype ${j.type}" style="vertical-align:2px">${j.type === "F" ? "Field 용접" : "Shop 용접"}</span></h3>
    <div class="sub">${line.id}${line.rev ? " (Rev." + line.rev + ")" : ""} · ${j.dn || line.dn}A · 스풀 ${j.spool} · ${line.material}</div>
    <div class="status-banner" style="background:${STATUS_META[st].color}">${STATUS_META[st].label}</div>
    <div class="grid2">
      <div><label>Fit-up 일</label><input type="date" id="dFitup" value="${rec.fitupDate || ""}"></div>
      <div><label>용접일</label><input type="date" id="dWeld" value="${rec.weldDate || ""}"></div>
    </div>
    <label>용접사</label><input type="text" id="dWelder" value="${rec.welder || ""}" placeholder="예: 김용접 (W-07)" list="welderList">
    <datalist id="welderList">${Object.keys(welderStats()).map(n => `<option value="${n}">`).join("")}</datalist>
    <div class="grid2">
      <div><label>NDE 종류</label><select id="dNdeType">${NDE_TYPES.map(t => `<option ${rec.ndeType === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label>NDE 검사일</label><input type="date" id="dNdeDate" value="${rec.ndeDate || ""}"></div>
    </div>
    <label>NDE 결과</label>
    <select id="dNdeResult">
      <option value="" ${!rec.ndeResult ? "selected" : ""}>대기</option>
      <option value="합격" ${rec.ndeResult === "합격" ? "selected" : ""}>합격</option>
      <option value="불합격" ${rec.ndeResult === "불합격" ? "selected" : ""}>불합격</option>
    </select>
    <div id="repairZone"></div>
    <div class="actions">
      <button class="btn primary" id="dSave">💾 저장 후 닫기</button>
      <button class="btn" id="dAddRepair">➕ Repair 추가</button>
      <button class="btn danger" id="dClear">기록 삭제</button>
    </div>
    <div class="muted" style="margin-top:8px;font-size:11px;text-align:center">✓ 입력값은 변경 즉시 자동 저장됩니다 — 핏업만 입력하고 닫아도 됩니다</div>`;

  // Repair 목록
  const rz = el.querySelector("#repairZone");
  (rec.repairs || []).forEach((rp, i) => {
    const d = document.createElement("div");
    d.className = "repair-item";
    d.innerHTML = `
      <div class="rhead"><span>🔧 Repair R${i + 1}</span><span class="del" data-i="${i}">삭제</span></div>
      <div class="grid2">
        <div><label>보수 용접일</label><input type="date" class="rWeld" value="${rp.weldDate || ""}"></div>
        <div><label>용접사</label><input type="text" class="rWelder" value="${rp.welder || ""}" list="welderList"></div>
      </div>
      <div class="grid2">
        <div><label>재검사일</label><input type="date" class="rNde" value="${rp.ndeDate || ""}"></div>
        <div><label>재검 결과</label>
          <select class="rResult">
            <option value="" ${!rp.result ? "selected" : ""}>대기</option>
            <option value="합격" ${rp.result === "합격" ? "selected" : ""}>합격</option>
            <option value="불합격" ${rp.result === "불합격" ? "selected" : ""}>불합격</option>
          </select></div>
      </div>`;
    d.querySelector(".rWeld").onchange = e => { rp.weldDate = e.target.value; saveAndRefresh(); toast("✓ 자동 저장됨 (R" + (i + 1) + ")"); };
    d.querySelector(".rWelder").onchange = e => { rp.welder = e.target.value; saveAndRefresh(); toast("✓ 자동 저장됨 (R" + (i + 1) + ")"); };
    d.querySelector(".rNde").onchange = e => { rp.ndeDate = e.target.value; saveAndRefresh(); toast("✓ 자동 저장됨 (R" + (i + 1) + ")"); };
    d.querySelector(".rResult").onchange = e => { rp.result = e.target.value; saveAndRefresh(true); toast("✓ 자동 저장됨 (R" + (i + 1) + ")"); };
    d.querySelector(".del").onclick = () => {
      if (!confirm("Repair R" + (i + 1) + " 기록을 삭제할까요?")) return;
      rec.repairs.splice(i, 1); saveAndRefresh(true);
    };
    rz.appendChild(d);
  });

  // 이벤트 (모든 입력은 변경 즉시 자동 저장)
  const saved = () => toast("✓ 자동 저장됨 (Joint " + j.no + ")");
  el.querySelector("#dClose").onclick = () => { selectedKey = null; selectRing.visible = false; el.classList.remove("open"); renderJointTable(); };
  el.querySelector("#dSave").onclick = () => {
    save();
    toast("💾 Joint " + j.no + " 저장 완료");
    selectedKey = null; selectRing.visible = false; el.classList.remove("open"); renderJointTable();
  };
  el.querySelector("#dFitup").onchange = e => { rec.fitupDate = e.target.value; saveAndRefresh(true); saved(); };
  el.querySelector("#dWeld").onchange = e => { rec.weldDate = e.target.value; saveAndRefresh(true); saved(); };
  el.querySelector("#dWelder").onchange = e => { rec.welder = e.target.value; saveAndRefresh(); saved(); };
  el.querySelector("#dNdeType").onchange = e => { rec.ndeType = e.target.value; saveAndRefresh(); saved(); };
  el.querySelector("#dNdeDate").onchange = e => { rec.ndeDate = e.target.value; saveAndRefresh(); saved(); };
  el.querySelector("#dNdeResult").onchange = e => {
    rec.ndeResult = e.target.value;
    saveAndRefresh(true);
    if (e.target.value === "불합격") toast("⚠ 불합격 처리 — Repair 추가로 보수 이력을 관리하세요");
    else saved();
  };
  el.querySelector("#dAddRepair").onclick = () => {
    rec.repairs.push({ weldDate: "", welder: "", ndeDate: "", result: "" });
    saveAndRefresh(true);
  };
  el.querySelector("#dClear").onclick = () => {
    if (!confirm("Joint " + j.no + "의 모든 기록을 삭제할까요?")) return;
    delete state.records[selectedKey];
    saveAndRefresh(true);
  };
}

function saveAndRefresh(rebuildDetail) {
  save();
  renderDashboard();
  renderJointTable();
  updateJointColors();
  if (document.getElementById("tab-spools").style.display !== "none") renderSpools();
  if (document.getElementById("tab-stats").style.display !== "none") renderStats();
  if (rebuildDetail) renderDetail();
}

function refreshAll(withTabs) {
  if (withTabs !== false) renderLineTabs();
  renderDashboard();
  renderJointTable();
  renderSpools();
  renderStats();
  updateJointColors();
  updateLineVisibility();
  if (selectedKey) renderDetail();
}

// ---------- 탭 전환 ----------
function switchTab(name) {
  document.querySelectorAll(".panel-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  ["joints", "spools", "stats"].forEach(n => {
    document.getElementById("tab-" + n).style.display = (n === name) ? "" : "none";
  });
  if (name === "spools") renderSpools();
  if (name === "stats") renderStats();
}

// ---------- 엑셀 내보내기 ----------
function exportExcel() {
  const wb = XLSX.utils.book_new();

  const jointRows = [];
  PIPE_DATA.lines.forEach(line => {
    line.joints.forEach(j => {
      const r = getRec(jointKey(line.id, j.no)) || {};
      const reps = r.repairs || [];
      jointRows.push({
        "라인": line.id, "계통": lineSystem(line), "구경(DN)": j.dn || line.dn, "Dia-Inch": jointInch(line, j), "조인트": j.no,
        "구분": j.type === "F" ? "Field" : "Shop", "스풀": j.spool,
        "상태": STATUS_META[jointStatus(line.id, j)].label,
        "Fit-up일": r.fitupDate || "", "용접일": r.weldDate || "", "용접사": r.welder || "",
        "NDE종류": r.ndeType || "", "NDE일": r.ndeDate || "", "NDE결과": r.ndeResult || "",
        "Repair횟수": reps.length,
        "Repair상세": reps.map((rp, i) => `R${i + 1}: 용접 ${rp.weldDate || "-"}/${rp.welder || "-"} 재검 ${rp.ndeDate || "-"} ${rp.result || "대기"}`).join(" | ")
      });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(jointRows), "조인트현황");

  const spoolRows = [];
  PIPE_DATA.lines.forEach(line => {
    line.spools.forEach(sp => {
      const sr = getSpoolRec(line.id, sp) || {};
      spoolRows.push({ "라인": line.id, "스풀": sp, "입고일": sr.deliveryDate || "", "Shop조인트": line.joints.filter(j => j.spool === sp).map(j => j.no).join(", ") });
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(spoolRows), "스풀입고");

  const stats = welderStats();
  const statRows = Object.keys(stats).map(n => {
    const s = stats[n];
    return { "용접사": n, "용접건수": s.welds, "NDE판정": s.judged, "불합격": s.fails, "불합격률(%)": s.judged ? +(s.fails / s.judged * 100).toFixed(1) : "" };
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(statRows.length ? statRows : [{ "용접사": "", "용접건수": "", "NDE판정": "", "불합격": "", "불합격률(%)": "" }]), "용접사통계");

  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  XLSX.writeFile(wb, "용접관리현황_" + ymd + ".xlsx");
  toast("엑셀 파일로 내보냈습니다");
}

// ---------- 백업/복원 ----------
function exportJson() {
  const dynLines = (typeof loadDynamicLines === "function") ? loadDynamicLines() : [];
  const blob = new Blob([JSON.stringify({ records: state.records, spools: state.spools, lines: dynLines, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = "용접관리백업_" + d.toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("JSON 백업 파일을 저장했습니다");
}

function importJson(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const d = JSON.parse(fr.result);
      if (!d.records && !d.spools) throw new Error("형식 오류");
      state.records = d.records || {};
      state.spools = d.spools || {};
      save();
      if (d.lines && d.lines.length && typeof saveDynamicLines === "function") {
        saveDynamicLines(d.lines);
        toast("백업을 불러왔습니다 — 새로고침합니다");
        setTimeout(() => location.reload(), 600);
        return;
      }
      refreshAll();
      toast("백업을 불러왔습니다");
    } catch (e) { alert("가져오기 실패: 올바른 백업 파일이 아닙니다."); }
  };
  fr.readAsText(file);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.style.display = "none"; }, 2600);
}

// ---------- 초기화 ----------
window.addEventListener("DOMContentLoaded", () => {
  if (typeof mergeDynamicLines === "function") mergeDynamicLines(); // PDF로 등록한 라인 병합
  if (PIPE_DATA.lines.length > 20) showLabels = false;               // 대량 라인 시 번호 라벨 기본 숨김
  load();
  init3D();
  refreshAll();
  switchView("dash"); // 첫 화면: 대시보드

  // 딥링크: ?view=work&line=<라인번호>&joint=<번호>  (특정 조인트 바로 공유)
  const qp = new URLSearchParams(location.search);
  if (qp.get("line")) {
    const ln = PIPE_DATA.lines.find(l => l.id === qp.get("line"));
    if (ln) { currentSystem = lineSystem(ln); currentLine = ln.id; refreshAll(); }
  }
  if (qp.get("view") === "work") {
    switchView("work");
    // 캔버스 크기 확정 후 여러 번 맞춤 (렌더 타이밍 보정)
    [150, 500, 1000].forEach(ms => setTimeout(() => {
      resize3D();
      if (qp.get("joint") && qp.get("line")) selectJoint(qp.get("line") + "|" + qp.get("joint"), true);
      else fitView();
    }, ms));
  }

  if (DEMO_MODE) {
    const b = document.createElement("div");
    b.id = "demoBanner";
    b.textContent = "🎬 시연용 예시 데이터 — 실제 공사 실적이 아닙니다";
    document.body.appendChild(b);
  }
  document.getElementById("vtDash").onclick = () => switchView("dash");
  document.getElementById("vtWork").onclick = () => switchView("work");

  document.querySelectorAll(".panel-tab").forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  // 라인 선택 드롭다운
  document.getElementById("lpBtn").onclick = e => {
    e.stopPropagation();
    const drop = document.getElementById("lpDrop");
    drop.classList.contains("open") ? closeLinePicker() : openLinePicker();
  };
  document.getElementById("lpSearch").oninput = renderLineList;
  document.getElementById("lpDrop").onclick = e => e.stopPropagation();
  document.addEventListener("click", () => closeLinePicker());

  document.getElementById("sysSelect").onchange = e => {
    currentSystem = e.target.value;
    currentLine = "ALL"; // 계통 선택 시 그 계통 전체를 한눈에
    refreshAll(); fitView();
  };
  ["fStatus", "fType", "fDate", "fDateKind"].forEach(id => document.getElementById(id).onchange = renderJointTable);
  document.getElementById("fClear").onclick = () => {
    ["fStatus", "fType", "fDate"].forEach(id => document.getElementById(id).value = "");
    renderJointTable();
  };
  document.getElementById("btnFit").onclick = fitView;
  document.getElementById("btnLabels").onclick = () => { showLabels = !showLabels; updateLabelVisibility(); };
  document.getElementById("btnExcel").onclick = exportExcel;
  document.getElementById("btnSaveJson").onclick = exportJson;
  document.getElementById("btnLoadJson").onclick = () => document.getElementById("fileJson").click();
  document.getElementById("fileJson").onchange = e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; };
  document.getElementById("btnReset").onclick = () => {
    if (confirm("모든 입력 데이터(용접일/NDE/입고일)를 초기화할까요?\n라인·조인트 구조는 유지됩니다.")) {
      state = { records: {}, spools: {} };
      save(); selectedKey = null; selectRing.visible = false;
      document.getElementById("detail").classList.remove("open");
      refreshAll();
      toast("초기화했습니다");
    }
  };

  // 뷰어 크기 감지
  new ResizeObserver(resize3D).observe(document.getElementById("viewer"));
});
