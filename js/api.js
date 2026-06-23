/**
 * api.js — GitHub Pages 기반 대시보드 API 레이어
 *
 * 상태 읽기: 같은 Pages 도메인의 data/status.json 직접 fetch (인증 불필요)
 * RCS 명령:  GitHub API로 data/commands.json 업데이트 (GitHub 토큰 + HMAC 서명)
 *
 * 보안: HMAC-SHA256(RFC 2104) 서명 — 봇이 검증 후 실행
 */

// ── 설정 저장 ─────────────────────────────────────────────────────────────────

export function getSettings() {
  return {
    ghToken:   localStorage.getItem("gh_token")   || "",
    rcsSecret: localStorage.getItem("rcs_secret") || "",
    owner:     localStorage.getItem("gh_owner")   || "",
    repo:      localStorage.getItem("gh_repo")    || "",
    branch:    localStorage.getItem("gh_branch")  || "gh-pages",
  };
}

export function saveSettings({ ghToken, rcsSecret, owner, repo, branch }) {
  if (ghToken   !== undefined) localStorage.setItem("gh_token",   ghToken);
  if (rcsSecret !== undefined) localStorage.setItem("rcs_secret", rcsSecret);
  if (owner     !== undefined) localStorage.setItem("gh_owner",   owner);
  if (repo      !== undefined) localStorage.setItem("gh_repo",    repo);
  if (branch    !== undefined) localStorage.setItem("gh_branch",  branch);
}

export function isConfigured() {
  const s = getSettings();
  return !!(s.ghToken && s.rcsSecret && s.owner && s.repo);
}

// ── 상태 읽기 ────────────────────────────────────────────────────────────────
// 1순위: Gist API (gh-pages 빌드 없음, CDN 없음, 항상 최신)
// 2순위: GitHub Contents API 폴백

function _inferRepoFromUrl() {
  const host = location.hostname;
  const path = location.pathname;
  if (!host.endsWith(".github.io")) return null;
  const owner = host.split(".")[0];
  const repo  = path.split("/").filter(Boolean)[0];
  return repo ? { owner, repo } : null;
}

// meta.json에서 gist_id를 조회 후 캐싱 (실패하면 재시도 허용)
const _FALLBACK_GIST_ID = "dc6ae3a8ab59432353bd21e1f4d4b4f4";
let _gistId       = null;
let _gistIdFetched = false;

async function _resolveGistId(owner, repo, branch, ghToken) {
  if (_gistIdFetched && _gistId) return _gistId;  // 성공한 캐시만 재사용
  try {
    const headers = { "Accept": "application/vnd.github+json" };
    if (ghToken) headers["Authorization"] = `Bearer ${ghToken}`;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/data/meta.json?ref=${branch}`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const meta = JSON.parse(atob(data.content.replace(/\n/g, "")));
      _gistId = meta.status_gist_id || _FALLBACK_GIST_ID;
      _gistIdFetched = true;
    }
  } catch (_) {}
  return _gistId || _FALLBACK_GIST_ID;  // fetch 실패시 하드코딩 폴백
}

export async function getStatus() {
  const s = getSettings();
  const inferred = _inferRepoFromUrl();
  const owner = s.owner  || inferred?.owner || "";
  const repo  = s.repo   || inferred?.repo  || "";
  const ref   = s.branch || "gh-pages";
  const headers = { "Accept": "application/vnd.github+json" };
  if (s.ghToken) headers["Authorization"] = `Bearer ${s.ghToken}`;

  // 1순위: Gist API (owner/repo 있으면 meta.json 경유, 없으면 하드코딩 폴백 직접 사용)
  const gistId = owner && repo
    ? await _resolveGistId(owner, repo, ref, s.ghToken)
    : _FALLBACK_GIST_ID;
  if (gistId) {
    try {
      const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        const content = data.files?.["status.json"]?.content;
        if (content) return JSON.parse(content);
      }
    } catch (_) {}
  }

  // 폴백: GitHub Contents API (gh-pages)
  if (owner && repo) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/data/status.json?ref=${ref}`,
        { headers }
      );
      if (res.ok) {
        const data = await res.json();
        return JSON.parse(atob(data.content.replace(/\n/g, "")));
      }
    } catch (_) {}
  }

  return null;
}

// ── GitHub API 헬퍼 ──────────────────────────────────────────────────────────

async function ghFetch(path, options = {}) {
  const { ghToken, owner, repo } = getSettings();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    "Authorization": `Bearer ${ghToken}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

async function ghGetFile(path) {
  const { branch } = getSettings();
  const res = await ghFetch(path + "?ref=" + branch);
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ""));
  return { content, sha: data.sha };
}

async function ghPutFile(path, contentStr, sha, message) {
  const { branch } = getSettings();
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(contentStr))),
    branch,
    ...(sha ? { sha } : {}),
  };
  const res = await ghFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub PUT 실패 (${res.status})`);
  }
  return true;
}

// ── HMAC-SHA256 서명 (SubtleCrypto, 표준 Web API) ────────────────────────────

