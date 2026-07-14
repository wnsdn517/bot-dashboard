/* 냥이 Bot 대시보드 — 상태 + 기능 요청 (단일 SPA)
 * gh-pages 등 다른 출처에서 호스팅될 수 있으므로 API 서버 주소를 별도 설정한다.
 */
"use strict";

const LS_API = "nyang_api_base";
const LS_TOKEN = "nyang_owner_token";

// ── 상태 데이터 ────────────────────────────────────────────────────────────
// 1) data/meta.json 에서 gist id 자동 발견 (봇이 기록) → 2) Gist 읽기
// 3) 실패 시 같은 저장소의 data/status.json 폴백
// 신선도 검사: 마지막 수신이 3분 넘으면 "데이터 지연", 15분 넘으면 "봇 오프라인 추정"
// — 이전 버전은 몇 주 전 데이터도 "모든 서비스 정상"으로 표시하는 문제가 있었다.
const FALLBACK_GIST_ID = "dc6ae3a8ab59432353bd21e1f4d4b4f4";
const STALE_WARN_S = 3 * 60;
const STALE_DOWN_S = 15 * 60;
const SERVICE_LABELS = {
  server: "Iris 서버", frida: "Frida", kakao: "KakaoTalk",
  botprocess: "봇 프로세스", frida_hook: "Frida 후킹",
};
const HIST_COLORS = {
  green: "var(--green)", gray: "var(--gray)", orange: "var(--orange)",
  red: "var(--red)", darkred: "#8b1e1e",
};
let _gistId = null;

function hasBotApi() { return !!localStorage.getItem(LS_API); }
function apiBase() {
  return (localStorage.getItem(LS_API) || window.location.origin).replace(/\/$/, "");
}
function token() { return localStorage.getItem(LS_TOKEN) || ""; }
function setToken(t) { t ? localStorage.setItem(LS_TOKEN, t) : localStorage.removeItem(LS_TOKEN); }
function isOwner() { return !!token(); }

async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (isOwner()) headers["Authorization"] = "Bearer " + token();
  const res = await fetch(apiBase() + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { setToken(""); reflectOwner(); }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── 탭 ── */
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  const name = t.dataset.tab;
  $("tab-status").classList.toggle("hidden", name !== "status");
  $("tab-requests").classList.toggle("hidden", name !== "requests");
}));

/* ── 상태 로드 ── */
async function resolveGistId() {
  if (_gistId) return _gistId;
  try {
    const r = await fetch("data/meta.json?t=" + Date.now());
    if (r.ok) {
      const m = await r.json();
      if (m && m.status_gist_id) { _gistId = m.status_gist_id; return _gistId; }
    }
  } catch (_) {}
  _gistId = FALLBACK_GIST_ID;
  return _gistId;
}

async function fetchStatusData() {
  // ① Gist (봇이 60초마다 갱신)
  try {
    const gid = await resolveGistId();
    const res = await fetch("https://api.github.com/gists/" + gid,
      { headers: { "Accept": "application/vnd.github+json" } });
    if (res.ok) {
      const gist = await res.json();
      const file = (gist.files || {})["status.json"];
      if (file) return { data: JSON.parse(file.content), source: "Gist" };
    }
  } catch (_) {}
  // ② 저장소 data/status.json 폴백 (오래됐어도 신선도 배지가 사실대로 표시)
  const res = await fetch("data/status.json?t=" + Date.now());
  if (!res.ok) throw new Error("상태 데이터를 가져올 수 없음 (Gist·저장소 모두 실패)");
  return { data: await res.json(), source: "저장소 스냅샷" };
}

function ageSeconds(data) {
  const ts = Number(data.updated_ts || 0);
  if (!ts) return null;
  return Math.max(0, Math.floor(Date.now() / 1000 - ts));
}

function fmtAge(s) {
  if (s == null) return "시각 정보 없음";
  if (s < 60) return s + "초 전";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}

