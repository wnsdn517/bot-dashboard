/* 냥이 Bot 대시보드 — 상태 + 기능 요청 (단일 SPA)
 * gh-pages 등 다른 출처에서 호스팅될 수 있으므로 API 서버 주소를 별도 설정한다.
 */
"use strict";

const LS_API = "nyang_api_base";
const LS_TOKEN = "nyang_owner_token";

// ── 상태 데이터 ────────────────────────────────────────────────────────────
// 1) data/meta.json 에서 gist id 자동 발견 (봇이 기록) → 2) Gist 읽기
// 3) 실패 시 같은 저장소의 data/status.json 폴백
// 신선도 검사: 마지막 수신이 3분 넘으면 "데이터 지연", 5분 넘으면 "봇 오프라인 추정"
// — 이전 버전은 몇 주 전 데이터도 "모든 서비스 정상"으로 표시하는 문제가 있었다.
const FALLBACK_GIST_ID = "dc6ae3a8ab59432353bd21e1f4d4b4f4";
const STALE_WARN_S = 3 * 60;
const STALE_DOWN_S = 5 * 60;
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

function isBad(color) { return color !== "green" && color !== "gray" && color !== "none"; }

function slotTimes(data, count) {
  // 시간별 슬롯의 시각 복원: history_ts = 마지막 슬롯 기록 시각, 간격 1시간
  const interval = Number(data.history_interval_s || 3600);
  const last = Number(data.history_ts || data.updated_ts || Math.floor(Date.now() / 1000));
  const out = [];
  for (let i = 0; i < count; i++) out.push(last - (count - 1 - i) * interval);
  return out;
}

