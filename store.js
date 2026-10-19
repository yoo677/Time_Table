// 데이터 저장소. 지금은 이 기기의 브라우저(localStorage)에 저장한다.
// 기기 간 동기화를 붙일 때는 이 파일의 load/save만 바꾸면 된다.
(() => {
  'use strict';

  const KEY = 'timetable.v1';
  const UI_KEY = 'timetable.ui';
  const DEFAULT_START = 8 * 60; // 새 스택 기본 시작 시각(분). 08:00

  const listeners = new Set();
  let state = load();

  // 스택: { id, name, color, start(분), minutes, x(0~1), w(0~1) }
  // v1 데이터는 start/x/w가 없고 day.start부터 차례로 쌓여 있었다. 그 위치를 그대로 옮겨 온다.
  function normalize(s) {
    const days = {};
    for (const [key, d] of Object.entries(s.days || {})) {
      let cursor = typeof d.start === 'number' ? d.start : DEFAULT_START;
      const stacks = (d.stacks || []).map(st => {
        const out = {
          id: st.id,
          name: st.name,
          color: st.color,
          minutes: st.minutes,
          start: typeof st.start === 'number' ? st.start : cursor,
          x: typeof st.x === 'number' ? st.x : 0,
          w: typeof st.w === 'number' ? st.w : 1,
        };
        cursor = out.start + out.minutes;
        return out;
      });
      if (stacks.length) days[key] = { stacks };
    }
    return { version: 2, days };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.days === 'object') return normalize(parsed);
      }
    } catch (e) { /* 저장소를 못 쓰는 환경이면 빈 상태로 시작 */ }
    return { version: 2, days: {} };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* 개인정보 보호 모드 등에서는 저장 실패 */ }
    listeners.forEach(fn => fn());
  }

  function getDay(key) {
    const d = state.days[key];
    return { stacks: d ? d.stacks.map(s => ({ ...s })) : [] };
  }

  // fn(day)로 하루 데이터를 고치고 저장한다
  function updateDay(key, fn) {
    const day = getDay(key);
    fn(day);
    if (day.stacks.length === 0) delete state.days[key];
    else state.days[key] = day;
    save();
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 화면 설정(창 위치·크기 등). 기기마다 따로 둔다
  function getUI() {
    try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
  }
  function setUI(patch) {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ ...getUI(), ...patch })); } catch (e) { /* 무시 */ }
  }

  // 다른 탭에서 바꾼 내용도 반영
  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    state = load();
    listeners.forEach(fn => fn());
  });

  window.Store = {
    DEFAULT_START,
    getDay,
    updateDay,
    newId,
    getUI,
    setUI,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
