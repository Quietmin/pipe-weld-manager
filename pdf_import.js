// =====================================================================
// ISO 도면 PDF 자동 분석 (브라우저 내부 전용 — 외부 전송 없음)
// 도면에 기입된 표(라인번호 / 관경별 JOINT NO. / ISO NO. / FROM·TO)를
// 텍스트 레이어에서 추출해 라인·조인트를 자동 등록한다.
// =====================================================================
"use strict";

const LINES_KEY = "weldmgr_lines_v1";

// 관경(인치 표기) → DN
const IN_TO_DN = { "1/2":15, "3/4":20, "1":25, "1-1/4":32, "1 1/4":32, "11/4":32,
  "1-1/2":40, "1 1/2":40, "11/2":40, "2":50, "2-1/2":65, "2 1/2":65, "21/2":65,
  "3":80, "4":100, "5":125, "6":150, "8":200, "10":250, "12":300 };
const DN_TO_OD = { 15:21.3, 20:26.7, 25:33.4, 32:42.2, 40:48.3, 50:60.3, 65:73,
  80:88.9, 100:114.3, 125:141.3, 150:168.3, 200:219.1, 250:273, 300:323.9 };

function loadDynamicLines() {
  try {
    const raw = localStorage.getItem(LINES_KEY);
    return raw ? (JSON.parse(raw).lines || []) : [];
  } catch (e) { return []; }
}
function saveDynamicLines(lines) {
  localStorage.setItem(LINES_KEY, JSON.stringify({ lines, savedAt: new Date().toISOString() }));
}
const HIDE_SAMPLES_KEY = "weldmgr_hide_samples";   // (구버전 키 — 마이그레이션용)
const SAMPLES_KEY = "weldmgr_samples";             // "show" | "hide" | 없음(자동)
const IS_DEMO = new URLSearchParams(location.search).has("demo");

// 자동 규칙: 내 도면을 한 장이라도 올리면 내장 샘플은 숨김
function samplesPref() {
  if (localStorage.getItem(HIDE_SAMPLES_KEY) === "1") {   // 구버전 설정 이어받기
    localStorage.setItem(SAMPLES_KEY, "hide");
    localStorage.removeItem(HIDE_SAMPLES_KEY);
  }
  return localStorage.getItem(SAMPLES_KEY) || "auto";
}
function samplesHidden() {
  if (IS_DEMO) return false;
  const pref = samplesPref();
  if (pref === "show") return false;
  if (pref === "hide") return true;
  return loadDynamicLines().length > 0;            // 자동
}

// PIPE_DATA에 업로드 라인 병합 + 기본 샘플 숨김 (여러 번 호출해도 안전)
function mergeDynamicLines() {
  if (samplesHidden()) {
    for (let i = PIPE_DATA.lines.length - 1; i >= 0; i--)
      if (!PIPE_DATA.lines[i].imported) PIPE_DATA.lines.splice(i, 1);
  }
  const dyn = loadDynamicLines();
  const have = new Set(PIPE_DATA.lines.map(l => l.id));
  dyn.forEach(l => { if (!have.has(l.id)) { PIPE_DATA.lines.push(l); have.add(l.id); } });
  return dyn.length;
}
mergeDynamicLines();