function fmtHour(ts) {
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}시`;
}
function fmtDay(dayStr) {
  const p = String(dayStr).split("-");
  return p.length === 3 ? `${p[1]}/${p[2]}` : dayStr;
}

// 오프라인 갭: 마지막 수신(updated_ts)부터 현재까지 STALE_DOWN_S 넘게 데이터가 없으면
// 그 구간은 봇이 상태를 못 보낸 것 = 전체 다운. 히스토리는 봇이 살아있을 때만 찍히므로
// 이 갭을 클라이언트가 '진행 중 장애'로 합성해야 한다 (안 그러면 마지막 초록에 얼어붙음).
function offlineGap(data) {
  const age = ageSeconds(data);
  if (age == null || age <= STALE_DOWN_S) return null;
  const last = Number(data.updated_ts || 0);
  return { startTs: last, seconds: age };
}
function fmtDuration(s) {
  if (s < 3600) return Math.round(s / 60) + "분";
  if (s < 86400) return Math.round(s / 3600) + "시간";
  const d = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return h ? `${d}일 ${h}시간` : `${d}일`;
}

function renderStatus(data, source) {
  const services = data.services || {};
  const keys = Object.keys(services);
  const active = keys.filter((k) => !services[k].disabled);
  const avails = active.map((k) => services[k].availability ?? 0);
  const overall = avails.length ? avails.reduce((a, b) => a + b, 0) / avails.length : 0;
  const down = active.filter((k) => !services[k].running);
  const age = ageSeconds(data);
  const stale = age != null && age > STALE_WARN_S;
  const dead = age != null && age > STALE_DOWN_S;

  // 배너 — 신선도가 상태보다 우선 (낡은 데이터로 "정상"이라고 말하지 않는다)
  const b = $("status-banner");
  if (dead) {
    b.className = "banner banner-down";
    $("banner-title").textContent = "봇 오프라인 (상태 미수신)";
    $("banner-meta").textContent = `${fmtDuration(age)}째 상태 미수신 — 서비스 다운 · 마지막 ${data.updated_at || "?"}`;
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

  // 서비스 행 — 90일 일별 뷰 고정. daily 없으면 90칸 '미기록' 틀 + 시간별 데이터 병기.
  const gap = offlineGap(data);
  const anyDaily = keys.some((k) => Array.isArray(services[k].daily) && services[k].daily.length);
  const unitEl = $("svc-unit");
  if (unitEl) unitEl.textContent = anyDaily
    ? "(최근 90일, 1칸=1일)"
    : "(90일 기록 수집 중 · 아래는 최근 30시간)";

  const grid = $("svc-grid");
  if (!keys.length) { grid.innerHTML = '<div class="muted">데이터 없음</div>'; return; }
  grid.innerHTML = keys.map((k) => {
    const s = services[k] || {};
    const disabled = !!s.disabled;
    const running = !!s.running;
    const pct = s.availability ?? 0;
    const state = disabled
      ? '<span class="svc-state state-off">미사용</span>'
      : dead
        ? '<span class="svc-state state-down">다운</span>'
        : running
          ? '<span class="svc-state state-up">정상</span>'
          : '<span class="svc-state state-down">다운</span>';

    // 90칸 고정: daily가 있으면 최근 90일로 패딩(앞을 none), 없으면 전부 none.
    const daily90 = padDaily(Array.isArray(s.daily) ? s.daily : []);
    const slotsHtml = daily90.map((slot) => {
      const c = slot.color || "none";
      const bg = c === "none" ? "var(--slot-none)" : (HIST_COLORS[c] || "var(--gray)");
      const tip = c === "none" ? `${fmtDay(slot.day)} · 기록 없음`
        : `${fmtDay(slot.day)} · 가동률 ${slot.uptime != null ? slot.uptime + "%" : c}`;
      return `<i style="background:${bg}" title="${esc(tip)}"></i>`;
    }).join("");
    const axisHtml = `<div class="svc-axis"><span>${esc(fmtDay(daily90[0].day))}</span><span>오늘</span></div>`;

    // 오프라인 갭(미사용 제외) — 타임라인 끝에 '미수신' 빗금 슬롯. 무응답이면 가동률도 흐리게.
    const gapSlot = (gap && !disabled)
      ? `<i class="slot-gap" title="상태 미수신 ${fmtDuration(gap.seconds)} — 봇 오프라인"></i>` : "";
    const uptimeHtml = disabled
      ? '<span class="svc-uptime">—</span>'
      : dead
        ? '<span class="svc-uptime dim" title="상태 미수신 — 마지막 기록 기준">' + pct.toFixed(2) + "%</span>"
        : '<span class="svc-uptime">' + pct.toFixed(2) + "%</span>";

    return `<div class="svc-row ${disabled ? "svc-disabled" : ""}">
      <div class="svc-head">
        <span class="svc-name">${esc(SERVICE_LABELS[k] || k)}</span>
        ${uptimeHtml}
        ${state}
      </div>
      <div class="svc-hist" data-unit="90일">${slotsHtml}${gapSlot}</div>
      ${axisHtml}
    </div>`;
  }).join("");

  renderIncidents(data, keys, services, gap);
}

// daily 배열을 정확히 90칸으로 — 데이터가 모자라면 앞쪽을 '미기록'(none)으로 채운다.
function padDaily(daily) {
  const N = 90;
  const base = new Date();
  const out = [];
  const byDay = {};
  daily.forEach((s) => { if (s && s.day) byDay[s.day] = s; });
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(base); d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push(byDay[ds] || { day: ds, color: "none" });
  }
  return out;
}

function pushDay(incidents, label, daily, s, e, seg) {
  const dayTs = (ds) => { const p = String(ds).split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 1000; };
  const days = e - s + 1;
  incidents.push({
    title: label + (seg === "partial" ? " 부분 오류" : " 장애"),
    startTs: dayTs(daily[s].day), endTs: dayTs(daily[e].day) + 86399,
    dayMode: true, ongoing: false, partial: seg === "partial",
    durStr: days === 1 ? "1일" : days + "일", icon: seg === "partial" ? "🟠" : "🔴",
  });
}

function renderIncidents(data, keys, services, gap) {
  const list = $("incident-list");
  const incidents = [];

  // ① 오프라인 갭 = 최우선 장애 (봇이 상태를 못 보낸 구간 = 전체 다운)
  if (gap) {
    incidents.push({
      title: "봇 오프라인 (전체 상태 미수신)",
      startTs: gap.startTs, ongoing: true,
      durStr: fmtDuration(gap.seconds), icon: "🔴",
    });
  }

  // ② 서비스별 장애 구간 복원 — 일별(90일) 우선, 없으면 시간별(30시간)
  const dayTs = (ds) => { const p = String(ds).split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 1000; };
  keys.forEach((k) => {
    if (services[k].disabled) return;
    const label = SERVICE_LABELS[k] || k;
    const daily = Array.isArray(services[k].daily) ? services[k].daily : null;
    if (daily && daily.length) {
      // 같은 성격(red=장애 / orange=부분 오류)의 연속 구간을 묶는다
      let start = -1, seg = null;
      for (let i = 0; i <= daily.length; i++) {
        const c = i < daily.length ? daily[i].color : null;
        const kind = c === "red" ? "down" : c === "orange" ? "partial" : null;
        if (kind && kind !== seg) {   // 종류가 바뀌면 이전 구간 마감
          if (start >= 0) pushDay(incidents, label, daily, start, i - 1, seg);
          start = i; seg = kind;
        } else if (!kind && start >= 0) {
          pushDay(incidents, label, daily, start, i - 1, seg);
          start = -1; seg = null;
        }
      }
    } else {
      const hist = Array.isArray(services[k].history) ? services[k].history : [];
      const times = slotTimes(data, hist.length);
      let start = -1;
      for (let i = 0; i <= hist.length; i++) {
        const bad = i < hist.length && isBad(hist[i]);
        if (bad && start < 0) start = i;
        if (!bad && start >= 0) {
          const ongoing = i === hist.length && isBad(hist[hist.length - 1]);
          incidents.push({
            title: label + (ongoing ? " 장애 진행 중" : " 장애"),
            startTs: times[start], endTs: times[i - 1], ongoing,
            durStr: "약 " + (i - start) + "시간", icon: ongoing ? "🔴" : "🟠",
          });
          start = -1;
        }
      }
    }
  });

  // 진행 중 장애는 헤드라인(상단 배너)에 — 닫기(X) 가능
  renderTopbar(incidents.filter((i) => i.ongoing), data);

  if (!incidents.length) {
    list.innerHTML = '<div class="incident-empty">✓ 최근 기록에 장애가 없습니다.</div>';
    return;
  }
  incidents.sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  list.innerHTML = incidents.slice(0, 15).map((i) => {
    let when;
    if (i.dayMode) {
      const s = fmtDay(new Date(i.startTs * 1000).toISOString().slice(0, 10));
      const e = fmtDay(new Date(i.endTs * 1000).toISOString().slice(0, 10));
      when = (s === e ? s : `${s} ~ ${e}`) + ` · ${i.durStr}`;
    } else if (i.endTs != null) {
      when = `${fmtHour(i.startTs)} ~ ${i.ongoing ? "현재" : fmtHour(i.endTs)} · ${i.durStr}`;
    } else {
      when = `${fmtHour(i.startTs)} ~ 현재 · ${i.durStr}`;
    }
    return `<div class="incident ${i.ongoing ? "ongoing" : ""}">
      <span class="ic-icon">${i.icon}</span>
      <div class="ic-body">
        <div class="ic-title">${esc(i.title)}</div>
        <div class="ic-time">${esc(when)}</div>
      </div>
    </div>`;
  }).join("");
}

let _dismissedTopbar = "";
function renderTopbar(ongoing, data) {
  const bar = $("incident-topbar");
  if (!ongoing.length) { bar.classList.add("hidden"); return; }
  // 진행 중 장애 목록을 지문(sig)으로 — 같은 장애를 닫았으면 다시 안 띄운다
  const sig = ongoing.map((i) => i.title).join("|") + "@" + Math.floor((data.updated_ts || 0) / 300);
  if (_dismissedTopbar === sig) { bar.classList.add("hidden"); return; }
  const top = ongoing[0];
  const extra = ongoing.length > 1 ? ` 외 ${ongoing.length - 1}건` : "";
  const when = top.dayMode ? top.durStr
    : (top.startTs ? `${fmtHour(top.startTs)} ~ 현재 · ${top.durStr}` : top.durStr);
  bar.className = "incident-topbar";
  bar.innerHTML = `
    <span class="ic-icon">🔴</span>
    <div class="it-body">
      <div class="it-title">진행 중: ${esc(top.title)}${esc(extra)}</div>
      <div class="it-desc">${esc(when)}</div>
    </div>
    <button class="it-close" title="닫기">✕</button>`;
  bar.querySelector(".it-close").onclick = () => { _dismissedTopbar = sig; bar.classList.add("hidden"); };
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
