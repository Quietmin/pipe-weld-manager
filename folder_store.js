// =====================================================================
// 폴더 저장 — 데이터를 브라우저가 아닌 '지정한 폴더의 파일'에 자동 저장
//  · 처음 한 번 저장 폴더를 지정하면 이후 모든 입력이 자동 기록됨
//  · 폴더/용접관리_데이터.json  (현재 데이터)
//  · 폴더/백업/용접관리_YYYYMMDD.json  (하루 1개 자동 백업)
//  · 브라우저 저장소(localStorage)는 작업용 캐시로만 사용
//  ※ 다른 스크립트보다 먼저 로드되어야 함 (저장소 변경 감지)
// =====================================================================
"use strict";

const FS_DATA_FILE = "용접관리_데이터.json";
const FS_BACKUP_DIR = "백업";
const FS_REV_KEY = "weldmgr_rev";
const FS_DEMO = new URLSearchParams(location.search).has("demo");
const FS_SUPPORTED = typeof window.showDirectoryPicker === "function";

let fsDir = null;          // FileSystemDirectoryHandle
let fsState = "none";      // none | need-perm | ok | saving | error | unsupported
let fsLastSaved = null;
let fsTimer = null;
let fsSuspend = false;     // 복원 중에는 변경 감지 중지

// ───────── 저장소 변경 감지 → 리비전 갱신 + 폴더 쓰기 예약 ─────────
(function hookStorage() {
  const _set = Storage.prototype.setItem, _rem = Storage.prototype.removeItem;
  function touched(st, k) {
    if (fsSuspend || st !== window.localStorage || !String(k).startsWith("weldmgr_") || k === FS_REV_KEY) return;
    _set.call(window.localStorage, FS_REV_KEY, String(Date.now()));
    fsScheduleWrite();
  }
  Storage.prototype.setItem = function (k, v) { _set.call(this, k, v); touched(this, k); };
  Storage.prototype.removeItem = function (k) { _rem.call(this, k); touched(this, k); };
})();

// ───────── IndexedDB (폴더 핸들 기억용) ─────────
function fsIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("weldmgr_fs", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function fsIdbGet(k) {
  const db = await fsIdb();
  return new Promise((res, rej) => {
    const q = db.transaction("kv").objectStore("kv").get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function fsIdbSet(k, v) {
  const db = await fsIdb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    if (v === undefined) t.objectStore("kv").delete(k); else t.objectStore("kv").put(v, k);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}

// ───────── 데이터 묶기 / 풀기 ─────────
function fsJson(key, dflt) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || dflt; } catch (e) { return dflt; }
}
function fsCollect() {
  const rec = fsJson("weldmgr_v1", {});
  const ln = fsJson("weldmgr_lines_v1", {});
  return {
    app: "배관 용접 관리", format: 1,
    rev: +localStorage.getItem(FS_REV_KEY) || Date.now(),
    savedAt: new Date().toISOString(),
    records: rec.records || {}, spools: rec.spools || {},
    lines: ln.lines || [],
    samples: localStorage.getItem("weldmgr_samples") || null
  };
}
function fsRestore(d) {
  fsSuspend = true;
  try {
    localStorage.setItem("weldmgr_v1", JSON.stringify({ records: d.records || {}, spools: d.spools || {}, savedAt: d.savedAt }));
    localStorage.setItem("weldmgr_lines_v1", JSON.stringify({ lines: d.lines || [], savedAt: d.savedAt }));
    if (d.samples) localStorage.setItem("weldmgr_samples", d.samples); else localStorage.removeItem("weldmgr_samples");
    localStorage.setItem(FS_REV_KEY, String(d.rev || Date.now()));
  } finally { fsSuspend = false; }
}
function fsSummary(d) {
  const n = Object.keys(d.records || {}).length;
  return `도면 라인 ${(d.lines || []).length}개 · 실적 ${n}건 · 저장 ${(d.savedAt || "").replace("T", " ").slice(0, 16)}`;
}

// ───────── 파일 읽기/쓰기 ─────────
async function fsReadFile() {
  try {
    const fh = await fsDir.getFileHandle(FS_DATA_FILE);
    return JSON.parse(await (await fh.getFile()).text());
  } catch (e) { return null; }
}
async function fsWriteText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();      // 닫을 때 원자적으로 교체됨 (쓰다 끊겨도 기존 파일 보존)
}
function fsScheduleWrite() {
  if (fsState !== "ok" && fsState !== "saving") return;
  clearTimeout(fsTimer);
  fsTimer = setTimeout(fsWriteNow, 700);
}
async function fsWriteNow() {
  if (!fsDir) return;
  fsSetState("saving");
  try {
    const data = fsCollect();
    const text = JSON.stringify(data, null, 1);
    await fsWriteText(fsDir, FS_DATA_FILE, text);
    // 하루 1개 자동 백업
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const bdir = await fsDir.getDirectoryHandle(FS_BACKUP_DIR, { create: true });
    const bname = `용접관리_${day}.json`;
    let exists = true;
    try { await bdir.getFileHandle(bname); } catch (e) { exists = false; }
    if (!exists) await fsWriteText(bdir, bname, text);
    fsLastSaved = new Date();
    fsSetState("ok");
  } catch (e) {
    console.error("폴더 저장 실패", e);
    fsSetState("error", e.message);
  }
}

// ───────── 연결 / 동기화 ─────────
async function fsSync(firstConnect) {
  const file = await fsReadFile();
  const localRev = +localStorage.getItem(FS_REV_KEY) || 0;
  const local = fsCollect();
  const localHas = local.lines.length || Object.keys(local.records).length;

  if (file) {
    const fileHas = (file.lines || []).length || Object.keys(file.records || {}).length;
    if (firstConnect && localHas && fileHas) {
      // 양쪽에 데이터가 있으면 사용자에게 선택받기
      const useFile = confirm(
        "선택한 폴더에 이미 저장된 데이터가 있습니다.\n\n" +
        "📁 폴더 : " + fsSummary(file) + "\n" +
        "🌐 이 브라우저 : 도면 라인 " + local.lines.length + "개 · 실적 " + Object.keys(local.records).length + "건\n\n" +
        "[확인] 폴더 데이터를 불러옵니다 (권장)\n[취소] 이 브라우저 데이터로 폴더를 덮어씁니다");
      if (useFile) { fsRestore(file); location.reload(); return; }
      await fsWriteNow(); return;
    }
    if ((file.rev || 0) > localRev || (!localHas && fileHas)) {
      fsRestore(file); location.reload(); return;   // 폴더가 최신 → 불러오기
    }
    if (localRev > (file.rev || 0)) { await fsWriteNow(); return; }   // 브라우저가 최신 → 기록
    fsLastSaved = new Date(file.savedAt || Date.now());
    fsSetState("ok");
  } else {
    if (!localStorage.getItem(FS_REV_KEY)) localStorage.setItem(FS_REV_KEY, String(Date.now()));
    await fsWriteNow();   // 폴더가 비어 있음 → 현재 데이터 기록
  }
}

async function fsPickFolder() {
  if (!FS_SUPPORTED) {
    alert("이 브라우저는 폴더 저장을 지원하지 않습니다.\nMicrosoft Edge 또는 Chrome에서 열어주세요.");
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ id: "weldmgr-data", mode: "readwrite", startIn: "documents" });
    if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return;
    fsDir = dir;
    await fsIdbSet("dir", dir);
    fsSetState("ok");
    await fsSync(true);
    if (typeof toast === "function") toast("📁 저장 폴더 연결됨: " + dir.name);
  } catch (e) {
    if (e.name !== "AbortError") alert("폴더 연결 실패: " + e.message);
  }
}

