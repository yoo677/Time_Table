// 학교 시간표와 공휴일. 공휴일이 아닌 평일에는 시간표 창 배경에 교시를 깔아 둔다.
// 공휴일 표는 직접 적어 두었다(설·추석·부처님오신날은 음력이라 해마다 다르다).
// 표에 없는 날(방학, 재량휴업일, 새로 생긴 공휴일 등)은 시간표 창의 '학교' 버튼으로 날마다 켜고 끈다.
(() => {
  'use strict';

  const KEY = 'timetable.school';
  const t = (h, m) => h * 60 + m;

  // 교시: { id, label, start, end }(분). 점심은 교시가 아니어서 스택 하나 제한이 없다
  const PERIODS = [
    { id: 'p1', label: '1교시', start: t(8, 30), end: t(9, 20) },
    { id: 'p2', label: '2교시', start: t(9, 30), end: t(10, 20) },
    { id: 'p3', label: '3교시', start: t(10, 30), end: t(11, 20) },
    { id: 'p4', label: '4교시', start: t(11, 30), end: t(12, 20) },
    { id: 'p5', label: '5교시', start: t(13, 10), end: t(14, 0) },
    { id: 'p6', label: '6교시', start: t(14, 10), end: t(15, 0) },
    { id: 'p7', label: '7교시', start: t(15, 10), end: t(16, 0) },
  ];
  const LUNCH = { id: 'lunch', label: '점심시간', start: t(12, 20), end: t(13, 10) };

  // 양력 고정 공휴일. sub: 토·일과 겹치면 대체공휴일이 생기는 날
  const FIXED = [
    ['01-01', '신정', false],
    ['03-01', '삼일절', true],
    ['05-05', '어린이날', true],
    ['06-06', '현충일', false],
    ['08-15', '광복절', true],
    ['10-03', '개천절', true],
    ['10-09', '한글날', true],
    ['12-25', '성탄절', true],
  ];
  // 음력 공휴일(양력으로 바꾼 날짜). 설·추석은 가운데 날(당일)만 적고 앞뒤 하루를 붙인다
  const LUNAR = {
    2025: { seol: '01-29', chuseok: '10-06', buddha: '05-05' },
    2026: { seol: '02-17', chuseok: '09-25', buddha: '05-24' },
    2027: { seol: '02-07', chuseok: '09-15', buddha: '05-13' },
    2028: { seol: '01-27', chuseok: '10-03', buddha: '05-02' },
  };
  // 선거일, 임시공휴일
  const EXTRA = {
    '2025-01-27': '임시공휴일',
    '2025-06-03': '대통령 선거',
    '2026-06-03': '지방선거',
    '2028-04-12': '국회의원 선거',
  };

  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

  const cache = new Map();
  // 그해 공휴일: key → 이름
  function holidaysOf(year) {
    if (cache.has(year)) return cache.get(year);
    const map = new Map();
    const subs = [];        // 토·일과 겹치면 대체공휴일 대상
    const sundayOnly = [];  // 설·추석: 일요일 또는 다른 공휴일과 겹칠 때만 대체
    const add = (k, name) => { map.set(k, map.has(k) ? `${map.get(k)} · ${name}` : name); };

    FIXED.forEach(([md, name, sub]) => {
      const k = `${year}-${md}`;
      add(k, name);
      if (sub) subs.push(k);
    });
    const lunar = LUNAR[year];
    if (lunar) {
      [['seol', '설날'], ['chuseok', '추석']].forEach(([id, name]) => {
        const mid = parseKey(`${year}-${lunar[id]}`);
        [-1, 0, 1].forEach(o => {
          const k = keyOf(addDays(mid, o));
          const overlapped = map.has(k);
          add(k, o ? `${name} 연휴` : name);
          sundayOnly.push({ k, overlapped });
        });
      });
      const b = `${year}-${lunar.buddha}`;
      add(b, '부처님오신날');
      subs.push(b);
    }
    Object.entries(EXTRA).forEach(([k, name]) => { if (k.startsWith(`${year}-`)) add(k, name); });

    // 대체공휴일: 겹친 날 다음의 첫 평일(공휴일이 아닌 날). 같은 날 겹침에는 하루만 준다
    const granted = new Set();
    const giveSub = k => {
      if (granted.has(k)) return;
      granted.add(k);
      let d = addDays(parseKey(k), 1);
      while (d.getDay() === 0 || d.getDay() === 6 || map.has(keyOf(d))) d = addDays(d, 1);
      add(keyOf(d), '대체공휴일');
    };
    subs.forEach(k => {
      const wd = parseKey(k).getDay();
      if (wd === 0 || wd === 6 || map.get(k).includes(' · ')) giveSub(k);
    });
    sundayOnly.forEach(({ k, overlapped }) => {
      if (parseKey(k).getDay() === 0 || overlapped) giveSub(k);
    });
    cache.set(year, map);
    return map;
  }

  function holidayName(key) {
    return holidaysOf(Number(key.slice(0, 4))).get(key) || null;
  }

  // 날마다 직접 켜고 끈 값: { 'YYYY-MM-DD': true | false }
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { overrides = {}; }
  const listeners = new Set();

  function defaultSchoolDay(key) {
    const wd = parseKey(key).getDay();
    return wd >= 1 && wd <= 5 && !holidayName(key);
  }
  function isSchoolDay(key) {
    return key in overrides ? overrides[key] : defaultSchoolDay(key);
  }
  function setSchoolDay(key, on) {
    if (on === defaultSchoolDay(key)) delete overrides[key];
    else overrides[key] = on;
    try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch (e) { /* 무시 */ }
    listeners.forEach(fn => fn());
  }

  // 그 시각(분)이 속한 교시
  function periodAt(min) {
    return PERIODS.find(p => min >= p.start && min < p.end) || null;
  }

  window.School = {
    PERIODS,
    LUNCH,
    holidayName,
    isSchoolDay,
    setSchoolDay,
    periodAt,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