// ───────────────────────── 페이지 텍스트 → 구조 추출 ─────────────────────────
function extractPage(tokens) {
  // tokens: [{t, x, y}]
  const SIZE  = /^(\d+(?:[-\s]?\d\/\d)?|\d\/\d)\s*"$/;
  const RANGE = /^(\d+)\s*번\s*[~∼–-]\s*(\d+)\s*번$/;
  const ONE   = /^(\d+)\s*번$/;
  const CNT   = /^(\d+)\s*P$/i;
  const SHEET = /^([A-Z]{1,4}-\d{3,6})-(\d{1,2})$/;
  const ISO3  = /^\d{3}$/;
  const LABELS = new Set(["관경(인치)", "JOINT", "NO.", "총", "갯수", "ISO", "FROM", "TO", "/"]);

  const res = { lineId: null, sheet: null, isoNo: null, fromTo: "", rows: [] };
  const used = new Set();

  // 라인번호: ["] 포함 + 하이픈 3개 이상
  for (const tk of tokens) {
    if (tk.t.includes('"') && (tk.t.match(/-/g) || []).length >= 3 && tk.t.length >= 10) {
      res.lineId = tk.t; used.add(tk); break;
    }
  }
  // 시트번호
  for (const tk of tokens) {
    const m = tk.t.match(SHEET);
    if (m) { res.sheet = m[2]; if (!res.lineId) res.lineId = m[1]; used.add(tk); break; }
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // ISO NO: "ISO" 라벨에서 가장 가까운 3자리 숫자
  const isoLbl = tokens.find(tk => /^ISO/i.test(tk.t));
  const threes = tokens.filter(tk => ISO3.test(tk.t) && !used.has(tk));
  if (threes.length) {
    res.isoNo = (isoLbl
      ? threes.reduce((a, b) => dist(a, isoLbl) < dist(b, isoLbl) ? a : b)
      : threes[0]).t;
  }
  // 관경 행: size ↔ 가장 가까운 range/count 짝짓기
  const sizes  = tokens.filter(tk => SIZE.test(tk.t));
  const ranges = tokens.filter(tk => RANGE.test(tk.t) || ONE.test(tk.t));
  const counts = tokens.filter(tk => CNT.test(tk.t));
  const usedR = new Set(), usedC = new Set();
  for (const s of sizes) {
    let best = null, bd = 1e9;
    for (const r of ranges) {
      if (usedR.has(r)) continue;
      const d = dist(s, r);
      if (d < bd) { bd = d; best = r; }
    }
    if (!best || bd > 150) continue;
    usedR.add(best);
    let m = best.t.match(RANGE), from, to;
    if (m) { from = +m[1]; to = +m[2]; } else { m = best.t.match(ONE); from = to = +m[1]; }
    if (to < from) [from, to] = [to, from];
    const inch = s.t.replace(/"\s*$/, "").trim();
    const dn = IN_TO_DN[inch] || Math.round(parseFloat(inch) * 25) || 25;
    // 검증용 count (없어도 진행)
    let cnt = null, cb = null, cbd = 1e9;
    for (const c of counts) {
      if (usedC.has(c)) continue;
      const d = dist(s, c);
      if (d < cbd) { cbd = d; cb = c; }
    }
    if (cb && cbd < 200) { usedC.add(cb); cnt = +cb.t.match(CNT)[1]; }
    res.rows.push({ inch, dn, from, to, count: cnt });
    [s, best].forEach(tk => used.add(tk));
  }
  // FROM/TO 값: 라벨("FROM / TO" 또는 "FROM")에서 가장 가까운 값 토큰
  const fromLbl = tokens.find(tk => /^FROM(\s*\/\s*TO)?$/i.test(tk.t));
  if (fromLbl) {
    const lblRe = /^(관경\(인치\)|JOINT\s*NO\.?|ISO\s*NO\.?|총\s*갯수|총|갯수|NO\.?|FROM(\s*\/\s*TO)?|TO|\/)$/i;
    const cands = tokens.filter(tk => tk !== fromLbl && !used.has(tk) && !lblRe.test(tk.t)
      && !SIZE.test(tk.t) && !RANGE.test(tk.t) && !ONE.test(tk.t) && !CNT.test(tk.t)
      && !ISO3.test(tk.t) && tk.t !== res.lineId && tk.t.length >= 2);
    let best = null, bd = 1e9;
    for (const c of cands) {
      const w = c.t.includes("/") ? 0.5 : 1;   // FROM/TO 값은 보통 "A / B" 형태 → 우대
      const d = dist(c, fromLbl) * w;
      if (d < bd) { bd = d; best = c; }
    }
    if (best && bd < 250) res.fromTo = best.t.replace(/\s*\/\s*/g, " / ").trim();
  }
  return res;
}

// ───────────────────────── 추출 결과 → 라인 객체 ─────────────────────────
function buildLinesFromEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.lineId)) groups.set(e.lineId, []);
    groups.get(e.lineId).push(e);
  }
  const lines = [];
  for (const [lineId, es] of groups) {
    es.sort((a, b) => (+(a.sheet || a.page)) - (+(b.sheet || b.page)));
    // 시트 간 조인트 번호 겹침 → 시트별 별도 라인
    const seen = new Set(); let overlap = false;
    for (const e of es) for (const r of e.rows)
      for (let n = r.from; n <= r.to; n++) { if (seen.has(n)) overlap = true; seen.add(n); }
    const parts = (overlap && es.length > 1)
      ? es.map(e => ({ id: `${lineId} #${e.sheet || e.isoNo || e.page}`, es: [e] }))
      : [{ id: lineId, es }];
    for (const part of parts) {
      const jmap = new Map(); // no -> dn
      let fromTo = "", sheets = [], isoNos = [];
      for (const e of part.es) {
        if (e.fromTo) fromTo = e.fromTo;
        if (e.sheet) sheets.push(e.sheet);
        if (e.isoNo) isoNos.push(e.isoNo);
        for (const r of e.rows)
          for (let n = r.from; n <= r.to; n++) jmap.set(n, r.dn);
      }
      const nos = [...jmap.keys()].sort((a, b) => a - b);
      if (!nos.length) continue;
      // 주 관경 = 조인트 수 최다 관경
      const cnt = {};
      nos.forEach(n => { const d = jmap.get(n); cnt[d] = (cnt[d] || 0) + 1; });
      const mainDn = +Object.keys(cnt).reduce((a, b) => cnt[a] >= cnt[b] ? a : b);
      // 간이 3D 경로: 수평 직선 배치 (정밀 경로는 추후 보정)
      const spacing = Math.min(1500, Math.floor(55000 / (nos.length + 1)));
      const L = (nos.length + 1) * spacing;
      const [ft1, ft2] = fromTo.split("/").map(x => (x || "").trim());
      lines.push({
        id: part.id,
        dn: mainDn, od: DN_TO_OD[mainDn] || mainDn * 1.1,
        material: "", commodity: "",
        from: ft1 || "", to: ft2 || "",
        ndt: "", drawing: sheets.length ? `Sh.${sheets.join(",")}` : "",
        rev: "", imported: true, isoNo: isoNos[0] || "",
        srcFile: part.es[0].file || "", importedAt: new Date().toISOString(),
        nodes: [[0, 0, 3000], [-L, 0, 3000]],
        spools: [],
        joints: nos.map((n, i) => ({
          no: n, type: "F", spool: "-", dn: jmap.get(n),
          pos: [-(i + 1) * spacing, 0, 3000]
        }))
      });
    }
  }
  return lines;
}

