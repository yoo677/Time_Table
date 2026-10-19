// 구글 계정 연동: 클래스룸 과제(개인·학교 계정), 구글 Tasks(개인 계정).
// 브라우저에서 Google Identity Services(GIS)로 access token을 받아 REST API를 직접 부른다.
// 토큰은 1시간짜리라, 만료되면 사용자가 버튼을 눌러 다시 받는다(팝업은 클릭 직후에만 열 수 있다).
(() => {
  'use strict';

  const CLIENT_ID = (window.APP_CONFIG || {}).googleClientId || '';
  const KEY = 'timetable.google';
  const SYNC_EVERY = 10 * 60 * 1000;
  const PAST_DAYS = 30; // 이보다 오래 지난 과제는 가져오지 않는다

  const BASE_SCOPES = ['openid', 'email'];
  const CLASSROOM_SCOPES = [
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  ];
  const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

  const ACCOUNTS = [
    { id: 'google-personal', kind: 'personal', label: 'Google 개인 계정', services: ['Classroom', 'Tasks'], tasks: true },
    { id: 'google-school', kind: 'school', label: 'Google 학교 계정', services: ['Classroom'], tasks: false },
  ];
  const scopesOf = acc => [...BASE_SCOPES, ...CLASSROOM_SCOPES, ...(acc.tasks ? [TASKS_SCOPE] : [])];

  // 새 구글 동의 화면은 권한마다 체크박스가 있어서 일부만 허용될 수 있다.
  // 토큰 응답의 scope 문자열로 무엇이 허용되었는지 보고, 허용된 기능만 쓴다
  const SCOPE_NAMES = {
    'https://www.googleapis.com/auth/classroom.courses.readonly': '클래스룸 수업 보기',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly': '클래스룸 과제 보기',
    [TASKS_SCOPE]: 'Tasks 할 일 관리',
  };
  function grantedOf(acc, scopeStr) {
    const got = new Set(String(scopeStr || '').split(/\s+/));
    const missing = scopesOf(acc).filter(sc => sc.startsWith('https://') && !got.has(sc));
    return {
      classroom: CLASSROOM_SCOPES.every(sc => got.has(sc)),
      tasks: acc.tasks && got.has(TASKS_SCOPE),
      missing: missing.map(sc => SCOPE_NAMES[sc] || sc),
    };
  }
  function missingNote(missing) {
    return `허용 안 된 권한: ${missing.join(', ')}. 다시 연결할 때 권한 화면에서 '모두 선택'에 체크한다.`;
  }

  // { [accountId]: { email, token, exp, lastSync, error } }
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  const busy = new Set();
  const listeners = new Set();

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* 무시 */ }
  }
  function emit() { listeners.forEach(fn => fn()); }
  function setAcc(id, patch) {
    saved[id] = { ...(saved[id] || {}), ...patch };
    persist();
    emit();
  }
  const tokenValid = s => s && s.token && s.exp > Date.now() + 60 * 1000;

  // ───────── GIS 스크립트 ─────────
  let gisLoaded = false;
  let gisError = null;
  function loadGis() {
    if (!CLIENT_ID || document.querySelector('script[data-gis]')) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.dataset.gis = '1';
    s.onload = () => { gisLoaded = true; emit(); };
    s.onerror = () => { gisError = '구글 로그인 스크립트를 불러오지 못했다. 인터넷 연결을 확인한다.'; emit(); };
    document.head.append(s);
  }

  // 클릭 이벤트 안에서 바로 불러야 팝업이 막히지 않는다
  function requestToken(acc, prompt) {
    return new Promise((resolve, reject) => {
      if (!CLIENT_ID) return reject(new Error('config.js에 구글 클라이언트 ID가 비어 있다.'));
      if (!gisLoaded) return reject(new Error(gisError || '구글 로그인을 준비하는 중이다. 잠시 뒤 다시 누른다.'));
      const s = saved[acc.id] || {};
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: scopesOf(acc).join(' '),
        prompt,
        login_hint: s.email || undefined,
        callback: r => {
          if (r.error) return reject(new Error(explainAuthError(r.error, r.error_description)));
          resolve(r);
        },
        error_callback: e => reject(new Error(e && e.type === 'popup_closed'
          ? '로그인 창이 닫혔다.'
          : e && e.type === 'popup_failed_to_open'
            ? '팝업이 차단되었다. 브라우저에서 이 사이트의 팝업을 허용한다.'
            : '로그인 중 문제가 생겼다.')),
      });
      client.requestAccessToken();
    });
  }

  function explainAuthError(code, desc) {
    const map = {
      access_denied: '접근이 거부되었다. 학교 계정이라면 학교 관리자가 이 앱을 허용하지 않았을 수 있다.',
      admin_policy_enforced: '학교(조직) 관리자 정책으로 이 앱이 막혀 있다. 관리자에게 허용을 요청해야 한다.',
      access_not_configured: '학교 관리자가 이 앱의 접근을 아직 설정하지 않았다(만 18세 미만 계정 기본 차단). 관리자에게 허용을 요청해야 한다.',
      org_internal: '이 앱은 조직 내부 전용으로 설정되어 있다.',
    };
    return map[code] || `로그인 오류: ${desc || code}`;
  }

  // ───────── REST 호출 ─────────
  class AuthExpired extends Error {}

  async function api(accId, url, opts = {}) {
    const s = saved[accId];
    if (!tokenValid(s)) throw new AuthExpired('로그인이 만료되었다.');
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      setAcc(accId, { token: null, exp: 0 });
      throw new AuthExpired('로그인이 만료되었다.');
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg = (await res.json()).error.message || msg; } catch (e) { /* 본문 없음 */ }
      throw new Error(explainApiError(res.status, msg));
    }
    return res.status === 204 ? null : res.json();
  }

  function explainApiError(status, msg) {
    if (/has not been used|is disabled/i.test(msg)) return 'Google Cloud 프로젝트에서 Classroom API 또는 Tasks API가 꺼져 있다.';
    if (/ClassroomDisabled|@ClassroomApiDisabled/i.test(msg)) return '이 계정에서는 클래스룸을 쓸 수 없게 되어 있다(학교 관리자 설정).';
    if (status === 403) return `권한이 없다: ${msg}`;
    return `요청 실패(${status}): ${msg}`;
  }

  // 페이지가 나뉜 목록을 끝까지 모은다
  async function listAll(accId, url, field) {
    const out = [];
    let pageToken = '';
    do {
      const u = new URL(url);
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const data = await api(accId, u.toString());
      out.push(...(data[field] || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  // 동시에 너무 많이 부르지 않게 n개씩
  async function mapLimit(arr, n, fn) {
    const out = new Array(arr.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
      while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); }
    }));
    return out;
  }

  // ───────── 클래스룸 ─────────
  // dueDate·dueTime은 UTC. 시·분이 0이면 필드가 빠져서 온다
  function classroomDue(cw) {
    const d = cw.dueDate;
    if (!d || !d.year) return null;
    const t = cw.dueTime || {};
    return new Date(Date.UTC(d.year, d.month - 1, d.day, t.hours || 0, t.minutes || 0));
  }

  async function fetchClassroom(acc) {
    const C = 'https://classroom.googleapis.com/v1';
    const courses = await listAll(acc.id, `${C}/courses?studentId=me&courseStates=ACTIVE&pageSize=100`, 'courses');
    const since = Date.now() - PAST_DAYS * 86400000;
    const perCourse = await mapLimit(courses, 4, async course => {
      const [work, subs] = await Promise.all([
        listAll(acc.id, `${C}/courses/${course.id}/courseWork?courseWorkStates=PUBLISHED&pageSize=100`, 'courseWork'),
        listAll(acc.id, `${C}/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=100`, 'studentSubmissions'),
      ]);
      const doneIds = new Set(subs.filter(s => s.state === 'TURNED_IN' || s.state === 'RETURNED').map(s => s.courseWorkId));
      return work
        .map(cw => ({ cw, due: classroomDue(cw) }))
        .filter(({ due }) => due && due.getTime() >= since)
        .map(({ cw, due }) => ({
          id: `${acc.id}:cw:${cw.id}`,
          source: 'classroom',
          account: acc.kind,
          title: cw.title,
          course: course.name,
          due: due.toISOString(),
          hasTime: true,
          done: doneIds.has(cw.id),
          link: cw.alternateLink || course.alternateLink || null,
        }));
    });
    return perCourse.flat();
  }

  // ───────── 구글 Tasks ─────────
  // due는 날짜만 의미가 있다(시각은 API가 버린다). 'YYYY-MM-DD'를 이 기기 시간대의 그날 0시로 바꾼다
  function tasksDue(due) {
    if (!due) return null;
    const [y, m, d] = due.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toISOString();
  }

  async function fetchTasks(acc) {
    const T = 'https://tasks.googleapis.com/tasks/v1';
    const lists = await listAll(acc.id, `${T}/users/@me/lists?maxResults=100`, 'items');
    const perList = await mapLimit(lists, 4, list =>
      listAll(acc.id, `${T}/lists/${encodeURIComponent(list.id)}/tasks?showCompleted=false&showHidden=false&maxResults=100`, 'items')
        .then(tasks => tasks
          .filter(t => t.title && t.status !== 'completed')
          .map(t => ({
            id: `${acc.id}:task:${t.id}`,
            source: 'tasks',
            account: acc.kind,
            title: t.title,
            course: lists.length > 1 ? list.title : null,
            due: tasksDue(t.due),
            hasTime: false,
            done: false,
            link: t.webViewLink || null,
            ref: { acc: acc.id, list: list.id, task: t.id },
          }))));
    return perList.flat();
  }

  // ───────── 동기화 ─────────
  async function sync(accId) {
    const acc = ACCOUNTS.find(a => a.id === accId);
    if (!acc || busy.has(accId) || !tokenValid(saved[accId])) return;
    busy.add(accId);
    emit();
    try {
      const g = saved[accId].granted || { classroom: true, tasks: acc.tasks, missing: [] };
      const jobs = [];
      if (g.classroom) jobs.push(fetchClassroom(acc));
      if (g.tasks) jobs.push(fetchTasks(acc));
      const results = await Promise.allSettled(jobs);
      const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
      const failed = results.find(r => r.status === 'rejected');
      if (failed && failed.reason instanceof AuthExpired) throw failed.reason;
      if (failed && !items.length) throw failed.reason;
      Sources.setItems(accId, items);
      const notes = [];
      if (failed) notes.push(failed.reason.message);
      if (g.missing && g.missing.length) notes.push(missingNote(g.missing));
      setAcc(accId, { lastSync: Date.now(), error: notes.join(' ') || null });
    } catch (e) {
      setAcc(accId, { error: e instanceof AuthExpired ? null : e.message });
    } finally {
      busy.delete(accId);
      emit();
    }
  }

  // 버튼 클릭에서 부른다: 토큰이 없거나 만료되었으면 로그인 창을 띄우고, 있으면 바로 새로고침
  async function connect(accId) {
    const acc = ACCOUNTS.find(a => a.id === accId);
    if (!acc) return;
    if (tokenValid(saved[accId]) && !saved[accId].needConsent) return sync(accId);
    try {
      const s = saved[accId] || {};
      // 처음이면 계정 선택 화면, 다시 받는 거면 확인 없이(가능하면 창이 바로 닫힌다)
      // 처음 연결하거나 지난번에 권한이 빠졌으면 동의 화면을 반드시 띄운다.
      // 그러지 않으면 구글이 예전에 받은 (빠진) 권한 그대로 창을 바로 닫아 버린다
      const prompt = !s.email || s.needConsent ? 'consent select_account' : '';
      const r = await requestToken(acc, prompt);
      const granted = grantedOf(acc, r.scope);
      if (!granted.classroom && !granted.tasks) {
        setAcc(accId, { token: null, exp: 0, needConsent: true, error: missingNote(granted.missing) });
        return;
      }
      setAcc(accId, {
        token: r.access_token,
        exp: Date.now() + (Number(r.expires_in) || 3600) * 1000,
        granted,
        needConsent: granted.missing.length > 0,
        error: null,
      });
      try {
        const info = await api(accId, 'https://openidconnect.googleapis.com/v1/userinfo');
        if (info.email) {
          const other = ACCOUNTS.find(a => a.id !== accId && saved[a.id] && saved[a.id].email === info.email);
          if (other) {
            setAcc(accId, { token: null, exp: 0, error: `${info.email}은 이미 ${other.label}으로 연결되어 있다. 다른 계정을 고른다.` });
            return;
          }
          setAcc(accId, { email: info.email });
        }
      } catch (e) { /* 이메일 표시는 없어도 동작한다 */ }
      Sources.setDemo(false);
      await sync(accId);
    } catch (e) {
      setAcc(accId, { error: e.message });
    }
  }

  function disconnect(accId) {
    const s = saved[accId];
    if (s && s.token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(s.token, () => {}); } catch (e) { /* 무시 */ }
    }
    delete saved[accId];
    persist();
    Sources.setItems(accId, []);
    emit();
  }

  // Tasks 할 일 완료 처리
  async function completeTask(item) {
    if (!item.ref) return;
    const { acc, list, task } = item.ref;
    if (!tokenValid(saved[acc])) throw new Error('로그인이 만료되었다. 계정 메뉴에서 새로고침을 누른다.');
    await api(acc, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(task)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    Sources.removeItem(item.id);
  }

  function status() {
    return ACCOUNTS.map(acc => {
      const s = saved[acc.id] || {};
      return {
        ...acc,
        email: s.email || null,
        connected: !!s.email || tokenValid(s),
        expired: !!s.email && !tokenValid(s),
        busy: busy.has(acc.id),
        lastSync: s.lastSync || null,
        error: s.error || null,
      };
    });
  }

  // 시작할 때와 주기적으로, 토큰이 살아 있는 계정만 조용히 새로고침
  function syncAllValid() {
    ACCOUNTS.forEach(acc => { if (tokenValid(saved[acc.id])) sync(acc.id); });
  }

  loadGis();
  setTimeout(syncAllValid, 0);
  setInterval(syncAllValid, SYNC_EVERY);
  // 토큰 만료 표시를 갱신
  setInterval(emit, 60 * 1000);

  window.Google = {
    configured: !!CLIENT_ID,
    status,
    connect,
    sync,
    disconnect,
    completeTask,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
