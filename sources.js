// 외부 연동(구글 클래스룸, 구글 Tasks, Teams)에서 가져온 마감 항목.
// 실제 연동은 아직 없다. 연결 코드가 생기면 setItems(source, items)로 채운다.
// 항목: { id, source: 'classroom'|'tasks'|'teams', account: 'personal'|'school',
//         title, course, due: ISO 문자열, hasTime: bool, done: bool, link }
(() => {
  'use strict';

  const ACCOUNTS = [
    { id: 'google-personal', label: 'Google 개인 계정', services: ['Classroom', 'Tasks'] },
    { id: 'google-school', label: 'Google 학교 계정', services: ['Classroom'] },
    { id: 'microsoft-school', label: 'Microsoft 학교 계정', services: ['Teams 과제'] },
  ];

  const bySource = new Map();
  const listeners = new Set();
  let demo = false;

  function emit() { listeners.forEach(fn => fn()); }

  function setItems(source, items) {
    bySource.set(source, items);
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
    ];
  }

  function all() {
    const out = demo ? demoItems() : [];
    if (!demo) bySource.forEach(items => out.push(...items));
    return out;
  }

  window.Sources = {
    ACCOUNTS,
    all,
    setItems,
    isConnected: () => false,
    isDemo: () => demo,
    setDemo(on) { demo = !!on; emit(); },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