// ───────────────────────── PDF 읽기 ─────────────────────────
async function analyzePdfFiles(files) {
  const prog = document.getElementById("pdfProgress");
  const fill = document.getElementById("ppFill");
  const stat = document.getElementById("ppStat");
  prog.classList.add("open");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";

  const entries = [], fails = [];
  let totalPages = 0, done = 0;
  try {
    const docs = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      docs.push({ name: f.name, doc });
      totalPages += doc.numPages;
    }
    for (const { name, doc } of docs) {
      for (let pno = 1; pno <= doc.numPages; pno++) {
        const page = await doc.getPage(pno);
        const tc = await page.getTextContent();
        const tokens = [];
        for (const it of tc.items) {
          const str = (it.str || "").trim();
          if (!str) continue;
          // 공백 포함 항목은 분리하되 같은 좌표 공유
          for (const t of str.split(/\s{2,}/)) {
            const tt = t.trim();
            if (tt) tokens.push({ t: tt, x: it.transform[4], y: it.transform[5] });
          }
        }
        const r = extractPage(tokens);
        r.page = pno; r.file = name;
        if (r.lineId && r.rows.length) entries.push(r);
        else fails.push(`${name} p.${pno}`);
        done++;
        fill.style.width = (done / totalPages * 100).toFixed(1) + "%";
        stat.textContent = `${done} / ${totalPages} 페이지 분석 (인식 ${entries.length} · 실패 ${fails.length})`;
        if (done % 10 === 0) await new Promise(r2 => setTimeout(r2, 0)); // UI 갱신
      }
    }
  } catch (e) {
    prog.classList.remove("open");
    alert("PDF 분석 오류: " + e.message);
    return;
  }
  prog.classList.remove("open");

  const newLines = buildLinesFromEntries(entries);
  if (!newLines.length) {
    alert("도면에서 라인 정보를 찾지 못했습니다.\n(도면에 라인번호·JOINT NO. 기입 표가 있는 PDF여야 합니다)");
    return;
  }
  // 기존 저장분과 병합 (같은 라인 ID는 교체 — 입력 실적은 조인트 번호 기준이라 유지됨)
  const existing = loadDynamicLines();
  const map = new Map(existing.map(l => [l.id, l]));
  let added = 0, updated = 0;
  for (const l of newLines) {
    if (map.has(l.id)) updated++; else added++;
    map.set(l.id, l);
  }
  saveDynamicLines([...map.values()]);

  const jointCnt = newLines.reduce((s, l) => s + l.joints.length, 0);
  let msg = `도면 분석 완료 ✅\n\n` +
    `· 라인 ${newLines.length}개 (신규 ${added}, 갱신 ${updated})\n` +
    `· 조인트 ${jointCnt}개 등록\n`;
  if (fails.length) msg += `· 인식 실패 ${fails.length}페이지: ${fails.slice(0, 8).join(", ")}${fails.length > 8 ? " …" : ""}\n`;
  if (samplesPref() === "auto") msg += `\u00b7 내장 샘플 라인 2개는 자동으로 숨겨집니다 (데이터 관리에서 다시 표시 가능)\n`;
  msg += `\n확인을 누르면 화면을 새로고침해 반영합니다.\n※ 3D 경로는 간이 배치이며, 분석은 전부 이 PC 안에서만 수행되었습니다.`;
  alert(msg);
  location.reload();
}

