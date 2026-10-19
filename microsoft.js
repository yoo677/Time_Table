// Microsoft 학교 계정 연동: Teams 과제(Microsoft Graph Education API).
// 브라우저에서 OAuth 2.0 인증 코드 + PKCE 흐름을 직접 처리한다(라이브러리 없음).
// 팝업으로 로그인하고 auth.html이 돌려받은 코드를 토큰으로 바꾼다.
// 단일 페이지 앱(SPA)용 refresh token은 24시간 유효해서, 그동안은 팝업 없이 갱신된다.
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const CLIENT_ID = CFG.microsoftClientId || '';
  const TENANT = CFG.microsoftTenantId || 'organizations';
  const AUTHORITY = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
  const REDIRECT_URI = new URL('auth.html', location.href).href.split(/[?#]/)[0];
  const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'EduAssignments.ReadBasic'];
  const KEY = 'timetable.microsoft';
  const ACC = { id: 'microsoft-school', kind: 'school', label: 'Microsoft 학교 계정', services: ['Teams 과제'] };
  const SYNC_EVERY = 10 * 60 * 1000;
  const PAST_DAYS = 30;

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  let busy = false;
  const listeners = new Set();

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* 무시 */ } }
  function emit() { listeners.forEach(fn => fn()); }
  function set(patch) { saved = { ...saved, ...patch }; persist(); emit(); }
  const tokenValid = () => saved.token && saved.exp > Date.now() + 60 * 1000;
  const refreshValid = () => saved.refresh && saved.refreshExp > Date.now() + 60 * 1000;

  // ───────── PKCE ─────────
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function randomString(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a);
  }
  async function challengeOf(verifier) {
    return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  }

  // ───────── 오류 설명 ─────────
  function explain(code, desc) {
    const d = desc || '';
    if (/AADSTS90094|AADSTS90008|admin.*(approval|consent)|관리자/i.test(d) || code === 'consent_required') {
      return '학교 관리자 승인이 필요하다. 로그인 창의 승인 요청 버튼으로 요청하거나, 학교 Microsoft 365 관리자에게 이 앱(Time Table)의 관리자 동의를 부탁해야 한다.';
    }
    if (/AADSTS50011/i.test(d)) return `리디렉션 주소가 앱 등록과 다르다. Entra의 앱 등록 → 인증에 ${REDIRECT_URI} 를 단일 페이지 애플리케이션으로 추가한다.`;
    if (/AADSTS700016/i.test(d)) return '클라이언트 ID나 테넌트 ID가 잘못되었다. config.js 값을 확인한다.';
    if (/AADSTS9002326/i.test(d)) return '앱 등록의 리디렉션 플랫폼이 웹으로 되어 있다. 단일 페이지 애플리케이션(SPA)으로 바꿔야 한다.';
    if (code === 'access_denied') return '로그인이 취소되었거나 접근이 거부되었다.';
    return `로그인 오류: ${d || code}`;
  }

  // ───────── 로그인 팝업 ─────────
  let pending = null;

  function onAuthResult(href) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearInterval(p.timer);
    try { p.win && p.win.close(); } catch (e) { /* 무시 */ }
    const u = new URL(href);
    const q = new URLSearchParams(u.search || u.hash.slice(1));
    if (q.get('state') !== p.state) return p.reject(new Error('로그인 응답이 이 요청과 맞지 않는다. 다시 시도한다.'));
    if (q.get('error')) return p.reject(new Error(explain(q.get('error'), q.get('error_description'))));
    const code = q.get('code');
    if (!code) return p.reject(new Error('로그인 응답에 코드가 없다.'));
    p.resolve({ code, verifier: p.verifier });
  }

  window.addEventListener('message', e => {
    if (e.origin === location.origin && e.data && e.data.type === 'timetable-auth') onAuthResult(e.data.href);
  });
  window.addEventListener('storage', e => {
    if (e.key !== 'timetable.ms.auth' || !e.newValue) return;
    try { onAuthResult(JSON.parse(e.newValue).href); } catch (err) { /* 무시 */ }
  });

  // 클릭 직후 동기적으로 팝업을 먼저 연다(그래야 차단되지 않는다). 주소는 나중에 넣는다
  function loginPopup(prompt) {
    const win = window.open('', 'timetable-ms-login', 'width=500,height=680');
    return new Promise(async (resolve, reject) => {
      if (!win) return reject(new Error('팝업이 차단되었다. 브라우저에서 이 사이트의 팝업을 허용한다.'));
      const verifier = randomString(48);
      const state = randomString(16);
      const challenge = await challengeOf(verifier);
      const url = new URL(`${AUTHORITY}/authorize`);
      Object.entries({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        response_mode: 'query',
        scope: SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt,
        login_hint: saved.email || '',
      }).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
      try { localStorage.removeItem('timetable.ms.auth'); } catch (e) { /* 무시 */ }
      pending = { resolve, reject, state, verifier, win, timer: null };
      win.location.href = url.toString();
      // 창이 그냥 닫히면 취소로 본다(결과가 늦게 오는 경우를 위해 잠깐 기다린다)
      pending.timer = setInterval(() => {
        if (!pending || pending.win !== win) return;
        if (win.closed) {
          setTimeout(() => {
            if (pending && pending.win === win) {
              clearInterval(pending.timer);
              pending = null;
              reject(new Error('로그인 창이 닫혔다.'));
            }
          }, 800);
          clearInterval(pending.timer);
        }
      }, 500);
    });
  }

  async function tokenRequest(params) {
    const res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES.join(' '), ...params }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(explain(data.error, data.error_description));
    return data;
  }

  function storeTokens(t) {
    set({
      token: t.access_token,
      exp: Date.now() + (Number(t.expires_in) || 3600) * 1000,
      // SPA refresh token은 24시간. 쓸 때마다 새것으로 바뀐다
      refresh: t.refresh_token || saved.refresh || null,
      refreshExp: t.refresh_token ? Date.now() + 24 * 3600 * 1000 - 5 * 60 * 1000 : saved.refreshExp || 0,
    });
  }

  async function ensureToken() {
    if (tokenValid()) return true;
    if (!refreshValid()) return false;
    try {
      storeTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: saved.refresh }));
      return true;
    } catch (e) {
      set({ refresh: null, refreshExp: 0 });
      return false;
    }
  }

  // ───────── Graph 호출 ─────────
  class AuthExpired extends Error {}

  async function graph(url) {
    if (!(await ensureToken())) throw new AuthExpired('로그인이 만료되었다.');
    const res = await fetch(url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`, {
      headers: { Authorization: `Bearer ${saved.token}` },
    });
    if (res.status === 401) {
      set({ token: null, exp: 0 });
      throw new AuthExpired('로그인이 만료되었다.');
    }
    if (!res.ok) {
      let msg = String(res.status);
      try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.code)) || msg; } catch (e) { /* 본문 없음 */ }
      if (res.status === 403) throw new Error(`권한이 없다(${msg}). 관리자 승인이 아직 반영되지 않았을 수 있다.`);
      throw new Error(`요청 실패(${res.status}): ${msg}`);
    }
    return res.json();
  }

  async function listAll(url) {
    const out = [];
    let next = url;
    while (next) {
      const data = await graph(next);
      out.push(...(data.value || []));
      next = data['@odata.nextLink'] || null;
    }
    return out;
  }

  async function fetchAssignments() {
    // 제출 상태를 같이 받는다. $expand가 안 되는 환경이면 과제만 받는다
    let list;
    try {
      list = await listAll('/education/me/assignments?$expand=submissions');
    } catch (e) {
      if (e instanceof AuthExpired) throw e;
      list = await listAll('/education/me/assignments');
    }
    const since = Date.now() - PAST_DAYS * 86400000;
    return list
      .filter(a => a.dueDateTime && a.status !== 'draft' && new Date(a.dueDateTime).getTime() >= since)
      .map(a => {
        const subs = a.submissions || [];
        const done = subs.some(s => s.status === 'submitted' || s.status === 'returned');
        return {
          id: `${ACC.id}:${a.id}`,
          source: 'teams',
          account: ACC.kind,
          title: a.displayName,
          course: null,
          due: new Date(a.dueDateTime).toISOString(),
          hasTime: true,
          done,
          link: a.webUrl || null,
        };
      });
  }

  // ───────── 동기화 ─────────
  async function sync() {
    if (busy || !saved.email) return;
    busy = true;
    emit();
    try {
      const items = await fetchAssignments();
      Sources.setItems(ACC.id, items);
      set({ lastSync: Date.now(), error: null });
    } catch (e) {
      set({ error: e instanceof AuthExpired ? null : e.message });
    } finally {
      busy = false;
      emit();
    }
  }

  async function connect() {
    if (!CLIENT_ID) throw new Error('config.js에 Microsoft 클라이언트 ID가 비어 있다.');
    // 로그인이 살아 있거나 refresh token으로 갱신할 수 있으면 팝업 없이 새로고침
    if (saved.email && (tokenValid() || refreshValid())) return sync();
    // 팝업은 클릭 직후 기다림 없이 열어야 차단되지 않는다
    const popup = loginPopup(saved.email ? '' : 'select_account');
    try {
      const { code, verifier } = await popup;
      storeTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier }));
      try {
        const me = await graph('/me?$select=mail,userPrincipalName');
        set({ email: me.mail || me.userPrincipalName || '연결됨' });
      } catch (e) {
        set({ email: '연결됨' });
      }
      set({ error: null });
      Sources.setDemo(false);
      await sync();
    } catch (e) {
      set({ error: e.message });
    }
  }

  function disconnect() {
    saved = {};
    persist();
    Sources.setItems(ACC.id, []);
    emit();
  }

  function status() {
    return {
      ...ACC,
      email: saved.email || null,
      connected: !!saved.email,
      expired: !!saved.email && !tokenValid() && !refreshValid(),
      busy,
      lastSync: saved.lastSync || null,
      error: saved.error || null,
    };
  }

  function syncIfPossible() {
    if (saved.email && (tokenValid() || refreshValid())) sync();
  }
  setTimeout(syncIfPossible, 0);
  setInterval(syncIfPossible, SYNC_EVERY);
  setInterval(emit, 60 * 1000);

  window.Microsoft = {
    configured: !!CLIENT_ID,
    redirectUri: REDIRECT_URI,
    status,
    connect: () => connect().catch(e => set({ error: e.message })),
    disconnect,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