async function loadStatus() {
  // 봇 API 주소가 명시되면 풍부한 데이터를 우선 사용
  if (hasBotApi()) {
    try {
      const [st, up] = await Promise.all([api("/api/status"), api("/api/uptime")]);
      renderFromBotApi(st, up);
      return;
    } catch (e) { /* 봇 API 실패 → 정적 소스 폴백 */ }
  }
  try {
    const { data, source } = await fetchStatusData();
    renderStatus(data, source);
  } catch (e) {
    $("banner-title").textContent = "상태를 불러올 수 없음";
    $("banner-meta").textContent = e.message;
    $("status-banner").className = "banner banner-down";
    $("svc-grid").innerHTML = '<div class="muted">데이터 없음</div>';
  }
}

function renderStatus(data, source) {
  const services = data.services || {};
  const keys = Object.keys(services);
  const avails = keys.map((k) => services[k].availability ?? 0);
  const overall = avails.length ? avails.reduce((a, b) => a + b, 0) / avails.length : 0;
  const down = keys.filter((k) => !services[k].running);
  const age = ageSeconds(data);
  const stale = age != null && age > STALE_WARN_S;
  const dead = age != null && age > STALE_DOWN_S;

  // 배너 — 신선도가 상태보다 우선 (낡은 데이터로 "정상"이라고 말하지 않는다)
  const b = $("status-banner");
  if (dead) {
    b.className = "banner banner-down";
    $("banner-title").textContent = "봇 오프라인 추정";
    $("banner-meta").textContent = `마지막 상태 수신 ${fmtAge(age)} (${data.updated_at || "?"}) · ${source}`;
  } else if (stale) {
    b.className = "banner banner-stale";
    $("banner-title").textContent = "데이터 지연";
    $("banner-meta").textContent = `마지막 상태 수신 ${fmtAge(age)} · ${source}`;
  } else if (down.length || data.blocked) {
    b.className = "banner banner-down";
    $("banner-title").textContent = "일부 서비스 장애";
    $("banner-meta").textContent =
      down.map((k) => SERVICE_LABELS[k] || k).join(", ") + " 다운 · " + fmtAge(age) + " 수신";
  } else {
    b.className = "banner banner-ok";
    $("banner-title").textContent = "모든 서비스 정상";
    const upt = data.uptime_s || 0;
    const h = Math.floor(upt / 3600), m = Math.floor((upt % 3600) / 60);
    $("banner-meta").textContent = `봇 가동 ${h}시간 ${m}분 · ${fmtAge(age)} 수신 · ${source}`;
  }
  $("overall-uptime").textContent = overall.toFixed(2) + "%";

  // 정보 칩
  const chips = [];
  if (data.rooms != null)    chips.push(`🏠 허용 방 ${data.rooms}개`);
  if (data.managers != null) chips.push(`🛡 매니저 ${data.managers}명`);
  if (data.auto_update != null) chips.push(data.auto_update ? "🔄 자동업데이트 ON" : "⏸ 자동업데이트 OFF");
  if (data.updated_at) chips.push("🕒 " + data.updated_at);
  $("status-chips").innerHTML = chips.map((c) => `<span class="info-chip">${esc(c)}</span>`).join("");

  // 서비스 카드 + 30시간 히스토리 타임라인
  const grid = $("svc-grid");
  if (!keys.length) { grid.innerHTML = '<div class="muted">데이터 없음</div>'; return; }
  grid.innerHTML = keys.map((k) => {
    const s = services[k] || {};
    const running = !!s.running;
    const pct = s.availability ?? 0;
    const color = pct >= 95 ? "var(--green)" : pct >= 80 ? "var(--orange)" : "var(--red)";
    const hist = Array.isArray(s.history) ? s.history : [];
    const slots = hist.length
      ? hist.map((c) => `<i style="background:${HIST_COLORS[c] || "var(--gray)"}"></i>`).join("")
      : '<span class="muted small">히스토리 없음</span>';
    return `<div class="svc-card">
      <div class="svc-head">
        <span class="svc-name">${esc(SERVICE_LABELS[k] || k)}</span>
        <span class="svc-state ${running && !dead ? "state-up" : "state-down"}">${dead ? "?" : running ? "정상" : "다운"}</span>
      </div>
      <div class="svc-bar"><i style="width:${pct}%;background:${color}"></i></div>
      <div class="svc-pct">가동률 ${pct.toFixed(2)}% · 표본 ${s.history_count || 0}개</div>
      <div class="svc-hist" title="최근 ${hist.length}시간 (1칸=1시간, 오른쪽이 최신)">${slots}</div>
    </div>`;
  }).join("");

  // 장애 요약 — 서비스별 히스토리에서 비정상 슬롯 집계
  const list = $("incident-list");
  const problems = keys.map((k) => {
    const hist = Array.isArray(services[k].history) ? services[k].history : [];
    const bad = hist.filter((c) => c !== "green").length;
    return { k, bad, total: hist.length };
  }).filter((p) => p.bad > 0);
  if (!problems.length) {
    list.innerHTML = '<div class="incident-empty">✓ 최근 30시간 내 기록된 장애가 없습니다.</div>';
  } else {
    list.innerHTML = problems.map((p) => `<div class="incident">
      <span class="ic-icon">🔴</span>
      <div class="ic-body">
        <div class="ic-title">${esc(SERVICE_LABELS[p.k] || p.k)}</div>
        <div class="ic-time">최근 ${p.total}시간 중 ${p.bad}시간 비정상</div>
      </div>
    </div>`).join("");
  }
}

