/* 냥이 Bot 대시보드 — 상태 + 기능 요청 (단일 SPA)
 * gh-pages 등 다른 출처에서 호스팅될 수 있으므로 API 서버 주소를 별도 설정한다.
 */
"use strict";

const LS_API = "nyang_api_base";
const LS_TOKEN = "nyang_owner_token";

// 봇이 주기적으로 상태를 푸시하는 Gist (gh-pages 등 어디서든 읽힘 — 봇 서버 불필요)
const GIST_ID = "dc6ae3a8ab59432353bd21e1f4d4b4f4";
const GIST_API = "https://api.github.com/gists/" + GIST_ID;
const SERVICE_LABELS = {
  server: "Iris 서버", frida: "Frida", kakao: "KakaoTalk",
  botprocess: "봇 프로세스", frida_hook: "Frida 후킹",
};

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

/* ── 상태 ── */
async function loadStatus() {
  // 봇 API 주소가 명시되면 풍부한 데이터(장애 타임라인 포함)를, 아니면 Gist 를 읽는다.
  if (hasBotApi()) {
    try {
      const [st, up] = await Promise.all([api("/api/status"), api("/api/uptime")]);
      renderBanner(st, up); renderServices(st, up); renderIncidents(up);
      return;
    } catch (e) { /* 봇 API 실패 → Gist 폴백 */ }
  }
  try {
    await loadStatusFromGist();
  } catch (e) {
    $("banner-title").textContent = "상태를 불러올 수 없음";
    $("banner-meta").textContent = e.message;
    $("status-banner").className = "banner banner-down";
  }
}

async function loadStatusFromGist() {
  const res = await fetch(GIST_API, { headers: { "Accept": "application/vnd.github+json" } });
  if (!res.ok) throw new Error("Gist HTTP " + res.status);
  const gist = await res.json();
  const file = (gist.files || {})["status.json"];
  if (!file) throw new Error("status.json 없음");
  const data = JSON.parse(file.content);
  const services = data.services || {};
  const keys = Object.keys(services);
  const avails = keys.map((k) => services[k].availability ?? 0);
  const overall = avails.length ? avails.reduce((a, b) => a + b, 0) / avails.length : 100;
  const down = keys.filter((k) => !services[k].running);

  const st = {
    uptime_s: data.uptime_s || 0,
    blocked: down.length > 0,
    services,
    service_labels: SERVICE_LABELS,
    ts: data.updated_at || "",
  };
  const up = {
    samples: Math.max(...keys.map((k) => services[k].history_count || 0), 0),
    overall_uptime: Math.round(overall * 100) / 100,
    services: Object.fromEntries(keys.map((k) => [k, {
      label: SERVICE_LABELS[k] || k, uptime: services[k].availability ?? 0,
    }])),
    // Gist 에는 장애 타임라인이 없어 현재 다운 서비스만 표기
    incidents: down.map((k) => ({
      start: data.updated_at || "", end: data.updated_at || "",
      samples: services[k].miss_count || 0, down: [SERVICE_LABELS[k] || k],
    })),
  };
  renderBanner(st, up); renderServices(st, up); renderIncidents(up);
  $("banner-meta").textContent += " · Gist 기준" + (data.updated_at ? ` (${data.updated_at})` : "");
}

function renderBanner(st, up) {
  const b = $("status-banner");
  const down = !!st.blocked;
  b.className = "banner " + (down ? "banner-down" : "banner-ok");
  $("banner-title").textContent = down ? "일부 서비스 장애" : "모든 서비스 정상";
  const upt = st.uptime_s || 0;
  const h = Math.floor(upt / 3600), m = Math.floor((upt % 3600) / 60);
  $("banner-meta").textContent = `프로세스 가동 ${h}시간 ${m}분 · 표본 ${up.samples || 0}개`;
  $("overall-uptime").textContent = (up.overall_uptime ?? 100).toFixed(2) + "%";
}

function renderServices(st, up) {
  const labels = st.service_labels || {};
  const svcs = st.services || {};
  const upMap = up.services || {};
  const grid = $("svc-grid");
  const keys = Object.keys(svcs);
  if (!keys.length) { grid.innerHTML = '<div class="muted">데이터 없음</div>'; return; }
  grid.innerHTML = keys.map((k) => {
    const s = svcs[k] || {};
    const running = !!s.running;
    const pct = (upMap[k] && upMap[k].uptime != null) ? upMap[k].uptime : (s.availability ?? 0);
    const color = pct >= 95 ? "var(--green)" : pct >= 80 ? "var(--orange)" : "var(--red)";
    return `<div class="svc-card">
      <div class="svc-head">
        <span class="svc-name">${esc(labels[k] || k)}</span>
        <span class="svc-state ${running ? "state-up" : "state-down"}">${running ? "정상" : "다운"}</span>
      </div>
      <div class="svc-bar"><i style="width:${pct}%;background:${color}"></i></div>
      <div class="svc-pct">가동률 ${pct.toFixed(2)}%</div>
    </div>`;
  }).join("");
}

function renderIncidents(up) {
  const list = $("incident-list");
  const inc = up.incidents || [];
  if (!inc.length) {
    list.innerHTML = '<div class="incident-empty">✓ 기록된 장애가 없습니다.</div>';
    return;
  }
  list.innerHTML = inc.map((i) => {
    const who = (i.down && i.down.length) ? i.down.join(", ") : "서비스 다운";
    const span = i.start === i.end ? i.start : `${i.start} → ${i.end}`;
    return `<div class="incident">
      <span class="ic-icon">🔴</span>
      <div class="ic-body">
        <div class="ic-title">${esc(who)}</div>
        <div class="ic-time">${esc(span)} · 표본 ${i.samples}개</div>
      </div>
    </div>`;
  }).join("");
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