async function sign(cmdId, action, issuedAt) {
  const { rcsSecret } = getSettings();
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey(
    "raw", enc.encode(rcsSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const msg  = enc.encode(`${cmdId}|${action}|${issuedAt}`);
  const sig  = await crypto.subtle.sign("HMAC", key, msg);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── 명령 생성 및 전송 ─────────────────────────────────────────────────────────

function genId() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

export async function sendCommand(action, params = {}) {
  if (!isConfigured()) throw new Error("설정이 필요합니다 (토큰·시크릿)");

  const cmdId    = genId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const sig      = await sign(cmdId, action, issuedAt);

  const newCmd = {
    id: cmdId, action, params,
    issued_at: issuedAt, sig,
    done: false, executed_at: null, result: null,
  };

  // 현재 commands.json 읽기 → 명령 추가 → 다시 쓰기
  let data = { commands: [] };
  let sha  = null;
  try {
    const file = await ghGetFile("data/commands.json");
    if (file.content) {
      data = JSON.parse(file.content);
      sha  = file.sha;
    }
  } catch (_) {}

  data.commands = [...(data.commands || []), newCmd];
  await ghPutFile(
    "data/commands.json",
    JSON.stringify(data, null, 2),
    sha,
    `rcs: ${action} command`
  );
  return cmdId;
}

// ── RCS 헬퍼 ─────────────────────────────────────────────────────────────────

export const rcsAnnounce    = (message, rooms)  => sendCommand("announce",       { message, ...(rooms ? { rooms } : {}) });
export const rcsRestart     = ()                => sendCommand("restart",         {});
export const rcsSetUpdate   = (enabled)         => sendCommand("update_toggle",  { enabled });
export const rcsRoomAdd     = (room_id)         => sendCommand("room_add",       { room_id });
export const rcsRoomRemove  = (room_id)         => sendCommand("room_remove",    { room_id });
export const rcsManagerAdd  = (user_id)         => sendCommand("manager_add",    { user_id });
export const rcsManagerRemove = (user_id)       => sendCommand("manager_remove", { user_id });
export const rcsShell       = (command)         => sendCommand("shell",          { command });

// ── 방문 기록 (Gist visits.json) ─────────────────────────────────────────────

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _deviceId() {
  let id = localStorage.getItem("_device_id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("_device_id", id); }
  return id;
}

export async function recordVisit() {
  const s = getSettings();
  if (!s.ghToken) return;
  const inferred = _inferRepoFromUrl();
  const owner = s.owner || inferred?.owner || "";
  const repo  = s.repo  || inferred?.repo  || "";

  const gistId = owner && repo
    ? await _resolveGistId(owner, repo, s.branch || "gh-pages", s.ghToken)
    : _FALLBACK_GIST_ID;
  if (!gistId) return;

  const today   = _todayStr();
  const sessKey = `_v_${today}`;
  const devId   = _deviceId();
  const isNew   = !localStorage.getItem(sessKey);

  const headers = { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${s.ghToken}` };
  try {
    const res  = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    let visits;
    try { visits = JSON.parse(data.files?.["visits.json"]?.content || "{}"); } catch { visits = {}; }
    if (!Array.isArray(visits.days)) visits.days = [];

    let entry = visits.days.find(d => d.date === today);
    if (!entry) { entry = { date: today, total: 0, unique: 0, ids: [] }; visits.days.push(entry); }
    if (!Array.isArray(entry.ids)) entry.ids = [];

    entry.total++;
    if (isNew && !entry.ids.includes(devId)) { entry.unique++; entry.ids.push(devId); }
    visits.days = visits.days.slice(-30);

    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ files: { "visits.json": { content: JSON.stringify(visits, null, 2) } } }),
    });
    if (isNew) localStorage.setItem(sessKey, "1");
  } catch (_) {}
}

export async function getVisits() {
  const s = getSettings();
  const inferred = _inferRepoFromUrl();
  const owner = s.owner || inferred?.owner || "";
  const repo  = s.repo  || inferred?.repo  || "";
  const gistId = owner && repo
    ? await _resolveGistId(owner, repo, s.branch || "gh-pages", s.ghToken)
    : _FALLBACK_GIST_ID;
  if (!gistId) return null;
  const headers = { "Accept": "application/vnd.github+json" };
  if (s.ghToken) headers["Authorization"] = `Bearer ${s.ghToken}`;
  try {
    const res  = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.files?.["visits.json"]?.content;
    return content ? JSON.parse(content) : null;
  } catch { return null; }
}

// ── 명령 결과 폴링 ────────────────────────────────────────────────────────────

export async function waitForResult(cmdId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const { branch } = getSettings();
      const { content } = await ghGetFile("data/commands.json");
      if (!content) continue;
      const data = JSON.parse(content);
      const cmd  = (data.commands || []).find(c => c.id === cmdId);
      if (cmd?.done) return cmd.result;
    } catch (_) {}
  }
  return null;
}