function renderFromBotApi(st, up) {
  // 봇 로컬 API 연결 시 — 정적 소스와 같은 화면 구성으로 변환
  const data = {
    updated_ts: Math.floor(Date.now() / 1000),
    updated_at: st.ts || "",
    uptime_s: st.uptime_s || 0,
    services: st.services || {},
    blocked: !!st.blocked,
  };
  renderStatus(data, "봇 API");
}

/* ── 기능 요청 ── */
let META = { categories: ["버그","기능","개선","기타"], severities: ["낮음","보통","높음","긴급"], statuses: ["검토대기","진행중","해결","보류","미해결"] };
let REQS = [];
let FILTER = "all";

function fillSelect(el, opts) { el.innerHTML = opts.map((o) => `<option>${esc(o)}</option>`).join(""); }

async function loadRequests() {
  try {
    const d = await api("/api/requests");
    META = { categories: d.categories, severities: d.severities, statuses: d.statuses };
    REQS = d.requests || [];
    fillSelect($("req-category"), META.categories);
    fillSelect($("req-severity"), META.severities);
    $("req-severity").value = "보통";
    renderRequests();
  } catch (e) {
    const hint = hasBotApi()
      ? `불러오기 실패: ${esc(e.message)}`
      : "기능 요청은 봇 서버 연결이 필요합니다. 하단 \"API 서버 주소 설정\"에서 봇 주소를 입력하세요.";
    $("req-list").innerHTML = `<div class="muted">${hint}</div>`;
  }
}

function renderRequests() {
  const list = $("req-list");
  let items = REQS;
  if (FILTER !== "all") items = items.filter((r) => r.status === FILTER);
  if (!items.length) { list.innerHTML = '<div class="muted">요청이 없습니다.</div>'; return; }
  list.innerHTML = items.map(reqCard).join("");
  if (isOwner()) bindOwnerControls();
}

function reqCard(r) {
  const pending = !r.approved;
  const pendTag = pending ? `<span class="badge pending-tag">검토 대기중</span>` : "";
  const owner = isOwner() ? ownerControls(r) : "";
  return `<div class="req ${pending ? "pending" : ""}" data-id="${esc(r.id)}">
    <div class="req-top">
      <span class="req-title">${esc(r.title)}</span>
      <span class="req-badges">
        ${pendTag}
        <span class="badge b-cat">${esc(r.category)}</span>
        <span class="badge b-sev-${esc(r.severity)}">${esc(r.severity)}</span>
        <span class="badge b-st-${esc(r.status)}">${esc(r.status)}</span>
      </span>
    </div>
    ${r.detail ? `<div class="req-detail">${esc(r.detail)}</div>` : ""}
    <div class="req-meta">등록 ${esc(r.created_at)}${r.updated_at && r.updated_at !== r.created_at ? " · 수정 " + esc(r.updated_at) : ""}</div>
    ${owner}
  </div>`;
}

