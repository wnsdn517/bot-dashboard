import { getStatus } from "./api.js?v=20260623e";

let _uptimeBase = null; // { uptime_s, since_ts, autoUpdate }

const SERVICE_NAMES = {
  server:     "Server",
  frida:      "Frida",
  kakao:      "KakaoTalk",
  botprocess: "Bot Process",
  frida_hook: "Frida Hook",
};

const CORE_SERVICES = ["server", "frida", "kakao", "botprocess"];

const STATUS_LABEL = {
  green:   "정상",
  gray:    "정상",
  orange:  "불안정",
  red:     "이상",
  darkred: "중단",
};

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// 업타임 + 갱신 시각 1초마다 실시간 업데이트
function tickUptime() {
  if (!_uptimeBase) return;
  const elapsed = Math.floor(Date.now() / 1000) - _uptimeBase.since_ts;
  const meta = fmt(_uptimeBase.uptime_s + elapsed) +
    (_uptimeBase.autoUpdate ? " · 자동업데이트 ON" : " · 자동업데이트 OFF");
  set("status-meta", meta);
  if (_uptimeBase.status_ts) renderUpdatedAt(_uptimeBase.status_ts);
}

function _colorToCls(color) {
  if (color === "green" || color === "gray") return "green";
  if (color === "orange")                    return "yellow";
  if (color === "red" || color === "darkred") return "red";
  return "empty";
}

function makeUptimeBar(info, offline) {
  const SEGS = 30;
  // history: oldest→newest 순, 최대 SEGS-1개 (마지막 칸은 현재 상태)
  const history = Array.isArray(info.history) ? info.history : [];

  const bar = document.createElement("div");
  bar.className = "uptime-bar";

  for (let i = 0; i < SEGS; i++) {
    const seg = document.createElement("div");
    let cls;

    if (i === SEGS - 1) {
      // 오른쪽 끝 = 현재 상태
      cls = offline ? "empty" : (info.running ? _colorToCls(info.color || "green") : "red");
    } else {
      // 과거 슬롯: history를 오른쪽 정렬 (왼쪽 빈 칸 = 데이터 없음)
      const hi = history.length - (SEGS - 1) + i;
      cls = hi < 0 ? "empty" : _colorToCls(history[hi]);
    }

    seg.className = "bar-seg " + cls;
    bar.appendChild(seg);
  }
  return bar;
}

function renderServiceList(services, offline) {
  const list = document.getElementById("svc-list");
  if (!list) return;
  list.innerHTML = "";

  const ORDER = ["server", "frida", "kakao", "botprocess", "frida_hook"];
  const entries = [
    ...ORDER.filter(k => services[k]).map(k => [k, services[k]]),
    ...Object.entries(services).filter(([k]) => !ORDER.includes(k)),
  ];

  if (!entries.length) {
    list.innerHTML = '<div class="svc-loading">서비스 정보 없음</div>';
    return;
  }

  for (const [name, info] of entries) {
    const row = document.createElement("div");
    row.className = "svc-row";

    // 상태 점
    const dot = document.createElement("div");
    const color = offline ? "gray" : (info.color || (info.running ? "green" : "red"));
    dot.className = `svc-dot ${color}`;
    row.appendChild(dot);

    // 서비스 이름
    const nameEl = document.createElement("span");
    nameEl.className = "svc-name";
    nameEl.textContent = SERVICE_NAMES[name] || name;
    row.appendChild(nameEl);

    // 업타임 바
    row.appendChild(makeUptimeBar(info, offline));

    // 가용률 (history 기반, 없으면 현재 상태로 추정)
    const pct = document.createElement("span");
    pct.className = "svc-pct";
    const hist = Array.isArray(info.history) ? info.history : [];
    const avail = hist.length > 0
      ? (hist.filter(h => h === "green" || h === "gray").length / hist.length * 100)
      : (info.running ? 100 : 0);
    pct.style.color = offline ? "var(--muted)"
      : avail >= 95 ? "var(--green)"
      : avail >= 80 ? "var(--yellow)"
      : "var(--red)";
    pct.textContent = avail.toFixed(1) + "%";
    row.appendChild(pct);

    // 상태 라벨
    const label = document.createElement("span");
    label.className = "svc-status-label";
    label.textContent = offline ? "오프라인" : (STATUS_LABEL[info.color] || (info.running ? "정상" : "중단"));
    row.appendChild(label);

    list.appendChild(row);
  }
}

function updateBanner(offline, services) {
  const banner    = document.getElementById("status-banner");
  const indicator = document.getElementById("status-indicator");
  const title     = document.getElementById("status-title");
  if (!banner || !indicator || !title) return;

  if (offline) {
    banner.className    = "status-banner offline";
    indicator.className = "status-indicator offline";
    title.textContent   = "봇 오프라인";
    return;
  }

  const coreVals = CORE_SERVICES.map(k => services[k]).filter(Boolean);
  const allGood = coreVals.every(s => s.running) && coreVals.every(s => s.color === "green");
  const anyDown = coreVals.some(s => !s.running);

  if (anyDown) {
    banner.className    = "status-banner error";
    indicator.className = "status-indicator error";
    const n = coreVals.filter(s => !s.running).length;
    title.textContent   = `${n}개 서비스에 이상이 감지되었습니다`;
  } else if (!allGood) {
    banner.className    = "status-banner warn";
    indicator.className = "status-indicator warn";
    title.textContent   = "일부 서비스가 불안정합니다";
  } else {
    banner.className    = "status-banner ok";
    indicator.className = "status-indicator ok";
    title.textContent   = "모든 시스템이 정상 운영 중입니다";
  }
}

function renderUpdatedAt(ts) {
  const el = document.getElementById("last-updated");
  if (!el || !ts) return;
  const age = Math.floor(Date.now() / 1000) - ts;
  let label;
  if      (age < 60)       label = `${age}초 전`;
  else if (age < 3600)     label = `${Math.floor(age / 60)}분 전`;
  else if (age < 86400)    label = `${Math.floor(age / 3600)}시간 전`;
  else                     label = `${Math.floor(age / 86400)}일 전`;
  el.textContent = label + " 갱신";
  el.style.color = age > 180 ? "var(--red)" : "var(--muted)";
}

export async function refreshDashboard() {
  const status = await getStatus();
  if (!status) {
    const b = document.getElementById("status-banner");
    const i = document.getElementById("status-indicator");
    if (b) b.className = "status-banner offline";
    if (i) i.className = "status-indicator offline";
    set("status-title", "상태 데이터를 불러올 수 없습니다");
    set("last-updated", "연결 실패");
    return;
  }

  const age     = status.updated_ts ? Math.floor(Date.now() / 1000) - status.updated_ts : Infinity;
  const offline = age > 180;

  updateBanner(offline, status.services || {});
  renderServiceList(status.services || {}, offline);
  renderUpdatedAt(status.updated_ts);

  if (offline) {
    _uptimeBase = null;
    set("status-meta", "봇이 응답하지 않습니다");
  } else {
    _uptimeBase = {
      uptime_s:   (status.uptime_s || 0) + age,
      since_ts:   Math.floor(Date.now() / 1000),
      autoUpdate: status.auto_update,
      status_ts:  status.updated_ts,
    };
    tickUptime();
  }
}

export function startAutoRefresh(ms = 15000) {
  refreshDashboard();
  setInterval(tickUptime, 1000);
  return setInterval(refreshDashboard, ms);
}
