// 외부 연동(구글 클래스룸, 구글 Tasks, Teams)에서 가져온 마감 항목과, 이 기기에만 적어 둔 할 일.
// 연동 모듈(google.js 등)이 setItems(accountId, items)로 채운다. 마지막 결과는 저장해 두어
// 다시 열었을 때 로그인 전에도 목록이 보인다.
// 항목: { id, source: 'classroom'|'tasks'|'teams', account: 'personal'|'school'|'local',
//         title, course, due: ISO 문자열|null, hasTime: bool, done: bool, link, ref }
(() => {
  'use strict';

  const KEY = 'timetable.sources';
  const LOCAL_KEY = 'timetable.local';
  const byAccount = new Map();
  const listeners = new Set();
  let local = [];
  let demo = false;

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    Object.entries(saved).forEach(([acc, items]) => byAccount.set(acc, items));
  } catch (e) { /* 캐시가 깨졌으면 무시 */ }
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { local = []; }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(byAccount))); } catch (e) { /* 무시 */ }
  }
  // 연동 결과는 다시 받으면 되는 캐시지만, 이 기기 할 일은 여기에만 있으니 따로 저장한다
  function persistLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(local)); } catch (e) { /* 무시 */ }
  }
  function emit() { listeners.forEach(fn => fn()); }

  function setItems(accountId, items) {
    if (items && items.length) byAccount.set(accountId, items);
    else byAccount.delete(accountId);
    persist();
    emit();
  }

  function removeItem(id) {
    byAccount.forEach((items, acc) => byAccount.set(acc, items.filter(it => it.id !== id)));
    persist();
    if (local.some(it => it.id === id)) {
      local = local.filter(it => it.id !== id);
      persistLocal();
    }
    emit();
  }

  // due는 'YYYY-MM-DD' 또는 null. 날짜만 있는 할 일로 저장한다
  function addLocal(title, due) {
    let iso = null;
    if (due) {
      const [y, m, d] = due.split('-').map(Number);
      iso = new Date(y, m - 1, d).toISOString();
    }
    local.push({
      id: `local:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      source: 'tasks',
      account: 'local',
      title,
      course: null,
      due: iso,
      hasTime: false,
      done: false,
      link: null,
    });
    persistLocal();
    emit();
  }

  // 화면을 미리 볼 수 있게 만든 예시 데이터. 지금 시각 기준으로 만든다
  function demoItems() {
    const at = (dayOffset, h, m) => {
      const d = new Date();
      d.setDate(d.getDate() + dayOffset);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    return [
      { id: 'd1', source: 'classroom', account: 'school', title: '일반물리학 실험 보고서', course: '물리학1', due: at(0, 23, 59), hasTime: true },
      { id: 'd2', source: 'classroom', account: 'school', title: 'R&E 중간 발표 자료', course: '과제연구', due: at(2, 18, 0), hasTime: true },
      { id: 'd3', source: 'teams', account: 'school', title: '영어 Holes 독해 퀴즈', course: '영어', due: at(1, 9, 0), hasTime: true },
      { id: 'd4', source: 'tasks', account: 'personal', title: '화학올림피아드 기출 3회분', due: at(3, 0, 0), hasTime: false },
      { id: 'd5', source: 'classroom', account: 'personal', title: 'KYPT 문제 조사 정리', course: 'KYPT 팀', due: at(6, 21, 0), hasTime: true },
      { id: 'd6', source: 'classroom', account: 'school', title: '생명과학 배움일지', course: '생명과학', due: at(-1, 23, 59), hasTime: true },
      { id: 'd7', source: 'tasks', account: 'personal', title: '멘토링 수업 준비물 사기', due: null, hasTime: false },
      { id: 'd8', source: 'classroom', account: 'personal', title: '한화 사이언스 챌린지 계획서', course: '대회 준비', due: at(9, 18, 0), hasTime: true },
    ];
  }

  function all() {
    const out = demo ? demoItems() : [];
    if (!demo) byAccount.forEach(items => out.push(...items));
    out.push(...local);
    return out;
  }

  window.Sources = {
    all,
    setItems,
    removeItem,
    addLocal,
    hasReal: () => byAccount.size > 0,
    isDemo: () => demo,
    setDemo(on) { demo = !!on; emit(); },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