// ───────────────────────── 데이터 관리 · 초기화 ─────────────────────────
const REC_KEY = "weldmgr_v1";
function hesc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function readRecStore() {
  try { return JSON.parse(localStorage.getItem(REC_KEY) || "{}"); } catch (e) { return {}; }
}
function lineOfKey(k) { return k.slice(0, k.lastIndexOf("|")); }
function countRecordsFor(ids) {
  const set = new Set(ids), st = readRecStore();
  return Object.keys(st.records || {}).filter(k => set.has(lineOfKey(k))).length;
}
function purgeRecordsFor(ids) {
  const set = new Set(ids), st = readRecStore();
  for (const k of Object.keys(st.records || {})) if (set.has(lineOfKey(k))) delete st.records[k];
  for (const k of Object.keys(st.spools || {})) if (set.has(lineOfKey(k))) delete st.spools[k];
  localStorage.setItem(REC_KEY, JSON.stringify(st));
}
function deleteLines(ids, label) {
  const n = countRecordsFor(ids);
  const msg = label + "\n\n· 라인 " + ids.length + "개 삭제" +
    (n ? "\n· 입력한 용접·NDE 실적 " + n + "건도 함께 삭제됩니다" : "") + "\n\n계속할까요?";
  if (!confirm(msg)) return;
  const set = new Set(ids);
  saveDynamicLines(loadDynamicLines().filter(l => !set.has(l.id)));
  purgeRecordsFor(ids);
  location.reload();
}

