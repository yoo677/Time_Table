// 데이터 저장소. v1은 이 기기의 브라우저(localStorage)에 저장한다.
// 나중에 기기 간 동기화를 붙일 때는 이 파일의 load/save만 바꾸면 된다.
(() => {
  'use strict';

  const KEY = 'timetable.v1';
  const DEFAULT_START = 8 * 60; // 하루 시작 시각(분). 08:00

  const listeners = new Set();
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.days === 'object') return parsed;
      }
    } catch (e) { /* 저장소를 못 쓰는 환경이면 빈 상태로 시작 */ }
    return { version: 1, days: {} };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* 개인정보 보호 모드 등에서는 저장 실패 */ }
    listeners.forEach(fn => fn());
  }

  function getDay(key) {
    const d = state.days[key];
    return {
      start: d ? d.start : DEFAULT_START,
      stacks: d ? d.stacks.map(s => ({ ...s })) : [],
    };
  }

  // fn(day)로 하루 데이터를 고치고 저장한다
  function updateDay(key, fn) {
    const day = getDay(key);
    fn(day);
    if (day.stacks.length === 0 && day.start === DEFAULT_START) {
      delete state.days[key];
    } else {
      state.days[key] = day;
    }
    save();
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