async function fsReconnect() {
  try {
    if ((await fsDir.requestPermission({ mode: "readwrite" })) === "granted") {
      fsSetState("ok");
      await fsSync(false);
    }
  } catch (e) { fsSetState("error", e.message); }
}

async function fsDisconnect() {
  fsDir = null;
  await fsIdbSet("dir", undefined);
  fsSetState("none");
}

// ───────── 헤더 상태 버튼 ─────────
function fsSetState(st, msg) {
  fsState = st;
  const b = document.getElementById("btnFolder");
  if (!b) return;
  b.className = "btn fs-" + st;
  const name = fsDir ? fsDir.name : "";
  const t = fsLastSaved ? fsLastSaved.toTimeString().slice(0, 8) : "";
  const map = {
    none:        ["📁 저장폴더 연결", "클릭해서 데이터를 저장할 폴더를 지정하세요 (현재는 브라우저에만 저장 중)"],
    "need-perm": ["📁 폴더 재연결", "보안상 다시 허용이 필요합니다 — 클릭하세요"],
    ok:          ["📁 " + name + " ✓", `저장 폴더: ${name}\n마지막 저장: ${t}\n${FS_DATA_FILE} + 백업 폴더에 자동 저장 중`],
    saving:      ["📁 저장 중…", "폴더에 저장하는 중"],
    error:       ["📁 저장 오류", "폴더 저장 실패: " + (msg || "") + "\n클릭해서 폴더를 다시 지정하세요"],
    unsupported: ["📁 폴더저장 불가", "이 브라우저는 폴더 저장을 지원하지 않습니다 (Edge/Chrome 사용)"]
  };
  const [label, tip] = map[st] || map.none;
  b.textContent = label;
  b.title = tip;
}

window.addEventListener("DOMContentLoaded", async () => {
  const b = document.getElementById("btnFolder");
  if (!b) return;
  if (FS_DEMO) { b.style.display = "none"; return; }
  if (!FS_SUPPORTED) { fsSetState("unsupported"); b.onclick = fsPickFolder; return; }

  b.onclick = () => {
    if (fsState === "need-perm") fsReconnect();
    else if (fsState === "ok" || fsState === "saving") {
      if (confirm(`현재 저장 폴더: ${fsDir.name}\n\n다른 폴더로 변경할까요?\n(취소 = 유지)`)) fsPickFolder();
    } else fsPickFolder();
  };

  try {
    const dir = await fsIdbGet("dir");
    if (!dir) { fsSetState("none"); return; }
    fsDir = dir;
    const perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm === "granted") { fsSetState("ok"); await fsSync(false); }
    else fsSetState("need-perm");
  } catch (e) {
    fsSetState("none");
  }
});