let _mgrGroups = [];
function renderManager() {
  const body = document.getElementById("mgrBody");
  const dyn = loadDynamicLines();
  const groups = new Map();
  dyn.forEach(l => {
    const k = l.srcFile || "(파일명 미기록)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  });
  _mgrGroups = [...groups];

  let h = `<div class="mg-sec"><div class="mg-h">📄 업로드한 도면 파일 <span class="muted">(라인 ${dyn.length}개)</span></div>`;
  if (!_mgrGroups.length) h += `<div class="muted mg-empty">업로드한 도면이 없습니다.</div>`;
  _mgrGroups.forEach(([file, ls], gi) => {
    const jn = ls.reduce((a, l) => a + l.joints.length, 0);
    const rn = countRecordsFor(ls.map(l => l.id));
    const dt = (ls[0].importedAt || "").slice(0, 10);
    h += `<div class="mg-file">
      <div class="mg-row">
        <span class="mg-name" title="${hesc(file)}">📄 ${hesc(file)}</span>
        <span class="muted">라인 ${ls.length} · 조인트 ${jn}${rn ? ` · 실적 ${rn}건` : ""}${dt ? ` · ${dt}` : ""}</span>
        <button class="btn sm" data-act="toggle" data-g="${gi}">라인 ▾</button>
        <button class="btn danger sm" data-act="delfile" data-g="${gi}">🗑 파일 삭제</button>
      </div>
      <div class="mg-lines" id="mgLines${gi}">` +
      ls.map(l => `<div class="mg-line"><span>${hesc(l.id)} <span class="muted">· 조인트 ${l.joints.length}</span></span>
        <button class="btn danger sm" data-act="delline" data-id="${hesc(l.id)}">삭제</button></div>`).join("") +
      `</div></div>`;
  });
  h += `</div>`;

  const hidden = samplesHidden();
  const pref = samplesPref();
  const sampleIds = ["150-FG1-GK1-00006", "80-FG1-GB4-00005"];
  const stateTxt = hidden
    ? (pref === "auto" ? "숨김 — 내 도면이 등록되어 자동으로 제외됨" : "숨김 (수동 설정)")
    : "표시 중 — " + sampleIds.map(hesc).join(", ");
  h += `<div class="mg-sec"><div class="mg-h">🧪 기본 샘플 라인 <span class="muted">(프로그램에 내장된 예시 도면 2개)</span></div>
    <div class="mg-reset">
      <span>${stateTxt}</span>
      <button class="btn" data-act="samples">${hidden ? "표시하기" : "숨기기"}</button>
    </div></div>`;

  h += `<div class="mg-sec"><div class="mg-h">♻ 초기화</div>
    <div class="mg-reset">
      <span><b>실적만 초기화</b> <span class="muted">— 용접일·용접사·NDE·Repair·스풀입고 삭제, 도면(라인)은 유지</span></span>
      <button class="btn danger" data-act="resetRec">실적 초기화</button>
      <span><b>업로드 도면 전체 삭제</b> <span class="muted">— PDF로 등록한 라인 전부와 그 실적 삭제</span></span>
      <button class="btn danger" data-act="resetLines">도면 전체 삭제</button>
      <span><b>전체 초기화</b> <span class="muted">— 실적·업로드 도면 모두 삭제, 처음 설치 상태로</span></span>
      <button class="btn danger" data-act="resetAll">전체 초기화</button>
    </div></div>`;
  body.innerHTML = h;

  body.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const act = b.dataset.act;
    if (act === "toggle") {
      document.getElementById("mgLines" + b.dataset.g).classList.toggle("open");
    } else if (act === "delfile") {
      const [file, ls] = _mgrGroups[+b.dataset.g];
      deleteLines(ls.map(l => l.id), "「" + file + "」 파일로 등록한 도면을 삭제합니다.");
    } else if (act === "delline") {
      deleteLines([b.dataset.id], "라인 " + b.dataset.id + " 을(를) 삭제합니다.");
    } else if (act === "samples") {
      localStorage.setItem(SAMPLES_KEY, hidden ? "show" : "hide");
      location.reload();
    } else if (act === "resetRec") {
      if (!confirm("입력한 모든 실적(용접일·용접사·NDE·Repair·스풀입고)을 삭제합니다.\n도면(라인·조인트)은 유지됩니다.\n\n계속할까요?")) return;
      localStorage.removeItem(REC_KEY);
      location.reload();
    } else if (act === "resetLines") {
      const ids = loadDynamicLines().map(l => l.id);
      if (!ids.length) { alert("업로드한 도면이 없습니다."); return; }
      deleteLines(ids, "PDF로 업로드한 도면을 전부 삭제합니다.");
    } else if (act === "resetAll") {
      if (!confirm("⚠ 전체 초기화\n\n입력한 실적과 업로드한 도면이 모두 삭제되고 처음 상태로 돌아갑니다.\n\n계속할까요?")) return;
      if (!confirm("정말 전부 삭제할까요? 되돌릴 수 없습니다.")) return;
      [REC_KEY, LINES_KEY, HIDE_SAMPLES_KEY, SAMPLES_KEY].forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  });
}
function openManager() {
  if (IS_DEMO) { alert("시연 모드(?demo=1)에서는 데이터 관리를 사용할 수 없습니다."); return; }
  renderManager();
  document.getElementById("mgrModal").classList.add("open");
}

// ───────────────────────── 이벤트 연결 ─────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("filePdf");
  document.getElementById("btnPdf").onclick = () => input.click();
  const modal = document.getElementById("mgrModal");
  document.getElementById("btnManage").onclick = openManager;
  document.getElementById("mgrClose").onclick = () => modal.classList.remove("open");
  modal.onclick = e => { if (e.target === modal) modal.classList.remove("open"); };
  document.getElementById("mgrBackup").onclick = () => document.getElementById("btnSaveJson").click();
  input.onchange = e => {
    const fs = [...e.target.files].filter(f => /\.pdf$/i.test(f.name));
    if (fs.length) analyzePdfFiles(fs);
    e.target.value = "";
  };
  // 창 전체 드래그&드롭
  window.addEventListener("dragover", e => { e.preventDefault(); });
  window.addEventListener("drop", e => {
    e.preventDefault();
    const fs = [...(e.dataTransfer?.files || [])].filter(f => /\.pdf$/i.test(f.name));
    if (fs.length) analyzePdfFiles(fs);
  });
});