function ownerControls(r) {
  const statusOpts = META.statuses.map((s) => `<option ${s === r.status ? "selected" : ""}>${esc(s)}</option>`).join("");
  return `<div class="req-owner">
    ${r.approved ? "" : `<button class="approve" data-act="approve">승인</button>`}
    <select data-act="status">${statusOpts}</select>
    <button class="del" data-act="delete">삭제</button>
  </div>`;
}

function bindOwnerControls() {
  document.querySelectorAll(".req").forEach((card) => {
    const id = card.dataset.id;
    const approve = card.querySelector('[data-act="approve"]');
    const sel = card.querySelector('[data-act="status"]');
    const del = card.querySelector('[data-act="delete"]');
    if (approve) approve.onclick = () => act(`/api/requests/${id}/approve`, {});
    if (sel) sel.onchange = () => act(`/api/requests/${id}/update`, { status: sel.value });
    if (del) del.onclick = () => { if (confirm("삭제할까요?")) act(`/api/requests/${id}/delete`, {}); };
  });
}

async function act(path, body) {
  try { await api(path, { method: "POST", body: JSON.stringify(body) }); await loadRequests(); }
  catch (e) { alert("실패: " + e.message); }
}

$("btn-submit").addEventListener("click", async () => {
  const title = $("req-title").value.trim();
  const msg = $("submit-msg");
  if (!title) { msg.className = "form-msg err"; msg.textContent = "제목을 입력하세요."; return; }
  try {
    await api("/api/requests", { method: "POST", body: JSON.stringify({
      title, category: $("req-category").value, severity: $("req-severity").value, detail: $("req-detail").value.trim(),
    }) });
    msg.className = "form-msg ok"; msg.textContent = "등록되었습니다. 오너 승인 후 정식 반영됩니다.";
    $("req-title").value = ""; $("req-detail").value = "";
    await loadRequests();
  } catch (e) { msg.className = "form-msg err"; msg.textContent = "등록 실패: " + e.message; }
});

document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
  c.classList.add("active"); FILTER = c.dataset.filter; renderRequests();
}));

/* ── 오너 로그인 ── */
function reflectOwner() {
  $("owner-badge").classList.toggle("hidden", !isOwner());
  $("btn-owner").textContent = isOwner() ? "로그아웃" : "오너 로그인";
  renderRequests();
}
$("btn-owner").addEventListener("click", () => {
  if (isOwner()) { setToken(""); reflectOwner(); return; }
  $("login-modal").classList.remove("hidden"); $("login-pw").focus();
});
$("login-cancel").addEventListener("click", () => $("login-modal").classList.add("hidden"));
$("login-ok").addEventListener("click", async () => {
  const msg = $("login-msg");
  try {
    const d = await fetch(apiBase() + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("login-pw").value }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, j })));
    if (!d.ok) throw new Error(d.j.error || "로그인 실패");
    setToken(d.j.access_token);
    $("login-modal").classList.add("hidden"); $("login-pw").value = ""; msg.textContent = "";
    reflectOwner();
  } catch (e) { msg.className = "form-msg err"; msg.textContent = e.message; }
});

/* ── API 서버 주소 설정 ── */
$("btn-server").addEventListener("click", () => {
  const cur = localStorage.getItem(LS_API) || "";
  const v = prompt("봇 API 서버 주소 (예: http://1.2.3.4:5000)\n비우면 현재 사이트 주소 사용", cur);
  if (v === null) return;
  v.trim() ? localStorage.setItem(LS_API, v.trim()) : localStorage.removeItem(LS_API);
  refreshAll();
});

/* ── 새로고침 / 초기화 ── */
function refreshAll() {
  $("api-base-label").textContent = "API: " + apiBase();
  loadStatus(); loadRequests();
}
$("btn-refresh").addEventListener("click", refreshAll);
reflectOwner();
refreshAll();
setInterval(loadStatus, 15000);
