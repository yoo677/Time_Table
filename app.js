(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const WD_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
  const COLORS = ['#007aff', '#34c759', '#ff9500', '#ff2d55', '#af52de', '#5ac8fa', '#ffcc00', '#8e8e93'];
  const SOURCE_INFO = {
    classroom: { label: 'Classroom', color: 'var(--src-classroom)', stack: '#34c759' },
    tasks: { label: 'Tasks', color: 'var(--src-tasks)', stack: '#007aff' },
    teams: { label: 'Teams', color: 'var(--src-teams)', stack: '#af52de' },
  };
  const DAY_MIN = 24 * 60;
  const SNAP_MIN = 5;      // 세로 이동·길이 조절 단위(분)
  const SNAP_X = 1 / 24;   // 가로 이동·폭 조절 단위(전체 폭 대비)
  const MIN_W = 1 / 6;     // 스택 최소 폭
  const MAX_WINS = 6;      // 동시에 띄우는 시간표 창 수
  const DROP_MIN = 60;     // 할 일을 끌어 놓을 때 기본 길이(분)
  const periodsOf = key => (School.isSchoolDay(key) ? School.PERIODS : []);
  const periodLabel = id => (School.PERIODS.find(p => p.id === id) || {}).label || '';

  // 그날 스택들 사이에 cand를 놓아 본다(겹침 방지, 끼워 넣기, 교시). 저장은 하지 않는다
  function tryPlace(key, cand) {
    return Placement.place(Store.getDay(key).stacks, cand, { periods: periodsOf(key), newId: Store.newId });
  }
  // 놓아 본 결과를 저장한다. 새로 생긴 조각은 튀어나오게
  function commitPlace(w, res) {
    const before = new Set(Store.getDay(w.key).stacks.map(s => s.id));
    w.pendingHighlight = res.stacks.filter(s => !before.has(s.id)).map(s => s.id);
    Store.updateDay(w.key, day => { day.stacks = res.stacks; });
  }

  function fmtTime(min) {
    const next = min >= DAY_MIN;
    const m = min % DAY_MIN;
    return `${next ? '다음날 ' : ''}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (h && m) return `${h}시간 ${m}분`;
    return h ? `${h}시간` : `${m}분`;
  }

  // ───────── 애니메이션 ─────────
  // 감쇠 진동(스프링) 곡선을 linear()로 근사한다. 지원하지 않는 브라우저는 애플 기본 곡선으로 대체.
  const SUPPORTS_LINEAR = typeof CSS !== 'undefined' && CSS.supports('animation-timing-function', 'linear(0, 1)');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  function spring(stiffness, damping) {
    if (!SUPPORTS_LINEAR) return { easing: 'cubic-bezier(0.32, 0.72, 0, 1)', duration: 480 };
    const w0 = Math.sqrt(stiffness);
    const zeta = damping / (2 * w0);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const x = t => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
    const dur = -Math.log(0.001) / (zeta * w0);
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push(+x(dur * i / 64).toFixed(4));
    pts[64] = 1;
    return { easing: `linear(${pts.join(', ')})`, duration: Math.round(dur * 1000) };
  }
  const SPRING_SMOOTH = spring(240, 28);
  const SPRING_BOUNCY = spring(320, 26);
  const SPRING_ELASTIC = spring(260, 17); // 접힌 할 일 더미가 펴질 때
  const EASE_OUT = { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
  const motion = s => REDUCED.matches ? { duration: 1, easing: 'linear' } : s;

  // 높이를 지금 값에서 목표 값으로 옮긴다. 도중에 다시 불러도 그 자리에서 이어진다
  function animateHeight(box, from, to, timing) {
    box.getAnimations().forEach(a => a.cancel());
    box.style.overflow = 'hidden';
    const a = box.animate([{ height: `${from}px` }, { height: `${to}px` }], motion(timing));
    a.onfinish = () => { box.style.overflow = ''; };
    return a;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    t.getAnimations().forEach(a => a.cancel());
    t.animate([{ opacity: 0, transform: 'translate(-50%, -8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], motion(SPRING_SMOOTH));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => {
        t.hidden = true;
        t.getAnimations().forEach(a => a.cancel());
      });
    }, 3200);
  }

  // ───────── 상태 ─────────
  const ui = Store.getUI();
  let viewMonth = (() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1); })();

  if (ui.demo || new URLSearchParams(location.search).has('demo')) Sources.setDemo(true);

  // 마감 항목을 날짜별로 나눈다
  function dueInfo(item) {
    if (!item.due) return null;
    const d = new Date(item.due);
    return { date: d, key: keyOf(d), min: d.getHours() * 60 + d.getMinutes() };
  }
  function deadlinesOn(key) {
    return Sources.all()
      .filter(it => !it.done && it.hasTime && it.source !== 'tasks')
      .map(it => ({ it, info: dueInfo(it) }))
      .filter(x => x.info && x.info.key === key)
      .sort((a, b) => a.info.min - b.info.min);
  }

  // ───────── 맨 위 줄: 날짜, 시계, 날씨 ─────────
  function tickClock() {
    const n = new Date();
    $('clock-date').textContent = `${n.getFullYear()}/${pad(n.getMonth() + 1)}/${pad(n.getDate())} (${WD_SHORT[n.getDay()]})`;
    $('clock-time').textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    // 초가 바뀌는 순간에 맞춰 다시 부른다
    setTimeout(tickClock, 1000 - (Date.now() % 1000) + 5);
  }

  function renderWeather() {
    const w = Weather.get();
    const nowBtn = $('wx-now');
    if (w.status !== 'ok') {
      $('wx-icon').textContent = '';
      $('wx-temp').textContent = w.status === 'error' ? '날씨 없음' : '날씨…';
      $('wx-desc').textContent = '';
      $('wx-place').textContent = '';
      nowBtn.title = w.error || '';
      drawTempGraph();
      return;
    }
    const cur = Weather.describe(w.current.code, w.current.isDay);
    $('wx-icon').textContent = cur.icon;
    $('wx-temp').textContent = `${w.current.temp}°`;
    $('wx-desc').textContent = cur.text;
    $('wx-place').textContent = w.place ? `${w.approximate ? '≈ ' : ''}${w.place}` : '';
    nowBtn.title = w.approximate
      ? '위치 권한이 없어 서울 기준으로 보여 준다'
      : `${w.place || '현재 위치'} · ${w.fetchedAt ? new Date(w.fetchedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''} 갱신`;

    drawTempGraph();
  }

  // 시간별 기온 그래프. 가로축은 시각, 세로축은 기온(°C).
  // 화면을 켤 때마다(처음 열 때, 다른 앱에서 돌아올 때) 선이 왼쪽부터 새로 그려진다
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  };
  let graphDrawnOnce = false;
  function drawTempGraph(animate) {
    const box = $('wx-hourly');
    const w = Weather.get();
    const hours = w.status === 'ok' ? w.hourly : [];
    const W = box.clientWidth, H = box.clientHeight;
    if (!hours.length || !W || !H) { box.replaceChildren(); return; }
    if (!graphDrawnOnce) { graphDrawnOnce = true; animate = true; }

    const left = 30, right = 8, top = 6, bottom = 16;
    const temps = hours.map(h => h.temp);
    // 눈금: 최저·최고를 정수로 감싸고, 차이가 너무 작으면 위아래로 벌린다
    let lo = Math.floor(Math.min(...temps)), hi = Math.ceil(Math.max(...temps));
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = Math.floor(m - 2); hi = Math.ceil(m + 2); }
    const mid = Math.round((hi + lo) / 2);
    const step = (W - left - right) / (hours.length - 1);
    const xOf = i => left + i * step;
    const yOf = v => top + (H - top - bottom) * (hi - v) / (hi - lo);
    const pts = hours.map((h, i) => [xOf(i), yOf(h.temp)]);
    const baseY = H - bottom;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wx-graph' });
    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'wx-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(svgEl('stop', { offset: '0', class: 'wx-fill-top' }), svgEl('stop', { offset: '1', class: 'wx-fill-bottom' }));
    defs.append(grad);
    svg.append(defs);

    // 세로축(기온) 눈금과 가로 보조선
    [hi, mid, lo].forEach(v => {
      const y = yOf(v);
      svg.append(svgEl('line', { x1: left, x2: W - right, y1: y, y2: y, class: 'wx-grid' }));
      const t = svgEl('text', { x: left - 5, y: y + 3, class: 'wx-ytick' });
      t.textContent = `${v}°`;
      svg.append(t);
    });
    // 가로축(시각)
    svg.append(svgEl('line', { x1: left, x2: W - right, y1: baseY, y2: baseY, class: 'wx-axis' }));
    const every = step < 22 ? 3 : 2;
    hours.forEach((h, i) => {
      if (i % every) return;
      const t = svgEl('text', { x: xOf(i), y: H - 3, class: `wx-xtick${i === 0 ? ' now' : ''}` });
      t.textContent = i === 0 ? '지금' : `${h.hour}시`;
      svg.append(t);
    });

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = svgEl('path', { d: `${line}L${pts[pts.length - 1][0]},${baseY}L${pts[0][0]},${baseY}Z`, class: 'wx-area' });
    const path = svgEl('path', { d: line, class: 'wx-line' });
    svg.append(area, path);

    // 시각마다 올리면 값이 보이는 점
    hours.forEach((h, i) => {
      const [x, y] = pts[i];
      const g = svgEl('g', { class: `wx-pt${i === 0 ? ' now' : ''}` });
      const d = Weather.describe(h.code, h.isDay);
      const title = svgEl('title');
      title.textContent = `${i === 0 ? '지금' : `${h.hour}시`} ${h.temp}° · ${d.text}${h.pop != null ? ` · 강수 ${h.pop}%` : ''}`;
      g.append(title, svgEl('rect', { x: x - step / 2, y: 0, width: step, height: H, class: 'wx-hit' }));
      g.append(svgEl('line', { x1: x, x2: x, y1: top, y2: baseY, class: 'wx-guide' }));
      g.append(svgEl('circle', { cx: x, cy: y, r: i === 0 ? 3.5 : 3, class: 'wx-dot' }));
      const tv = svgEl('text', { x: Math.min(Math.max(x, left + 10), W - right - 10), y: Math.max(y - 6, 9), class: 'wx-val' });
      tv.textContent = `${h.temp}°`;
      g.append(tv);
      svg.append(g);
    });
    box.replaceChildren(svg);

    if (animate && !REDUCED.matches) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len}`;
      const draw = path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1100, easing: 'cubic-bezier(0.33, 0, 0.15, 1)', fill: 'backwards' });
      draw.onfinish = () => { path.style.strokeDasharray = ''; };
      area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 450, easing: 'ease-out', fill: 'backwards' });
      svg.querySelector('.wx-pt.now .wx-dot')?.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { ...SPRING_BOUNCY, fill: 'backwards' });
      svg.querySelectorAll('.wx-ytick, .wx-xtick').forEach((t, i) => t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 60 * i, fill: 'backwards' }));
    }
  }
  // 다른 앱이나 탭에 있다가 돌아오면 다시 그린다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') drawTempGraph(true);
  });
  addEventListener('resize', () => requestAnimationFrame(() => drawTempGraph(false)));

  // 폰에서는 시간별 예보를 접어 두고, 현재 날씨를 누르면 편다. 넓은 화면에서는 누르면 새로 받는다
  $('wx-now').addEventListener('click', e => {
    if (!matchMedia('(max-width: 639px)').matches) { Weather.refresh(); return; }
    const hourly = $('wx-hourly');
    const open = !hourly.classList.contains('show');
    e.currentTarget.setAttribute('aria-expanded', String(open));
    const from = open ? 0 : hourly.getBoundingClientRect().height;
    hourly.getAnimations().forEach(a => a.cancel());
    hourly.classList.add('show');
    if (open) drawTempGraph(true);
    const a = animateHeight(hourly, from, open ? hourly.offsetHeight : 0, open ? SPRING_SMOOTH : EASE_OUT);
    a.onfinish = () => {
      hourly.style.overflow = '';
      if (!open) hourly.classList.remove('show');
      trimMiniChips();
    };
  });
  Weather.subscribe(renderWeather);

  // ───────── 폰 탭 전환 ─────────
  const appEl = $('app');
  function setTab(tab) {
    appEl.dataset.tab = tab;
    document.querySelectorAll('.tabbar [role="tab"]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    Store.setUI({ tab });
    if (tab === 'calendar') requestAnimationFrame(trimMiniChips);
  }
  document.querySelectorAll('.tabbar [role="tab"]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  if (ui.tab) setTab(ui.tab);

  // ───────── 달력과 할 일 사이 폭 조절 ─────────
  const tasksPane = $('tasks');
  const splitter = $('splitter');
  const TASKS_W = 360;
  function setTasksWidth(px, save) {
    const max = Math.max(280, innerWidth - 420);
    const w = Math.round(clamp(px, 260, max));
    appEl.style.setProperty('--tasks-w', `${w}px`);
    if (save) Store.setUI({ tasksW: w });
    return w;
  }
  if (ui.tasksW) setTasksWidth(ui.tasksW);

  splitter.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX, w0 = tasksPane.offsetWidth;
    let w = w0;
    splitter.classList.add('active');
    document.body.classList.add('col-resizing');
    const move = ev => {
      w = setTasksWidth(w0 - (ev.clientX - sx));
      trimMiniChips();
    };
    const up = () => {
      splitter.classList.remove('active');
      document.body.classList.remove('col-resizing');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      setTasksWidth(w, true);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
  // 두 번 누르면 기본 폭으로
  splitter.addEventListener('dblclick', () => {
    const from = tasksPane.offsetWidth;
    const to = setTasksWidth(TASKS_W, true);
    tasksPane.animate([{ width: `${from}px` }, { width: `${to}px` }], motion(SPRING_SMOOTH));
    setTimeout(trimMiniChips, 400);
  });
  splitter.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setTasksWidth(tasksPane.offsetWidth + (e.key === 'ArrowLeft' ? 24 : -24), true);
    trimMiniChips();
  });

  // ───────── 달력 ─────────
  const grid = $('grid');

  function renderMonth() {
    $('month-label').textContent = `${viewMonth.getFullYear()}년 ${viewMonth.getMonth() + 1}월`;

    const first = addDays(viewMonth, -viewMonth.getDay());
    const todayKey = keyOf(new Date());
    const openKeys = new Set(wins.map(w => w.key));
    const frag = document.createDocumentFragment();

    for (let i = 0; i < 42; i++) {
      const d = addDays(first, i);
      const key = keyOf(d);
      const cell = el('button', 'cell');
      cell.type = 'button';
      cell.dataset.key = key;
      if (d.getMonth() !== viewMonth.getMonth()) cell.classList.add('outside');
      if (d.getDay() === 0) cell.classList.add('sun');
      if (d.getDay() === 6) cell.classList.add('sat');
      if (key === todayKey) cell.classList.add('today');
      if (openKeys.has(key)) cell.classList.add('open');
      const holiday = School.holidayName(key);
      if (holiday) cell.classList.add('holiday');

      // 나뉜 스택은 칸에 한 번만
      const seenGroup = new Set();
      const stacks = Store.getDay(key).stacks.sort((a, b) => a.start - b.start)
        .filter(s => !s.group || (!seenGroup.has(s.group) && seenGroup.add(s.group)));
      const dues = deadlinesOn(key);
      let label = `${d.getMonth() + 1}월 ${d.getDate()}일${holiday ? ` ${holiday}` : ''}`;
      if (stacks.length) label += `, 스택 ${stacks.length}개`;
      if (dues.length) label += `, 마감 ${dues.length}개`;
      cell.setAttribute('aria-label', label);

      const head = el('div', 'cell-head');
      head.append(el('span', 'num', d.getDate()));
      if (holiday) head.append(el('span', 'hol', holiday.split(' · ')[0]));
      cell.append(head);

      if (stacks.length || dues.length) {
        const list = el('div', 'chips-mini');
        const dots = el('div', 'dots');
        dues.forEach(({ it, info }) => {
          const c = SOURCE_INFO[it.source].color;
          const chip = el('span', 'mini due', `${fmtTime(info.min)} ${it.title}`);
          chip.style.setProperty('--c', c);
          list.append(chip);
          const dot = el('span', 'dot due');
          dot.style.setProperty('--c', c);
          dots.append(dot);
        });
        stacks.forEach((s, idx) => {
          const chip = el('span', 'mini', s.name);
          chip.style.setProperty('--c', s.color);
          list.append(chip);
          if (idx < 4) {
            const dot = el('span', 'dot');
            dot.style.setProperty('--c', s.color);
            dots.append(dot);
          }
        });
        cell.append(list, dots);
      }
      frag.append(cell);
    }
    grid.replaceChildren(frag);
    requestAnimationFrame(trimMiniChips);
  }

  // 칸에 다 안 들어가는 칩은 숨기고 +n으로 표시
  function trimMiniChips() {
    grid.querySelectorAll('.chips-mini').forEach(list => {
      list.querySelector('.mini-more')?.remove();
      const chips = [...list.children];
      chips.forEach(c => { c.hidden = false; });
      if (!list.offsetHeight || list.scrollHeight <= list.clientHeight) return;
      const more = el('span', 'mini-more');
      list.append(more);
      let hiddenCount = 0;
      for (let i = chips.length - 1; i >= 0 && list.scrollHeight > list.clientHeight; i--) {
        chips[i].hidden = true;
        hiddenCount++;
        more.textContent = `+${hiddenCount}`;
      }
    });
  }

  // 달을 넘길 때: 지난달 칸들은 반대쪽으로 밀려 사라지고 새 달 칸들이 들어온다
  const calendarEl = $('calendar');
  function slideGrid(dir, oldGrid) {
    calendarEl.querySelectorAll('.grid-ghost').forEach(g => g.remove());
    if (oldGrid && !REDUCED.matches) {
      const r = grid.getBoundingClientRect(), pr = calendarEl.getBoundingClientRect();
      oldGrid.removeAttribute('id');
      oldGrid.classList.add('grid-ghost');
      oldGrid.setAttribute('aria-hidden', 'true');
      Object.assign(oldGrid.style, { left: `${r.left - pr.left}px`, top: `${r.top - pr.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      calendarEl.append(oldGrid);
      oldGrid.animate(
        [{ transform: 'none', opacity: 1 }, { transform: `translateX(${-dir * 22}%)`, opacity: 0 }],
        { duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }
      ).finished.then(() => oldGrid.remove());
    }
    grid.animate(
      [{ transform: `translateX(${dir * 22}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      motion(SPRING_SMOOTH)
    );
  }
  function shiftMonth(delta) {
    const old = grid.cloneNode(true);
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
    renderMonth();
    slideGrid(delta, old);
  }
  // 그 날짜가 있는 달로 넘긴다. 넘겼으면 true
  function showMonthOf(d, animate) {
    const delta = (d.getFullYear() - viewMonth.getFullYear()) * 12 + d.getMonth() - viewMonth.getMonth();
    if (!delta) return false;
    const old = animate ? grid.cloneNode(true) : null;
    viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderMonth();
    if (animate) slideGrid(Math.sign(delta), old);
    return true;
  }
  function pulseCell(key, delay) {
    grid.querySelector(`.cell[data-key="${key}"]`)?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
      { ...motion(SPRING_BOUNCY), delay: REDUCED.matches ? 0 : delay || 0 }
    );
  }

  function goToday() {
    if (innerWidth < 900) setTab('calendar');
    const moved = showMonthOf(new Date(), true);
    pulseCell(keyOf(new Date()), moved ? 220 : 0);
  }

  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('today-btn').addEventListener('click', goToday);

  grid.addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    // 앞뒤 달의 날짜를 누르면 그 달로 넘어간다. 그 달에서 다시 누르면 시간표가 열린다
    if (cell.classList.contains('outside')) {
      const key = cell.dataset.key;
      showMonthOf(parseKey(key), true);
      pulseCell(key, 220);
      return;
    }
    openDay(cell.dataset.key, cell);
  });

  // 좌우로 밀어서 달 넘기기
  let touchStart = null;
  grid.addEventListener('touchstart', e => {
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  grid.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
  });

  // ───────── 계정 메뉴 ─────────
  const taskList = $('task-list');
  const accountsWrap = $('accounts-wrap');
  const accountsEl = $('accounts');

  function timeAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
  }

  let autoRenew = ui.autoRenew !== false;

  function renderAccounts() {
    const frag = document.createDocumentFragment();
    const icons = {
      'google-personal': ['G', '#4285f4'],
      'google-school': ['G', '#34a853'],
      'microsoft-school': ['T', '#5b5fc7'],
    };
    const rows = [
      ...Google.status().map(a => ({ ...a, provider: Google })),
      { ...Microsoft.status(), provider: Microsoft },
    ];
    rows.forEach(acc => {
      const row = el('div', 'account');
      const icon = el('span', 'account-icon', icons[acc.id][0]);
      icon.style.background = icons[acc.id][1];
      const text = el('div', 'account-text');
      let sub;
      if (acc.busy) sub = '불러오는 중…';
      else if (acc.connected) {
        sub = acc.email || '연결됨';
        if (acc.expired) sub += autoRenew ? ' · 다음 클릭 때 갱신' : ' · 로그인 만료';
        else if (acc.lastSync) sub += ` · ${timeAgo(acc.lastSync)} 갱신`;
      } else sub = `${acc.services.join(' · ')} · 연결 안 됨`;
      text.append(el('div', 'account-name', acc.label), el('div', 'account-sub', sub));
      if (acc.error) text.append(el('div', 'account-error', acc.error));

      const actions = el('div', 'account-actions');
      const main = el('button', `pill-btn${acc.connected ? ' ghost' : ''}`, acc.connected ? '새로고침' : '연결');
      main.type = 'button';
      main.disabled = acc.busy;
      main.addEventListener('click', () => {
        if (!acc.provider.configured) {
          toast('config.js에 이 계정의 클라이언트 ID를 아직 넣지 않았다.');
          return;
        }
        acc.provider.connect(acc.id);
      });
      actions.append(main);
      if (acc.connected) {
        const off = el('button', 'link-btn', '연결 해제');
        off.type = 'button';
        off.addEventListener('click', () => acc.provider.disconnect(acc.id));
        actions.append(off);
      }
      row.append(icon, text, actions);
      frag.append(row);
    });

    // 자동 갱신 설정
    const opt = el('label', 'account account-opt');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = autoRenew;
    box.addEventListener('change', () => {
      autoRenew = box.checked;
      Store.setUI({ autoRenew });
      renderAccounts();
    });
    const optText = el('div', 'account-text');
    optText.append(
      el('div', 'account-name', '로그인 자동 갱신'),
      el('div', 'account-sub', '로그인이 끝나 갈 때 다음 클릭에 맞춰 로그인 창이 잠깐 열렸다 닫힌다'),
    );
    opt.append(optText, box);
    frag.append(opt);
    accountsEl.replaceChildren(frag);
  }

  // 계정 메뉴를 펴고 접는다. 접을 때도 같은 곡선으로 높이가 줄어 아래 목록이 따라 올라온다
  $('accounts-btn').addEventListener('click', e => {
    const btn = e.currentTarget;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    const from = accountsWrap.hidden ? 0 : accountsWrap.getBoundingClientRect().height;
    accountsWrap.getAnimations().forEach(a => a.cancel());
    accountsEl.getAnimations().forEach(a => a.cancel());
    accountsWrap.hidden = false;
    const full = accountsWrap.offsetHeight;
    if (open) {
      animateHeight(accountsWrap, from, full, SPRING_SMOOTH);
      accountsEl.animate([{ opacity: from / full, transform: `translateY(${-8 * (1 - from / full)}px)` }, { opacity: 1, transform: 'none' }], motion(SPRING_SMOOTH));
    } else {
      const a = animateHeight(accountsWrap, from, 0, EASE_OUT);
      accountsEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { ...motion(EASE_OUT), fill: 'forwards' });
      a.onfinish = () => {
        accountsWrap.hidden = true;
        accountsWrap.style.overflow = '';
        accountsEl.getAnimations().forEach(x => x.cancel());
      };
    }
  });

  // 로그인 자동 갱신: 팝업은 사용자 클릭 안에서만 열 수 있어서, 만료가 가까운 계정이 있으면 다음 클릭을 빌린다
  document.addEventListener('click', e => {
    if (!autoRenew || e.target.closest('.account')) return;
    const g = Google.renewable();
    if (g) Google.renew(g);
    else if (Microsoft.renewable()) Microsoft.renew();
  }, true);

  // ───────── 할 일 패널 ─────────
  function relLabel(ms, dateOnly) {
    const past = ms < 0;
    const a = Math.abs(ms);
    const min = Math.round(a / 60000);
    if (dateOnly) {
      const days = Math.round(a / 86400000);
      return past ? (days ? `${days}일 지남` : '오늘') : (days ? `D-${days}` : '오늘');
    }
    if (min < 60) return past ? `${min}분 지남` : `${min}분 남음`;
    const h = Math.round(min / 60);
    if (h < 24) return past ? `${h}시간 지남` : `${h}시간 남음`;
    const days = Math.floor(h / 24);
    return past ? `${days}일 지남` : `D-${days}`;
  }

  function dueLabel(d, hasTime) {
    const today = new Date();
    const k = keyOf(d);
    let day;
    if (k === keyOf(today)) day = '오늘';
    else if (k === keyOf(addDays(today, 1))) day = '내일';
    else if (k === keyOf(addDays(today, -1))) day = '어제';
    else day = `${d.getMonth() + 1}/${d.getDate()}(${WD_SHORT[d.getDay()]})`;
    return hasTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
  }

  // 할 일 묶음. 항목은 위에서부터 처음 맞는 묶음에 들어간다
  const SECTIONS = [
    { id: 'week', title: '이번주에 할 일', sub: '', match: () => false, week: true },
    { id: 'school', title: '학교', sub: 'Classroom · Teams', match: it => it.account === 'school' },
    { id: 'outside', title: '학교 외', sub: 'Classroom', match: it => it.source === 'classroom' },
    { id: 'mine', title: 'Tasks', sub: '내 할 일 목록', match: it => it.source === 'tasks', canAdd: true },
  ];
  const collapsed = new Set(ui.collapsed || ['school', 'outside']);
  const itemsById = new Map();
  let sectionBusy = 0;     // 묶음이 펴지거나 접히는 중이면 다시 그리기를 미룬다
  let renderPending = false;

  // 기한(시각까지)이 가까운 순서. 날짜만 있는 항목은 그날 끝으로 본다. 기한 없는 항목은 맨 아래
  function dueTime(it) {
    if (!it.due) return null;
    const d = new Date(it.due);
    return it.hasTime ? d : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
  }
  const dueMs = it => { const t = dueTime(it); return t ? t.getTime() : Infinity; };

  // ───────── 이번주에 할 일 ─────────
  // 기한이 이번 주(월~일)인 항목. 체크한 것은 원래 목록에서 사라져도(Tasks 완료 등) 그 주 동안 기억해 둔다.
  // 체크하고 월~금 시간표에도 올린 것이 '끝난 할 일'이다. 모두 끝나면 묶음이 아주 작게 줄어든다.
  const WEEK_KEY = 'timetable.week';
  const weekStart = (d = new Date()) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
  let weekMem = (() => { try { return JSON.parse(localStorage.getItem(WEEK_KEY)) || {}; } catch (e) { return {}; } })();
  const demoChecked = {};
  const weekInfo = new Map(); // id → { done, scheduled, live }

  function saveWeek() {
    try { localStorage.setItem(WEEK_KEY, JSON.stringify(weekMem)); } catch (e) { /* 무시 */ }
  }
  // 체크 기록. 주가 바뀌면 비우고, 지난주에 체크한 이 기기 할 일은 그때 지운다
  function weekChecks() {
    if (Sources.isDemo()) return demoChecked;
    const k = keyOf(weekStart());
    if (weekMem.week !== k) {
      const old = Object.keys(weekMem.checked || {}).filter(id => id.startsWith('local:'));
      weekMem = { week: k, checked: {} };
      saveWeek();
      if (old.length) setTimeout(() => old.forEach(id => Sources.removeItem(id)), 0);
    }
    return weekMem.checked;
  }

  function scheduledTaskIds() {
    const mon = weekStart();
    const ids = new Set();
    for (let i = 0; i < 5; i++) Store.getDay(keyOf(addDays(mon, i))).stacks.forEach(s => { if (s.taskId) ids.add(s.taskId); });
    return ids;
  }

  function weekItems(all) {
    const checked = weekChecks();
    const mon = weekStart(), end = addDays(mon, 7);
    const sched = scheduledTaskIds();
    const live = all.filter(it => { const t = dueTime(it); return t && t >= mon && t < end; });
    const liveIds = new Set(live.map(it => it.id));
    const list = [...live, ...Object.values(checked).filter(snap => !liveIds.has(snap.id))];
    weekInfo.clear();
    list.forEach(it => weekInfo.set(it.id, { done: !!checked[it.id] || !!it.done, scheduled: sched.has(it.id), live: liveIds.has(it.id) }));
    return list.sort((a, b) => (weekInfo.get(a.id).done - weekInfo.get(b.id).done) || dueMs(a) - dueMs(b));
  }

  async function toggleWeekCheck(it) {
    const checked = weekChecks();
    const info = weekInfo.get(it.id) || {};
    if (info.done) {
      if (!checked[it.id]) { toast('제출한 과제라 체크를 풀 수 없다'); return; }
      if (!info.live) { toast('Tasks에서 완료 처리해서 여기서는 되돌릴 수 없다'); return; }
      delete checked[it.id];
      saveWeek();
      renderTasks();
      return;
    }
    const { id, source, account, title, course, due, hasTime, link } = it;
    checked[id] = { id, source, account, title, course, due, hasTime, link, done: true };
    saveWeek();
    renderTasks();
    // 구글 Tasks 항목은 실제로 완료 처리한다. 클래스룸·Teams는 제출을 대신할 수 없어 여기에만 표시한다
    if (source === 'tasks' && it.ref && !Sources.isDemo()) {
      try {
        await Google.completeTask(it);
      } catch (err) {
        delete checked[id];
        saveWeek();
        renderTasks();
        toast(err.message);
      }
    }
  }

  // 묶음 id → 기한 순으로 정렬한 항목. 이번 주 항목은 '이번주에 할 일'에만 나온다
  function buildGroups() {
    const all = Sources.all();
    const week = weekItems(all);
    const inWeek = new Set(week.map(it => it.id));
    const out = new Map(SECTIONS.map(def => [def.id, []]));
    out.set('week', week);
    all.filter(it => !it.done && !inWeek.has(it.id)).sort((a, b) => dueMs(a) - dueMs(b)).forEach(it => {
      const def = SECTIONS.find(d => d.match(it));
      if (def) out.get(def.id).push(it);
    });
    return out;
  }

  function taskRow(it, now, def) {
    const t = dueTime(it);
    const src = SOURCE_INFO[it.source];
    const row = el('div', 'task');
    row.dataset.id = it.id;
    row.style.setProperty('--c', src.color);
    const wk = def && def.week ? weekInfo.get(it.id) : null;
    if (wk && wk.done) row.classList.add('done');
    else if (t && t < now) row.classList.add('overdue');
    else if (t && t - now < 24 * 3600 * 1000) row.classList.add('soon');

    if (wk) {
      // 이번 주 항목은 출처와 상관없이 체크할 수 있다
      const check = el('button', `task-check${wk.done ? ' on' : ''}`);
      check.type = 'button';
      check.setAttribute('aria-label', `${it.title} ${wk.done ? '완료 취소' : '완료'}`);
      check.setAttribute('aria-pressed', String(wk.done));
      check.addEventListener('click', ev => { ev.stopPropagation(); toggleWeekCheck(it); });
      row.append(check);
    } else if (it.source === 'tasks' && (it.ref || it.account === 'local')) {
      // 구글 Tasks 항목과 이 기기 할 일은 여기서 완료 처리할 수 있다
      const check = el('button', 'task-check');
      check.type = 'button';
      check.setAttribute('aria-label', `${it.title} 완료`);
      check.addEventListener('click', async ev => {
        ev.stopPropagation();
        check.classList.add('on');
        try {
          if (it.account === 'local') Sources.removeItem(it.id);
          else await Google.completeTask(it);
        } catch (err) {
          check.classList.remove('on');
          toast(err.message);
        }
      });
      row.append(check);
    } else {
      row.append(el('span', 'task-bar'));
    }

    const main = el('div', 'task-main');
    main.append(el('div', 'task-title', it.title));
    const meta = [];
    if (it.source === 'teams') meta.push('Teams');
    if (it.course) meta.push(it.course);
    if (it.account === 'local') meta.push('이 기기');
    if (meta.length) main.append(el('div', 'task-meta', meta.join(' · ')));
    row.append(main);

    if (wk) {
      // 월~금 시간표에 올렸는지
      const sch = el('span', `sched${wk.scheduled ? ' on' : ''}`);
      sch.title = wk.scheduled ? '이번 주 시간표에 올라가 있다' : '아직 시간표에 올리지 않았다. 끌어서 월~금 시간표에 놓는다';
      sch.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
      row.append(sch);
    }

    const due = el('div', 'task-due');
    if (t) {
      due.append(el('strong', null, relLabel(t - now, !it.hasTime)));
      due.append(el('span', null, dueLabel(new Date(it.due), it.hasTime)));
    }
    row.append(due);

    if (it.link) {
      const a = el('a', 'task-link');
      a.href = it.link;
      a.target = '_blank';
      a.rel = 'noopener';
      a.setAttribute('aria-label', `${src.label}에서 열기`);
      a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
      a.addEventListener('click', ev => ev.stopPropagation());
      row.append(a);
    }
    return row;
  }

  // 할 일 추가 입력줄. 다시 그려도 입력 중인 내용이 남도록 한 번만 만든다
  const addForm = (() => {
    const f = el('form', 'task-add');
    f.hidden = true;
    f.autocomplete = 'off';
    const title = el('input', 'task-add-title');
    title.placeholder = '새 할 일';
    title.maxLength = 120;
    title.enterKeyHint = 'done';
    const date = el('input', 'task-add-date');
    date.type = 'date';
    date.setAttribute('aria-label', '기한 날짜(선택)');
    const ok = el('button', 'pill-btn', '추가');
    ok.type = 'submit';
    f.append(title, date, ok);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const name = title.value.trim();
      if (!name) { title.focus(); return; }
      ok.disabled = true;
      try {
        if (Google.canAddTask()) {
          await Google.addTask(name, date.value || null);
          toast('Google Tasks에 추가했다');
        } else {
          Sources.addLocal(name, date.value || null);
          toast('이 기기에 저장했다. Google 개인 계정을 연결해 두면 Tasks에 바로 들어간다');
        }
        title.value = '';
        date.value = '';
        title.focus();
      } catch (err) {
        toast(err.message);
      } finally {
        ok.disabled = false;
      }
    });
    f.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); toggleAddForm(false); } });
    return { f, title };
  })();

  function toggleAddForm(open) {
    const sec = taskList.querySelector('.sec[data-sec="mine"]');
    if (open && collapsed.has('mine')) {
      addForm.f.hidden = false;
      toggleSection('mine');
    } else {
      const body = sec && sec.querySelector('.sec-body');
      const from = body ? body.offsetHeight : 0;
      addForm.f.hidden = !open;
      if (body) animateHeight(body, from, body.offsetHeight, open ? SPRING_SMOOTH : EASE_OUT);
    }
    sec?.querySelector('.sec-add')?.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => addForm.title.focus(), 30);
  }

  function fillBody(body, def, items, now) {
    body.replaceChildren();
    if (def.canAdd) body.append(addForm.f);
    if (!items.length) {
      body.append(el('p', 'sec-empty', def.week ? '이번 주가 기한인 할 일이 없다' : def.canAdd ? '할 일이 없다. + 버튼으로 추가한다' : '남은 과제가 없다'));
      return;
    }
    if (collapsed.has(def.id)) {
      // 접힌 묶음: 가장 급한 하나가 맨 앞에 있고 나머지는 뒤에 겹친 카드로 보인다
      const pile = el('div', 'pile');
      pile.dataset.n = Math.min(items.length, 3);
      for (let i = Math.min(items.length, 3) - 1; i >= 1; i--) pile.append(el('div', `pile-layer l${i}`));
      const front = taskRow(items[0], now, def);
      front.classList.add('front');
      pile.append(front);
      if (items.length > 1) pile.append(el('span', 'pile-more', `+${items.length - 1}`));
      body.append(pile);
    } else {
      const list = el('div', 'sec-list');
      items.forEach(it => list.append(taskRow(it, now, def)));
      body.append(list);
    }
  }

  function renderTasks() {
    if (sectionBusy || tdrag) { renderPending = true; return; }
    renderPending = false;
    const all = Sources.all().filter(it => !it.done);
    const now = new Date();
    const frag = document.createDocumentFragment();
    const groups = buildGroups();
    itemsById.clear();
    groups.forEach(items => items.forEach(it => itemsById.set(it.id, it)));

    if (Sources.isDemo()) {
      const note = el('div', 'demo-note');
      note.append(el('span', null, '예시 데이터를 보여 주는 중'));
      const off = el('button', null, '끄기');
      off.type = 'button';
      off.addEventListener('click', () => { Sources.setDemo(false); Store.setUI({ demo: false }); });
      note.append(off);
      frag.append(note);
    }

    const anyConnected = Google.status().some(a => a.connected) || Microsoft.status().connected;
    if (!anyConnected && !Sources.isDemo() && !all.some(it => it.account !== 'local')) {
      const empty = el('div', 'empty');
      empty.append(el('strong', null, '연결된 계정이 없다'));
      empty.append(document.createTextNode('오른쪽 위 사람 모양 버튼에서 계정을 연결하면 과제와 할 일이 여기에 모인다.'));
      empty.append(el('br'));
      const b = el('button', 'pill-btn', '예시로 미리 보기');
      b.type = 'button';
      b.addEventListener('click', () => { Sources.setDemo(true); Store.setUI({ demo: true }); });
      empty.append(b);
      frag.append(empty);
    }

    SECTIONS.forEach(def => {
      const items = groups.get(def.id);
      if (!items.length && !def.canAdd && !def.week) return;

      const sec = el('section', `sec${def.week ? ' week' : ''}`);
      sec.dataset.sec = def.id;
      let sub = def.sub;
      if (def.week) {
        const mon = weekStart(), sun = addDays(mon, 6);
        sub = `${mon.getMonth() + 1}/${mon.getDate()} – ${sun.getMonth() + 1}/${sun.getDate()}`;
        // 모두 체크하고 월~금 시간표에도 올렸으면 아주 작게
        const allDone = items.length > 0 && items.every(it => { const w = weekInfo.get(it.id); return w.done && w.scheduled; });
        sec.classList.toggle('all-done', allDone);
        if (allDone) sub += ' · 모두 끝냈다';
      }
      const head = el('div', 'sec-head');
      const toggle = el('button', 'sec-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(!collapsed.has(def.id)));
      toggle.innerHTML = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
      toggle.append(el('span', 'sec-title', def.title), el('span', 'sec-sub', sub));
      const pending = def.week ? items.filter(it => !weekInfo.get(it.id).done) : items;
      const overdue = pending.filter(it => { const t = dueTime(it); return t && t < now; }).length;
      const count = el('span', `sec-count${overdue ? ' alert' : ''}`, def.week ? `${items.length - pending.length}/${items.length}` : items.length);
      if (overdue) count.title = `지난 마감 ${overdue}개`;
      toggle.append(count);
      head.append(toggle);
      if (def.canAdd) {
        const add = el('button', 'icon-btn sec-add');
        add.type = 'button';
        add.setAttribute('aria-label', '할 일 추가');
        add.setAttribute('aria-expanded', String(!addForm.f.hidden));
        add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
        add.addEventListener('click', () => toggleAddForm(addForm.f.hidden));
        head.append(add);
      }
      const body = el('div', 'sec-body');
      fillBody(body, def, items, now);
      sec.append(head, body);
      frag.append(sec);
    });
    // 입력줄을 옮기면 포커스가 풀리니 다시 잡아 준다
    const focused = addForm.f.contains(document.activeElement) ? document.activeElement : null;
    taskList.replaceChildren(frag);
    if (focused) focused.focus({ preventScroll: true });
  }

  // 묶음 펴기·접기. 펼 때는 겹쳐 있던 카드들이 제자리로 튕기듯 퍼지고, 접을 때는 맨 앞 카드 뒤로 모인다
  function toggleSection(id) {
    const sec = taskList.querySelector(`.sec[data-sec="${id}"]`);
    if (!sec) return;
    const def = SECTIONS.find(s => s.id === id);
    const body = sec.querySelector('.sec-body');
    const opening = collapsed.has(id);
    if (opening) collapsed.delete(id); else collapsed.add(id);
    Store.setUI({ collapsed: [...collapsed] });
    sec.querySelector('.sec-toggle').setAttribute('aria-expanded', String(opening));

    const from = body.getBoundingClientRect().height;
    body.getAnimations({ subtree: true }).forEach(a => a.cancel());
    const now = new Date();
    const sorted = buildGroups().get(id);

    sectionBusy++;
    const done = () => {
      sectionBusy = Math.max(0, sectionBusy - 1);
      if (!sectionBusy && renderPending) renderTasks();
    };

    if (opening) {
      fillBody(body, def, sorted, now);
      const to = body.offsetHeight;
      animateHeight(body, from, to, SPRING_ELASTIC);
      const rows = [...body.querySelectorAll('.sec-list .task')];
      const pileTop = rows.length ? rows[0].offsetTop : 0;
      let last = null;
      rows.forEach((r, i) => {
        const k = Math.min(i, 2);
        const dy = pileTop + k * 5 - r.offsetTop;
        r.style.zIndex = String(rows.length - i);
        last = r.animate([
          { transform: `translateY(${dy}px) scale(${1 - k * 0.04})`, opacity: i > 2 ? 0 : 1 },
          { transform: 'none', opacity: 1 },
        ], { ...motion(SPRING_ELASTIC), delay: REDUCED.matches ? 0 : i * 26, fill: 'backwards' });
      });
      const finish = () => { rows.forEach(r => { r.style.zIndex = ''; }); done(); };
      if (last) last.finished.then(finish, finish); else finish();
    } else {
      const rows = [...body.querySelectorAll('.sec-list .task')];
      if (!rows.length) { fillBody(body, def, sorted, now); done(); return; }
      const pileTop = rows[0].offsetTop;
      // 접힌 뒤의 높이를 미리 재 둔다
      const probe = el('div', 'sec-body');
      probe.style.cssText = `position:absolute;visibility:hidden;width:${body.offsetWidth}px`;
      fillBody(probe, def, sorted, now);
      if (def.canAdd) body.prepend(addForm.f); // fillBody가 가져간 입력줄을 되돌린다
      sec.append(probe);
      const to = probe.offsetHeight;
      probe.remove();
      rows.forEach((r, i) => {
        const k = Math.min(i, 2);
        r.style.zIndex = String(rows.length - i);
        r.animate([
          { transform: 'none', opacity: 1 },
          { transform: `translateY(${pileTop + k * 5 - r.offsetTop}px) scale(${1 - k * 0.04})`, opacity: i > 2 ? 0 : 1 },
        ], { ...motion(EASE_OUT), fill: 'forwards' });
      });
      const a = animateHeight(body, from, to, EASE_OUT);
      a.onfinish = () => {
        body.style.overflow = '';
        fillBody(body, def, sorted, now);
        // 앞 카드가 살짝 내려앉는 느낌
        body.querySelector('.pile')?.animate([{ transform: 'translateY(-3px)' }, { transform: 'none' }], motion(SPRING_BOUNCY));
        done();
      };
      a.oncancel = done;
    }
  }

  taskList.addEventListener('click', e => {
    if (suppressRowClick) return;
    const toggle = e.target.closest('.sec-toggle');
    if (toggle) { toggleSection(toggle.closest('.sec').dataset.sec); return; }
    const front = e.target.closest('.pile');
    if (front && !e.target.closest('button, a')) { toggleSection(front.closest('.sec').dataset.sec); return; }
    const row = e.target.closest('.sec-list .task');
    if (!row || e.target.closest('button, a')) return;
    const it = itemsById.get(row.dataset.id);
    if (!it || !it.due) return;
    const d = new Date(it.due);
    const key = keyOf(d);
    showMonthOf(d, false);
    const cell = grid.querySelector(`.cell[data-key="${key}"]`);
    openDay(key, cell && cell.offsetParent ? cell : row, it.hasTime ? dueInfo(it).min : null);
  });

  // 놓아 본 결과를 한 줄로
  function placeHint(res) {
    const p = res.placed;
    const range = `${fmtTime(p.start)} – ${fmtTime(p.start + p.minutes)}`;
    if (res.kind === 'period') return `${periodLabel(p.period)} · ${range}`;
    if (res.kind === 'split') return `나누어 끼워 넣기 · ${range}`;
    if (res.kind === 'snap') return `빈자리에 붙이기 · ${range}`;
    return range;
  }

  // ───────── 할 일을 끌어 시간표에 넣기 ─────────
  // PC는 바로 끌고, 폰은 길게 눌러 집어 든다. 열린 시간표 창에 놓으면 그 시각에,
  // 달력 칸에 놓으면 그 날짜 창을 열고 스택 시트를 띄운다. 길이와 색은 시트에서 정한다.
  // 폰에서 끄는 중에 아래 '캘린더' 탭 위에 잠깐 머물면 캘린더로 넘어간다.
  const ghost = $('task-ghost');
  let tdrag = null;
  let suppressRowClick = false;

  taskList.addEventListener('pointerdown', e => {
    if (e.button !== 0 || tdrag) return;
    const row = e.target.closest('.sec-list .task');
    if (!row || e.target.closest('button, a, input')) return;
    const it = itemsById.get(row.dataset.id);
    if (!it) return;
    tdrag = { row, it, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, active: false, timer: null, target: null, hoverTimer: null, hoverEl: null, raf: 0 };
    if (e.pointerType !== 'mouse') tdrag.timer = setTimeout(beginTaskDrag, 380);
    addEventListener('pointermove', onTaskDragMove);
    addEventListener('pointerup', onTaskDragEnd);
    addEventListener('pointercancel', onTaskDragCancel);
  });
  taskList.addEventListener('contextmenu', e => { if (e.target.closest('.sec-list .task')) e.preventDefault(); });

  function beginTaskDrag() {
    const d = tdrag;
    if (!d) return;
    clearTimeout(d.timer);
    d.active = true;
    d.row.classList.add('picked');
    const color = SOURCE_INFO[d.it.source].stack;
    ghost.style.setProperty('--c', color);
    ghost.replaceChildren(el('strong', null, d.it.title), el('span', null, `${fmtDur(DROP_MIN)} · 놓을 곳으로`));
    ghost.hidden = false;
    moveGhost();
    ghost.animate([{ transform: `${ghostPos()} scale(0.8)`, opacity: 0 }, { transform: `${ghostPos()} scale(1)`, opacity: 1 }], motion(SPRING_BOUNCY));
    document.body.classList.add('dragging');
    if (d.type !== 'mouse' && navigator.vibrate) navigator.vibrate(8);
    d.raf = requestAnimationFrame(taskDragScroll);
  }

  const ghostPos = () => `translate(${tdrag.x + 14}px, ${tdrag.y + 14}px)`;
  function moveGhost() { ghost.style.transform = ghostPos(); }

  function onTaskDragMove(e) {
    const d = tdrag;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      if (Math.hypot(d.x - d.sx, d.y - d.sy) > (d.type === 'mouse' ? 5 : 8)) {
        if (d.type === 'mouse') beginTaskDrag();
        else { cleanupTaskDrag(); return; } // 터치로 그냥 민 것은 스크롤
      } else return;
    }
    e.preventDefault();
    moveGhost();
    updateDropTarget();
  }

  // 놓을 곳 찾기
  function updateDropTarget() {
    const d = tdrag;
    const hit = document.elementFromPoint(d.x, d.y);
    let target = null;
    const winEl = hit && hit.closest('.win');
    const w = winEl && winOf.get(winEl);
    if (w && w.mode === 'open' && hit.closest('.win-body')) {
      const r = w.stacks.getBoundingClientRect();
      const raw = clamp(Math.floor((d.y - r.top) / PPM / 15) * 15, 0, DAY_MIN - DROP_MIN);
      const res = tryPlace(w.key, { id: '__drop', name: d.it.title, start: raw, minutes: DROP_MIN, x: 0, w: 1 });
      target = { kind: 'win', w, start: res.ok ? res.placed.start : raw, res };
    } else if (hit && hit.closest('.cell')) {
      target = { kind: 'cell', cell: hit.closest('.cell') };
    }

    // 미리보기 표시
    wins.forEach(x => {
      if (!target || target.kind !== 'win' || target.w !== x) { x.showDropPreview(null); return; }
      const res = target.res;
      x.showDropPreview(res.ok ? res.placed : { start: target.start, minutes: DROP_MIN }, SOURCE_INFO[d.it.source].stack, res.ok ? placeHint(res) : res.note, !res.ok);
    });
    grid.querySelectorAll('.cell.drop-target').forEach(c => { if (!target || target.cell !== c) c.classList.remove('drop-target'); });
    if (target && target.kind === 'cell') target.cell.classList.add('drop-target');
    ghost.querySelector('span').textContent = target
      ? target.kind === 'win'
        ? (target.res.ok ? `${fmtTime(target.res.placed.start)}부터 ${fmtDur(target.res.placed.minutes)}` : target.res.note)
        : `${target.cell.getAttribute('aria-label').split(',')[0]}에 넣기`
      : `${fmtDur(DROP_MIN)} · 놓을 곳으로`;
    d.target = target;

    // 탭 버튼이나 최소화된 창 위에 잠깐 머물면 열어 준다
    const spring = hit && (hit.closest('.tabbar [data-tab="calendar"]') || hit.closest('.dock-item'));
    if (spring !== d.hoverEl) {
      clearTimeout(d.hoverTimer);
      d.hoverEl = spring;
      if (spring) {
        d.hoverTimer = setTimeout(() => {
          if (!tdrag || tdrag.hoverEl !== spring) return;
          if (spring.matches('.dock-item')) spring.click();
          else setTab('calendar');
        }, 550);
      }
    }
  }

  // 시간표 창의 위·아래 가장자리 근처에서는 저절로 스크롤
  function taskDragScroll() {
    const d = tdrag;
    if (!d || !d.active) return;
    if (d.target && d.target.kind === 'win') {
      const sc = d.target.w.scroll;
      const r = sc.getBoundingClientRect();
      let v = 0;
      if (d.y < r.top + 48) v = -Math.ceil((r.top + 48 - d.y) / 4);
      else if (d.y > r.bottom - 48) v = Math.ceil((d.y - (r.bottom - 48)) / 4);
      if (v) { sc.scrollTop += v; updateDropTarget(); }
    }
    d.raf = requestAnimationFrame(taskDragScroll);
  }

  function cleanupTaskDrag() {
    const d = tdrag;
    if (!d) return;
    clearTimeout(d.timer);
    clearTimeout(d.hoverTimer);
    cancelAnimationFrame(d.raf);
    d.row.classList.remove('picked');
    ghost.hidden = true;
    ghost.getAnimations().forEach(a => a.cancel());
    document.body.classList.remove('dragging');
    wins.forEach(x => x.showDropPreview(null));
    grid.querySelectorAll('.cell.drop-target').forEach(c => c.classList.remove('drop-target'));
    removeEventListener('pointermove', onTaskDragMove);
    removeEventListener('pointerup', onTaskDragEnd);
    removeEventListener('pointercancel', onTaskDragCancel);
    tdrag = null;
    if (renderPending) renderTasks();
  }

  function onTaskDragEnd() {
    const d = tdrag;
    if (!d) return;
    const { active, target, it } = d;
    cleanupTaskDrag();
    if (!active) return;
    // 끌기를 끝낸 뒤 따라오는 click은 무시한다
    suppressRowClick = true;
    setTimeout(() => { suppressRowClick = false; }, 0);
    if (!target || (target.kind === 'win' && !target.res.ok)) {
      if (target) toast(target.res.note);
      return;
    }
    const prefill = { name: it.title, minutes: DROP_MIN, color: SOURCE_INFO[it.source].stack, taskId: it.id };
    if (target.kind === 'win') {
      target.w.focus();
      openSheet(target.w, { ...prefill, start: target.start });
    } else {
      const key = target.cell.dataset.key;
      const w = openDay(key, target.cell);
      if (!w) return;
      // 그날이 마감인 과제면 마감 한 시간 전에 끝나도록 놓는다
      const info = dueInfo(it);
      const start = info && it.hasTime && info.key === key ? clamp(info.min - DROP_MIN - 60, 0, DAY_MIN - DROP_MIN) : undefined;
      openSheet(w, { ...prefill, start });
    }
  }

  function onTaskDragCancel() { cleanupTaskDrag(); }

  // ───────── 하루 시간표 창(여러 개) ─────────
  const winLayer = $('windows');
  const dockEl = $('dock');
  const winTpl = $('win-tpl');
  const winOf = new WeakMap();
  const wins = [];           // 열려 있거나 최소화된 창. 뒤쪽일수록 위에 있다
  const HOUR_PX = 64;
  const PPM = HOUR_PX / 60;  // 1분당 픽셀

  function defaultRect() {
    const vw = innerWidth, vh = innerHeight;
    if (vw < 640) return { x: 8, y: 8, w: vw - 16, h: vh - 92 };
    const w = Math.min(520, vw - 40);
    const h = Math.min(720, vh - 48);
    return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
  }

  // 창이 화면 밖으로 나가지 않게. 제목 줄은 항상 잡을 수 있게 남긴다
  function clampRect(r) {
    const vw = innerWidth, vh = innerHeight;
    const w = clamp(r.w, Math.min(300, vw - 16), vw - 16);
    const h = clamp(r.h, Math.min(260, vh - 16), vh - 16);
    return {
      w, h,
      x: clamp(r.x, -w + 120, vw - 120),
      y: clamp(r.y, 0, vh - 56),
    };
  }

  // a에서 b로 가는 transform(transform-origin 0 0 기준)
  function flip(from, to) {
    return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  }

  const activeWin = () => {
    for (let i = wins.length - 1; i >= 0; i--) if (wins[i].mode === 'open') return wins[i];
    return null;
  };

  function markOpenCells() {
    const keys = new Set(wins.map(w => w.key));
    grid.querySelectorAll('.cell').forEach(c => c.classList.toggle('open', keys.has(c.dataset.key)));
  }

  function restack() {
    wins.forEach((w, i) => {
      w.root.style.zIndex = String(10 + i);
      w.root.classList.toggle('front', i === wins.length - 1 || wins.slice(i + 1).every(x => x.mode !== 'open'));
    });
  }

  function renderDock() {
    const mins = wins.filter(w => w.mode === 'min');
    dockEl.hidden = !mins.length;
    mins.forEach(w => { if (w.dockItem.parentNode !== dockEl) dockEl.append(w.dockItem); });
  }

  class DayWin {
    constructor(key) {
      this.key = key;
      this.mode = 'closed';
      this.selectedId = null;
      this.pendingHighlight = null;
      this.animating = false;
      this.dropPreview = null;

      const root = winTpl.content.firstElementChild.cloneNode(true);
      const q = s => root.querySelector(s);
      this.root = root;
      this.body = q('.win-body');
      this.scroll = q('.timeline-scroll');
      this.hours = q('.hours');
      this.stacks = q('.stacks');
      this.deadlines = q('.deadlines');
      this.nowLine = q('.now-line');
      this.tip = q('.drag-tip');
      this.titleEl = q('.win-date');
      this.summaryEl = q('.win-summary');
      this.todayBtn = q('[data-act="today"]');
      this.schoolEl = q('.school');
      this.schoolBtn = q('[data-act="school"]');
      winOf.set(root, this);

      // 새 창은 앞 창에서 조금씩 비켜 연다
      const base = clampRect(Store.getUI().win || defaultRect());
      const n = wins.filter(w => w.mode === 'open').length;
      const step = innerWidth < 640 ? 0 : 28;
      this.rect = clampRect({ ...base, x: base.x + n * step, y: base.y + n * step });

      this.dockItem = el('button', 'dock-item');
      this.dockItem.type = 'button';
      this.dockItem.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>';
      this.dockLabel = el('span');
      this.dockItem.append(this.dockLabel);
      this.dockItem.addEventListener('click', () => this.restore());

      root.addEventListener('pointerdown', () => this.focus(), true);
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'prev') this.goDay(-1);
        else if (act === 'next') this.goDay(1);
        else if (act === 'today') this.setKey(keyOf(new Date()));
        else if (act === 'school') {
          const on = !School.isSchoolDay(this.key);
          School.setSchoolDay(this.key, on);
          toast(on ? '이 날 학교 시간표를 켰다' : '이 날 학교 시간표를 껐다(교시에 넣은 스택은 그대로 남는다)');
        }
        else if (act === 'min') this.minimize();
        else if (act === 'close') this.close();
        else if (act === 'add') openSheet(this, {});
      });
      this.bindMoveResize();
      this.bindStacks();
      winLayer.append(root);
    }

    applyRect() {
      this.rect = clampRect(this.rect);
      const s = this.root.style;
      s.left = `${this.rect.x}px`;
      s.top = `${this.rect.y}px`;
      s.width = `${this.rect.w}px`;
      s.height = `${this.rect.h}px`;
    }

    focus() {
      const i = wins.indexOf(this);
      if (i < 0 || i === wins.length - 1) return;
      wins.splice(i, 1);
      wins.push(this);
      restack();
    }

    pulse() {
      this.root.classList.remove('focus-pulse');
      void this.root.offsetWidth;
      this.root.classList.add('focus-pulse');
    }

    zoomIn(fromRect) {
      const to = this.root.getBoundingClientRect();
      const m = motion(SPRING_SMOOTH);
      this.animating = true;
      const a = this.root.animate([{ transform: flip(fromRect, to), opacity: 0.6 }, { transform: 'none', opacity: 1 }], m);
      [...this.root.children].forEach(c => c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], m));
      return a.finished.finally(() => { this.animating = false; });
    }

    zoomOut(toRect) {
      const root = this.root;
      const from = root.getBoundingClientRect();
      this.animating = true;
      const opts = { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' };
      const frames = toRect
        ? [{ transform: 'none', opacity: 1 }, { transform: flip(toRect, from), opacity: 0.2 }]
        : [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.92)', opacity: 0 }];
      if (!toRect) root.style.transformOrigin = '50% 50%';
      [...root.children].forEach(c => c.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], opts));
      return root.animate(frames, REDUCED.matches ? { duration: 1, fill: 'forwards' } : opts).finished.finally(() => {
        root.hidden = true;
        root.style.transformOrigin = '';
        root.getAnimations({ subtree: true }).forEach(an => an.cancel());
        this.animating = false;
      });
    }

    open(fromRect, focusMin) {
      this.mode = 'open';
      this.root.hidden = false;
      this.applyRect();
      this.render();
      this.scrollToFocus(focusMin);
      restack();
      markOpenCells();
      this.zoomIn(fromRect);
    }

    restore() {
      if (this.mode !== 'min' || this.animating) return;
      const from = this.dockItem.getBoundingClientRect();
      this.dockItem.remove();
      this.mode = 'open';
      this.focus();
      renderDock();
      this.root.hidden = false;
      this.applyRect();
      this.render();
      restack();
      this.zoomIn(from);
    }

    minimize() {
      if (this.animating || this.mode !== 'open') return;
      if (sheetWin === this) closeSheet(true);
      const d = parseKey(this.key);
      this.dockLabel.textContent = `${d.getMonth() + 1}/${d.getDate()}(${WD_SHORT[d.getDay()]})`;
      this.mode = 'min';
      renderDock();
      restack();
      this.zoomOut(this.dockItem.getBoundingClientRect());
      this.dockItem.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { ...motion(SPRING_BOUNCY), delay: 120, fill: 'backwards' });
    }

    close() {
      if (this.animating) return;
      if (sheetWin === this) closeSheet(true);
      if (gesture && gesture.w === this) cleanupGesture();
      const wasMin = this.mode === 'min';
      this.mode = 'closed';
      wins.splice(wins.indexOf(this), 1);
      this.dockItem.remove();
      renderDock();
      restack();
      markOpenCells();
      if (wasMin) { this.root.remove(); return; }
      const cell = appEl.dataset.tab === 'calendar' || innerWidth >= 900
        ? grid.querySelector(`.cell[data-key="${this.key}"]`)
        : null;
      const target = cell && cell.offsetParent ? cell.getBoundingClientRect() : null;
      this.zoomOut(target).then(() => this.root.remove());
    }

    setKey(key, dir) {
      if (key === this.key) return;
      dir = dir || (key > this.key ? 1 : -1);
      this.key = key;
      this.selectedId = null;
      showMonthOf(parseKey(key), false);
      markOpenCells();
      this.render();
      this.scrollToFocus(null);
      this.body.animate([{ transform: `translateX(${dir * 30}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], motion(SPRING_SMOOTH));
    }

    goDay(delta) {
      if (this.mode !== 'open' || this.animating) return;
      this.setKey(keyOf(addDays(parseKey(this.key), delta)), delta);
    }

    // 제목 줄을 잡고 옮기기, 가장자리·모서리를 잡고 크기 바꾸기
    bindMoveResize() {
      const root = this.root;
      const drag = (e, onMove, cls) => {
        e.preventDefault();
        document.body.classList.add(cls);
        const up = () => {
          document.body.classList.remove(cls);
          removeEventListener('pointermove', onMove);
          removeEventListener('pointerup', up);
          removeEventListener('pointercancel', up);
          Store.setUI({ win: this.rect });
        };
        addEventListener('pointermove', onMove);
        addEventListener('pointerup', up);
        addEventListener('pointercancel', up);
      };
      root.querySelector('.win-titlebar').addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const sx = e.clientX, sy = e.clientY, ox = this.rect.x, oy = this.rect.y;
        drag(e, ev => {
          this.rect = { ...this.rect, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy };
          this.applyRect();
        }, 'dragging');
      });
      root.querySelector('.win-titlebar').addEventListener('dblclick', e => {
        if (!e.target.closest('button')) this.minimize();
      });
      root.querySelectorAll('.rz').forEach(h => h.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const dir = h.dataset.dir;
        const sx = e.clientX, sy = e.clientY, o = { ...this.rect };
        const minW = Math.min(300, innerWidth - 16), minH = Math.min(260, innerHeight - 16);
        drag(e, ev => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          let { x, y, w, h: hh } = o;
          if (dir.includes('e')) w = o.w + dx;
          if (dir.includes('s')) hh = o.h + dy;
          if (dir.includes('w')) { w = clamp(o.w - dx, minW, o.x + o.w - 8); x = o.x + o.w - w; }
          if (dir.includes('n')) { hh = clamp(o.h - dy, minH, o.y + o.h); y = o.y + o.h - hh; }
          this.rect = { x, y, w: Math.max(minW, w), h: Math.max(minH, hh) };
          this.applyRect();
        }, 'resizing');
      }));
    }

    bindStacks() {
      const st = this.stacks;
      st.addEventListener('contextmenu', e => { if (e.target.closest('.stack')) e.preventDefault(); });
      st.addEventListener('pointerdown', e => startGesture(this, e));
      // 빈 곳을 누르면: 선택 해제, 선택이 없었으면 그 시각에 새 스택
      st.addEventListener('click', e => {
        if (e.target !== st) return;
        if (this.selectedId) { this.select(null); return; }
        const y = e.clientY - st.getBoundingClientRect().top;
        openSheet(this, { start: clamp(Math.floor(y / PPM / 15) * 15, 0, DAY_MIN - 15) });
      });
      st.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const node = e.target.closest('.stack');
        if (!node) return;
        e.preventDefault();
        openSheet(this, { id: node.dataset.id });
      });
    }

    render() {
      if (this.mode === 'closed') return;
      const key = this.key;
      const highlight = new Set([].concat(this.pendingHighlight || []));
      this.pendingHighlight = null;
      const d = parseKey(key);
      const day = Store.getDay(key);
      const isToday = key === keyOf(new Date());
      this.todayBtn.hidden = isToday;

      const title = this.titleEl;
      title.replaceChildren(document.createTextNode(`${d.getMonth() + 1}월 ${d.getDate()}일 `));
      title.append(el('span', d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : null, WEEKDAYS[d.getDay()]));
      if (isToday) title.append(document.createTextNode(' '), el('span', 'today', '오늘'));
      const holiday = School.holidayName(key);
      if (holiday) title.append(document.createTextNode(' '), el('span', 'holiday', holiday));
      const school = School.isSchoolDay(key);
      this.schoolBtn.setAttribute('aria-pressed', String(school));
      this.root.setAttribute('aria-label', `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 시간표`);

      const dues = deadlinesOn(key);
      const total = day.stacks.reduce((sum, s) => sum + s.minutes, 0);
      const parts = [];
      if (day.stacks.length) parts.push(`스택 ${day.stacks.length}개 · 합계 ${fmtDur(total)}`);
      if (dues.length) parts.push(`마감 ${dues.length}개`);
      this.summaryEl.textContent = parts.length ? parts.join(' · ') : '빈 곳을 누르거나 + 버튼으로 스택을 만든다';
      if (this.mode === 'min') {
        this.dockLabel.textContent = `${d.getMonth() + 1}/${d.getDate()}(${WD_SHORT[d.getDay()]})`;
        return;
      }

      // 시간 눈금. 스택이 자정을 넘기면 그만큼 늘린다
      const lastEnd = day.stacks.reduce((m, s) => Math.max(m, s.start + s.minutes), 0);
      const endHour = Math.max(24, Math.ceil(lastEnd / 60));
      if (this.hours.childElementCount !== endHour) {
        const frag = document.createDocumentFragment();
        for (let h = 0; h < endHour; h++) {
          const row = el('div', 'hour');
          row.append(el('span', null, h === 0 ? '' : `${pad(h % 24)}:00`));
          frag.append(row);
        }
        this.hours.replaceChildren(frag);
      }

      // 기존 요소를 재사용해야 위치가 바뀔 때 부드럽게 움직인다
      this.renderSchool(school);

      // 나뉜 스택은 첫 조각이 아닌 것에 '이어서' 표시
      const firstOfGroup = new Map();
      day.stacks.forEach(s => {
        if (s.group && (!firstOfGroup.has(s.group) || s.start < firstOfGroup.get(s.group).start)) firstOfGroup.set(s.group, s);
      });

      const st = this.stacks;
      const existing = new Map([...st.querySelectorAll('.stack')].map(n => [n.dataset.id, n]));
      st.querySelector('.empty-hint')?.remove();

      day.stacks.forEach((s, i) => {
        let node = existing.get(s.id);
        const isNew = !node;
        if (isNew) {
          node = el('div', 'stack');
          node.dataset.id = s.id;
          const card = el('div', 'stack-card');
          card.setAttribute('role', 'button');
          card.tabIndex = 0;
          card.append(el('span', 'stack-name'), el('span', 'stack-time'));
          node.append(card);
          ['t', 'b', 'l', 'r'].forEach(k => {
            const hd = el('div', `sh ${k}`);
            hd.dataset.h = k;
            node.append(hd);
          });
        }
        existing.delete(s.id);
        placeStack(node, s);
        node.classList.toggle('selected', s.id === this.selectedId);
        const cont = !!s.group && firstOfGroup.get(s.group).id !== s.id;
        node.classList.toggle('cont', cont);
        node.classList.toggle('split', !!s.group);
        node.querySelector('.stack-name').textContent = cont ? `↳ ${s.name}` : s.name;
        node.querySelector('.stack-card').setAttribute('aria-label', `${s.name}, ${fmtTime(s.start)}부터 ${fmtDur(s.minutes)}`);
        if (st.children[i] !== node) st.insertBefore(node, st.children[i] || null);
        if (isNew && highlight.has(s.id)) {
          node.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], motion(SPRING_BOUNCY));
        }
      });
      existing.forEach(n => n.remove());

      if (!day.stacks.length) {
        const hint = el('div', 'empty-hint', '빈 시간을 누르거나 할 일을 끌어다 놓으면 스택이 생긴다');
        hint.style.top = `${Store.DEFAULT_START * PPM + 4}px`;
        st.append(hint);
      }
      if (this.dropPreview) st.append(this.dropPreview);

      // 과제 마감선
      this.deadlines.replaceChildren(...dues.map(({ it, info }) => {
        const line = el('div', 'deadline');
        line.style.top = `${info.min * PPM}px`;
        line.style.setProperty('--c', SOURCE_INFO[it.source].color);
        line.append(el('span', null, `마감 ${fmtTime(info.min)} · ${it.title}`));
        return line;
      }));

      this.updateNowLine();
    }

    // 학교 가는 날: 교시와 점심시간을 연한 배경으로 깐다
    renderSchool(on) {
      const sig = on ? 'on' : '';
      if (this.schoolEl.dataset.sig === sig) return;
      this.schoolEl.dataset.sig = sig;
      if (!on) { this.schoolEl.replaceChildren(); return; }
      this.schoolEl.replaceChildren(...[...School.PERIODS, School.LUNCH].map(p => {
        const b = el('div', `period${p.id === 'lunch' ? ' lunch' : ''}`);
        b.style.top = `${p.start * PPM}px`;
        b.style.height = `${(p.end - p.start) * PPM}px`;
        b.append(el('span', null, `${p.label} ${fmtTime(p.start)}–${fmtTime(p.end)}`));
        return b;
      }));
    }

    // 끌어 놓을 자리 미리 보기. at: { start, minutes } 또는 null
    showDropPreview(at, color, text, bad) {
      if (!at) {
        this.dropPreview?.remove();
        this.dropPreview = null;
        return;
      }
      if (!this.dropPreview) {
        this.dropPreview = el('div', 'drop-preview');
        this.stacks.append(this.dropPreview);
      }
      const p = this.dropPreview;
      p.classList.toggle('bad', !!bad);
      p.style.setProperty('--c', bad ? 'var(--danger)' : color);
      p.style.top = `${at.start * PPM}px`;
      p.style.height = `${at.minutes * PPM}px`;
      p.textContent = text || `${fmtTime(at.start)} – ${fmtTime(at.start + at.minutes)}`;
    }

    updateNowLine() {
      const now = new Date();
      if (this.key !== keyOf(now)) { this.nowLine.hidden = true; return; }
      this.nowLine.hidden = false;
      this.nowLine.style.top = `${(now.getHours() * 60 + now.getMinutes()) * PPM}px`;
    }

    // 처음 열 때 볼 위치: 지정한 시각, 오늘이면 지금, 아니면 첫 스택이나 08:00
    scrollToFocus(min, smooth) {
      if (min == null) {
        const day = Store.getDay(this.key);
        if (this.key === keyOf(new Date())) {
          const n = new Date();
          min = n.getHours() * 60 + n.getMinutes() - 60;
        } else if (day.stacks.length) {
          min = Math.min(...day.stacks.map(s => s.start)) - 30;
        } else {
          min = Store.DEFAULT_START - 30;
        }
      } else {
        min -= 90;
      }
      this.scroll.scrollTo({ top: Math.max(0, min * PPM), behavior: smooth ? 'smooth' : 'auto' });
    }

    scrollToStack(id) {
      const node = this.stacks.querySelector(`.stack[data-id="${id}"]`);
      if (!node) return;
      const sc = this.scroll;
      const top = node.offsetTop, bottom = top + node.offsetHeight;
      if (top < sc.scrollTop + 10 || bottom > sc.scrollTop + sc.clientHeight - 80) {
        sc.scrollTo({ top: Math.max(0, top - 60), behavior: 'smooth' });
      }
    }

    select(id) {
      this.selectedId = id;
      this.stacks.querySelectorAll('.stack').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
    }
  }

  // 날짜를 누르면 그 날짜 창을 연다. 이미 열려 있으면 앞으로 가져온다
  function openDay(key, fromEl, focusMin) {
    const existing = wins.find(w => w.key === key);
    if (existing) {
      if (existing.mode === 'min') existing.restore();
      else { existing.focus(); existing.pulse(); }
      if (focusMin != null) existing.scrollToFocus(focusMin, true);
      return existing;
    }
    if (wins.length >= MAX_WINS) {
      toast(`시간표 창은 ${MAX_WINS}개까지 열 수 있다. 하나를 닫고 연다`);
      return null;
    }
    const w = new DayWin(key);
    wins.push(w);
    w.open(fromEl.getBoundingClientRect(), focusMin);
    return w;
  }

  addEventListener('resize', () => {
    wins.forEach(w => { if (w.mode === 'open') w.applyRect(); });
    if (ui.tasksW || appEl.style.getPropertyValue('--tasks-w')) setTasksWidth(tasksPane.offsetWidth);
    requestAnimationFrame(trimMiniChips);
  });

  function placeStack(node, s) {
    const h = s.minutes * PPM;
    node.style.top = `${s.start * PPM}px`;
    node.style.height = `${h}px`;
    node.style.left = `${s.x * 100}%`;
    node.style.width = `${s.w * 100}%`;
    node.style.setProperty('--c', s.color);
    node.classList.toggle('compact', h < 44);
    node.classList.toggle('tiny', h < 26);
    node.classList.toggle('period', !!s.period);
    node.querySelector('.stack-time').textContent = s.period
      ? `${periodLabel(s.period)} · ${fmtTime(s.start)}–${fmtTime(s.start + s.minutes)}`
      : `${fmtTime(s.start)}–${fmtTime(s.start + s.minutes)} · ${fmtDur(s.minutes)}`;
  }

  setInterval(() => wins.forEach(w => { if (w.mode === 'open') w.updateNowLine(); }), 30 * 1000);

  // ───────── 스택 끌기: 이동, 시간 조절, 폭 조절 ─────────
  // 마우스는 바로 끌 수 있다. 터치는 길게 눌러서 집어 든다(그냥 밀면 스크롤).
  // 손잡이(위·아래·왼쪽·오른쪽)는 터치든 마우스든 바로 끈다.
  let gesture = null;

  function startGesture(w, e) {
    if (e.button !== 0 || gesture) return;
    const node = e.target.closest('.stack');
    if (!node) return;
    const s = Store.getDay(w.key).stacks.find(x => x.id === node.dataset.id);
    if (!s) return;
    let handle = e.target.closest('.sh');
    if (handle && s.period) handle = null; // 교시 스택은 길이·폭이 고정
    gesture = {
      w, node, orig: s, cur: { ...s },
      sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY,
      scroll0: w.scroll.scrollTop,
      type: e.pointerType, active: false, moved: false, timer: null, raf: 0,
    };
    if (handle) {
      e.preventDefault();
      begin(handle.dataset.h);
    } else if (e.pointerType !== 'mouse') {
      gesture.timer = setTimeout(() => begin('move'), 320);
    }
    addEventListener('pointermove', onGestureMove);
    addEventListener('pointerup', onGestureEnd);
    addEventListener('pointercancel', onGestureCancel);
  }

  // 집어 든 동안에는 터치 스크롤을 막는다
  document.addEventListener('touchmove', e => {
    if ((gesture && gesture.active) || (tdrag && tdrag.active)) e.preventDefault();
  }, { passive: false });

  function begin(mode) {
    const g = gesture;
    if (!g) return;
    clearTimeout(g.timer);
    g.active = true;
    g.mode = mode;
    g.node.classList.add('live');
    if (mode === 'move') g.node.classList.add('lifted');
    else g.lim = Placement.limits(Store.getDay(g.w.key).stacks, g.orig, periodsOf(g.w.key));
    g.w.select(g.orig.id);
    document.body.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    if (g.type !== 'mouse' && navigator.vibrate) navigator.vibrate(8);
    updateTip();
    g.w.tip.hidden = false;
    g.raf = requestAnimationFrame(autoScroll);
  }

  function onGestureMove(e) {
    const g = gesture;
    if (!g) return;
    g.lx = e.clientX;
    g.ly = e.clientY;
    const dist = Math.hypot(e.clientX - g.sx, e.clientY - g.sy);
    if (!g.active) {
      if (dist > (g.type === 'mouse' ? 4 : 8)) {
        g.moved = true;
        if (g.type === 'mouse') begin('move');
        else { cleanupGesture(); return; } // 터치로 그냥 민 것은 스크롤
      } else return;
    }
    e.preventDefault();
    computeGesture();
  }

  function snap(v, step) { return Math.round(v / step) * step; }

  function computeGesture() {
    const g = gesture;
    const o = g.orig;
    const dyMin = (g.ly - g.sy + g.w.scroll.scrollTop - g.scroll0) / PPM;
    const dx = (g.lx - g.sx) / g.w.stacks.clientWidth;
    const end = o.start + o.minutes;
    const c = { ...o };
    switch (g.mode) {
      case 'move':
        c.start = clamp(snap(o.start + dyMin, SNAP_MIN), 0, DAY_MIN - SNAP_MIN);
        c.x = clamp(snap(o.x + dx, SNAP_X), 0, 1 - o.w);
        break;
      // 손잡이로 늘리고 줄일 때는 옆 스택·교시를 넘지 못한다
      case 't':
        c.start = clamp(snap(o.start + dyMin, SNAP_MIN), g.lim.minStart, end - SNAP_MIN);
        c.minutes = end - c.start;
        break;
      case 'b':
        c.minutes = clamp(snap(o.minutes + dyMin, SNAP_MIN), SNAP_MIN, g.lim.maxEnd - o.start);
        break;
      case 'l':
        c.x = clamp(snap(o.x + dx, SNAP_X), g.lim.minX, o.x + o.w - MIN_W);
        c.w = o.x + o.w - c.x;
        break;
      case 'r':
        c.w = clamp(snap(o.w + dx, SNAP_X), MIN_W, g.lim.maxR - o.x);
        break;
    }
    c.x = +c.x.toFixed(4);
    c.w = +c.w.toFixed(4);
    g.cur = c;
    placeStack(g.node, c);
    // 옮기는 중에는 실제로 놓일 자리를 점선으로 보여 준다
    if (g.mode === 'move') {
      g.res = tryPlace(g.w.key, c);
      const at = g.res.ok ? g.res.placed : c;
      const same = g.res.ok && at.start === c.start && at.minutes === c.minutes && at.x === c.x;
      g.w.showDropPreview(same ? null : at, c.color, g.res.ok ? placeHint(g.res) : g.res.note, !g.res.ok);
    }
    updateTip();
  }

  function updateTip() {
    const g = gesture;
    const c = g.cur;
    if (g.mode === 'l' || g.mode === 'r') g.w.tip.textContent = `폭 ${Math.round(c.w * 100)}%`;
    else if (g.mode === 'move' && g.res) g.w.tip.textContent = g.res.ok ? placeHint(g.res) : g.res.note;
    else g.w.tip.textContent = `${fmtTime(c.start)} – ${fmtTime(c.start + c.minutes)} · ${fmtDur(c.minutes)}`;
  }

  // 위·아래 가장자리 근처에서는 저절로 스크롤
  function autoScroll() {
    const g = gesture;
    if (!g || !g.active) return;
    if (g.mode !== 'l' && g.mode !== 'r') {
      const sc = g.w.scroll;
      const r = sc.getBoundingClientRect();
      const edge = 48;
      let v = 0;
      if (g.ly < r.top + edge) v = -Math.ceil((r.top + edge - g.ly) / 4);
      else if (g.ly > r.bottom - edge) v = Math.ceil((g.ly - (r.bottom - edge)) / 4);
      if (v) {
        const before = sc.scrollTop;
        sc.scrollTop += v;
        if (sc.scrollTop !== before) computeGesture();
      }
    }
    g.raf = requestAnimationFrame(autoScroll);
  }

  function cleanupGesture() {
    const g = gesture;
    if (!g) return;
    clearTimeout(g.timer);
    cancelAnimationFrame(g.raf);
    g.node.classList.remove('live', 'lifted');
    document.body.classList.remove('dragging', 'resizing');
    g.w.tip.hidden = true;
    g.w.showDropPreview(null);
    removeEventListener('pointermove', onGestureMove);
    removeEventListener('pointerup', onGestureEnd);
    removeEventListener('pointercancel', onGestureCancel);
    gesture = null;
  }

  function onGestureEnd() {
    const g = gesture;
    if (!g) return;
    if (g.active) {
      const c = g.cur;
      const o = g.orig;
      cleanupGesture();
      if (c.start === o.start && c.minutes === o.minutes && c.x === o.x && c.w === o.w) return;
      if (g.mode !== 'move') {
        Store.updateDay(g.w.key, day => {
          const s = day.stacks.find(x => x.id === c.id);
          if (s) Object.assign(s, { start: c.start, minutes: c.minutes, x: c.x, w: c.w });
        });
        return;
      }
      const res = tryPlace(g.w.key, c);
      if (!res.ok) {
        placeStack(g.node, o); // 제자리로
        toast(res.note);
        return;
      }
      commitPlace(g.w, res);
      if (res.kind === 'split' || res.kind === 'period') toast(res.note);
      return;
    }
    const id = g.orig.id;
    const moved = g.moved;
    cleanupGesture();
    if (!moved) openSheet(g.w, { id }); // 짧게 누르면 편집
  }

  function onGestureCancel() {
    const g = gesture;
    if (!g) return;
    if (g.active) placeStack(g.node, g.orig);
    cleanupGesture();
  }

  // ───────── 휠 피커 ─────────
  const ITEM_H = 36;

  function makeWheel(root, values, fmt, onChange) {
    root.tabIndex = 0;
    root.append(el('div', 'wheel-pad'));
    const items = values.map((v, i) => {
      const it = el('div', 'wheel-item', fmt(v));
      it.dataset.i = i;
      root.append(it);
      return it;
    });
    root.append(el('div', 'wheel-pad'));
    root.style.perspective = '500px';
    let index = 0;
    let painting = false;
    let suppressClick = false;

    function paint() {
      painting = false;
      const st = root.scrollTop;
      items.forEach((it, i) => {
        const d = clamp((i * ITEM_H - st) / ITEM_H, -3, 3);
        it.style.transform = `rotateX(${-d * 22}deg) scale(${1 - Math.abs(d) * 0.05})`;
        it.classList.toggle('on', Math.abs(d) < 0.5);
      });
    }
    root.addEventListener('scroll', () => {
      if (!painting) { painting = true; requestAnimationFrame(paint); }
      const i = clamp(Math.round(root.scrollTop / ITEM_H), 0, values.length - 1);
      if (i !== index) { index = i; onChange(); }
    }, { passive: true });

    function setIndex(i, smooth) {
      index = clamp(i, 0, values.length - 1);
      root.scrollTo({ top: index * ITEM_H, behavior: smooth ? 'smooth' : 'instant' });
      paint();
    }

    // 마우스로 위아래로 끌기
    root.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      e.preventDefault();
      root.focus({ preventScroll: true });
      const sy = e.clientY, st = root.scrollTop;
      let moved = false;
      suppressClick = false;
      root.classList.add('grabbing');
      const move = ev => {
        if (Math.abs(ev.clientY - sy) > 3) moved = true;
        root.scrollTop = st - (ev.clientY - sy);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        root.classList.remove('grabbing');
        // 끄는 동안 항목이 손가락을 따라오므로, 놓을 때 생기는 click은 무시한다
        suppressClick = moved;
        if (!moved) return;
        setIndex(Math.round(root.scrollTop / ITEM_H), true);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    // 터치로 항목을 톡 누르면 그 값으로
    root.addEventListener('click', e => {
      if (suppressClick) { suppressClick = false; return; }
      const hit = e.target.closest('.wheel-item');
      if (hit) setIndex(+hit.dataset.i, true);
    });
    root.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(index - 1, true); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(index + 1, true); }
    });

    return {
      get value() { return values[index]; },
      set(v) {
        let best = 0;
        values.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(values[best] - v)) best = i; });
        setIndex(best, false);
      },
    };
  }

  const range = (n, step = 1) => Array.from({ length: n }, (_, i) => i * step);
  const wheels = {};
  const onWheel = () => syncSheet();
  wheels.sh = makeWheel($('start-h'), range(24), pad, onWheel);
  wheels.sm = makeWheel($('start-m'), range(12, 5), pad, onWheel);
  wheels.dh = makeWheel($('dur-h'), range(24), String, onWheel);
  wheels.dm = makeWheel($('dur-m'), range(12, 5), String, onWheel);

  // ───────── 스택 입력 시트 ─────────
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  const nameInput = $('stack-name');
  const colorsEl = $('colors');
  const deleteBtn = $('delete-stack');

  let sheetWin = null;  // 시트가 고치는 창
  let editingId = null;
  let draftColor = COLORS[0];
  let draftTaskId = null;
  let deleteArmed = false;

  COLORS.forEach(c => {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `색상 ${c}`);
    colorsEl.append(b);
  });

  const draftStart = () => wheels.sh.value * 60 + wheels.sm.value;
  const draftMinutes = () => wheels.dh.value * 60 + wheels.dm.value;

  function syncSheet() {
    colorsEl.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-checked', String(b.dataset.color === draftColor)));
    const m = draftMinutes();
    $('sheet-range').textContent = m
      ? `${fmtTime(draftStart())} – ${fmtTime(draftStart() + m)} · ${fmtDur(m)}`
      : '걸리는 시간을 정한다';
    $('sheet-save').disabled = !nameInput.value.trim() || !m;
  }

  // opts: { id }는 편집, 아니면 새 스택. 새 스택은 start·name·minutes·color·taskId를 미리 채울 수 있다
  function openSheet(w, opts) {
    if (!w || !sheet.hidden) return;
    const day = Store.getDay(w.key);
    sheetWin = w;
    editingId = opts.id || null;
    draftTaskId = null;
    deleteArmed = false;
    deleteBtn.textContent = '스택 삭제';
    let st, mins;

    if (editingId) {
      const s = day.stacks.find(x => x.id === editingId);
      if (!s) return;
      nameInput.value = s.name;
      st = s.start;
      mins = s.minutes;
      draftColor = s.color;
      $('sheet-title').textContent = '스택 편집';
      $('sheet-save').textContent = '완료';
    } else {
      nameInput.value = opts.name || '';
      mins = opts.minutes || 60;
      draftTaskId = opts.taskId || null;
      if (opts.start != null) st = opts.start;
      else if (day.stacks.length) st = Math.min(DAY_MIN - 15, Math.max(...day.stacks.map(s => s.start + s.minutes)));
      else if (w.key === keyOf(new Date())) {
        const n = new Date();
        st = Math.min(DAY_MIN - 15, Math.ceil((n.getHours() * 60 + n.getMinutes()) / 15) * 15);
      } else st = Store.DEFAULT_START;
      // 직전 스택과 다른 색을 기본으로
      const last = day.stacks[day.stacks.length - 1];
      draftColor = opts.color || (last ? COLORS[(COLORS.indexOf(last.color) + 1) % COLORS.length] : COLORS[0]);
      $('sheet-title').textContent = opts.taskId ? '할 일을 시간표에' : '새 스택';
      $('sheet-save').textContent = '추가';
    }
    $('edit-actions').hidden = !editingId;

    backdrop.hidden = false;
    sheet.hidden = false;
    // 화면에 보인 뒤에 휠 위치를 맞춰야 스크롤 값이 먹는다
    wheels.sh.set(Math.floor(st / 60) % 24);
    wheels.sm.set(st % 60);
    wheels.dh.set(Math.floor(mins / 60));
    wheels.dm.set(mins % 60);
    syncSheet();

    const centered = matchMedia('(min-width: 640px)').matches;
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: 'ease-out' });
    sheet.animate(
      centered
        ? [{ transform: 'translateY(-50%) scale(0.9)', opacity: 0 }, { transform: 'translateY(-50%)', opacity: 1 }]
        : [{ transform: 'translateY(100%)' }, { transform: 'none' }],
      motion(centered ? SPRING_BOUNCY : SPRING_SMOOTH)
    );
    if (!editingId && !opts.name) setTimeout(() => nameInput.focus({ preventScroll: true }), centered ? 0 : 80);
  }

  function hideSheetNow() {
    sheet.hidden = true;
    backdrop.hidden = true;
    sheet.style.transform = '';
    sheet.getAnimations().forEach(x => x.cancel());
    backdrop.getAnimations().forEach(x => x.cancel());
  }

  function closeSheet(immediate) {
    if (sheet.hidden) return;
    nameInput.blur();
    if (immediate) { hideSheetNow(); return; }
    const centered = matchMedia('(min-width: 640px)').matches;
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    sheet.animate(
      centered
        ? [{ transform: 'translateY(-50%)', opacity: 1 }, { transform: 'translateY(-50%) scale(0.94)', opacity: 0 }]
        : [{ transform: 'none' }, { transform: 'translateY(100%)' }],
      { duration: centered ? 180 : 280, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }
    ).finished.then(hideSheetNow);
  }

  nameInput.addEventListener('input', syncSheet);
  colorsEl.addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    draftColor = b.dataset.color;
    syncSheet();
  });

  sheet.addEventListener('submit', e => {
    e.preventDefault();
    const w = sheetWin;
    const name = nameInput.value.trim();
    const minutes = draftMinutes();
    if (!name || !minutes || !w || w.mode === 'closed') return;
    const start = draftStart();
    const color = draftColor;
    const old = editingId && Store.getDay(w.key).stacks.find(x => x.id === editingId);
    let cand;
    if (old) {
      cand = { ...old, name, color, start, minutes };
      if (minutes !== old.minutes) delete cand.baseMinutes; // 길이를 직접 바꾸면 그 길이를 원래 길이로
    } else {
      cand = { id: Store.newId(), name, color, start, minutes, x: 0, w: 1 };
      if (draftTaskId) cand.taskId = draftTaskId;
    }
    const moved = !old || start !== old.start || minutes !== old.minutes;
    if (moved) {
      const res = tryPlace(w.key, cand);
      if (!res.ok) { toast(res.note); return; } // 시트는 열어 둔다
      // 나뉜 스택은 이름·색을 조각 모두에 맞춘다
      if (old && old.group) res.stacks.forEach(x => { if (x.group === old.group) Object.assign(x, { name, color }); });
      commitPlace(w, res);
      if (res.note) toast(res.note);
    } else {
      Store.updateDay(w.key, day => {
        day.stacks.forEach(x => { if (x.id === old.id || (old.group && x.group === old.group)) Object.assign(x, { name, color }); });
      });
    }
    closeSheet();
    const id = cand.id;
    requestAnimationFrame(() => w.scrollToStack(id));
  });

  deleteBtn.addEventListener('click', () => {
    if (!deleteArmed) {
      deleteArmed = true;
      deleteBtn.textContent = '한 번 더 누르면 삭제';
      return;
    }
    const w = sheetWin;
    const id = editingId;
    const node = w.stacks.querySelector(`.stack[data-id="${id}"]`);
    closeSheet();
    if (w.selectedId === id) w.selectedId = null;
    const done = () => Store.updateDay(w.key, day => {
      day.stacks = Placement.tidy(day.stacks.filter(x => x.id !== id), periodsOf(w.key));
    });
    if (node) {
      node.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.85)', opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
        .finished.then(done);
    } else {
      done();
    }
  });

  $('sheet-cancel').addEventListener('click', () => closeSheet());
  backdrop.addEventListener('click', () => closeSheet());

  // 폰에서 시트 위쪽을 아래로 끌어서 닫기
  let sheetDrag = null;
  sheet.addEventListener('touchstart', e => {
    if (matchMedia('(min-width: 640px)').matches) return;
    if (sheet.scrollTop > 0 || e.target.closest('input, .wheel, .colors, button')) return;
    sheetDrag = { y: e.touches[0].clientY, dy: 0 };
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!sheetDrag) return;
    sheetDrag.dy = Math.max(0, e.touches[0].clientY - sheetDrag.y);
    sheet.getAnimations().forEach(a => a.cancel());
    sheet.style.transform = `translateY(${sheetDrag.dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!sheetDrag) return;
    const { dy } = sheetDrag;
    sheetDrag = null;
    sheet.style.transform = '';
    if (dy > 110) {
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(100%)' }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(hideSheetNow);
    } else if (dy > 0) {
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], motion(SPRING_BOUNCY));
    }
  });

  // ───────── 설정 ─────────
  const settingsEl = $('settings');
  const settingsBtn = $('settings-btn');
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let theme = ui.theme || 'system';          // 'system' | 'light' | 'dark'
  let weatherMode = !!ui.weatherMode;
  let weatherPreview = ui.weatherPreview || 'auto';

  const isDark = () => theme === 'dark' || (theme === 'system' && darkQuery.matches);
  function applyTheme() {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    applySky(); // 물방울 색이 바탕에 따라 다르다
  }

  // 날씨 코드(WMO) → 배경 종류와 세기
  function skyKind() {
    if (weatherPreview !== 'auto') return { kind: weatherPreview, intensity: 1, night: false };
    const w = Weather.get();
    if (w.status !== 'ok') return { kind: 'clear', intensity: 1, night: false };
    const c = w.current.code;
    const night = !w.current.isDay;
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95) {
      const heavy = [55, 65, 67, 82, 95, 96, 99].includes(c), light = [51, 56, 61, 80].includes(c);
      return { kind: 'rain', intensity: heavy ? 1.7 : light ? 0.6 : 1, night };
    }
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { kind: 'snow', intensity: [75, 86].includes(c) ? 1.6 : 1, night };
    if (c === 2 || c === 3 || c === 45 || c === 48) return { kind: 'cloud', intensity: 1, night };
    return { kind: 'clear', intensity: 1, night };
  }
  function applySky() {
    if (!weatherMode) { Sky.set(null); return; }
    const k = skyKind();
    Sky.set(k.kind, { intensity: k.intensity, night: k.night, dark: isDark() });
  }

  // 빗방울이 부딪치는 칸들. 위층(시간표 창)이 앞에 오도록 층 번호를 매긴다
  Sky.setTargets(() => {
    const rects = [];
    const push = (elm, layer) => {
      const r = elm.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) return;
      rects.push({ el: elm, l: r.left, t: r.top, r: r.right, b: r.bottom, layer });
    };
    if (calendarEl.offsetParent) {
      grid.querySelectorAll('.cell:not(.outside)').forEach(c => push(c, 1));
      calendarEl.querySelectorAll('.segmented, #today-btn').forEach(c => push(c, 1));
    }
    if (tasksPane.offsetParent) push(tasksPane, 1);
    wins.forEach((w, i) => { if (w.mode === 'open' && !w.root.hidden) push(w.root, 2 + i); });
    rects.sort((a, b) => b.layer - a.layer);
    return { rects, top: document.querySelector('.topbar').getBoundingClientRect().bottom };
  });

  function syncSettings() {
    $('theme-seg').querySelectorAll('[data-v]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === theme)));
    $('wx-mode').checked = weatherMode;
    $('wx-preview-row').hidden = !weatherMode;
    $('wx-preview').querySelectorAll('[data-v]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === weatherPreview)));
  }

  function setSettingsOpen(open) {
    if (open === !settingsEl.hidden && !settingsEl.getAnimations().length) return;
    settingsBtn.setAttribute('aria-expanded', String(open));
    settingsEl.getAnimations().forEach(a => a.cancel());
    if (open) {
      settingsEl.hidden = false;
      syncSettings();
      settingsEl.animate([{ opacity: 0, transform: 'translateY(-8px) scale(0.96)' }, { opacity: 1, transform: 'none' }], motion(SPRING_BOUNCY));
    } else {
      const a = settingsEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(0.97)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      a.onfinish = () => { settingsEl.hidden = true; a.cancel(); };
    }
  }
  settingsBtn.addEventListener('click', () => setSettingsOpen(settingsBtn.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('pointerdown', e => {
    if (!settingsEl.hidden && !e.target.closest('#settings, #settings-btn')) setSettingsOpen(false);
  });
  $('theme-seg').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    theme = b.dataset.v;
    Store.setUI({ theme });
    applyTheme();
    syncSettings();
  });
  $('wx-mode').addEventListener('change', e => {
    weatherMode = e.target.checked;
    Store.setUI({ weatherMode });
    applySky();
    syncSettings();
  });
  $('wx-preview').addEventListener('click', e => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    weatherPreview = b.dataset.v;
    Store.setUI({ weatherPreview });
    applySky();
    syncSettings();
  });
  darkQuery.addEventListener('change', applySky);
  Weather.subscribe(applySky);

  // ───────── 키보드 ─────────
  // 창 관련 키는 맨 앞 창에 적용한다
  document.addEventListener('keydown', e => {
    const w = activeWin();
    if (e.key === 'Escape') {
      if (!settingsEl.hidden) setSettingsOpen(false);
      else if (!sheet.hidden) closeSheet();
      else if (w && w.selectedId) w.select(null);
      else if (w) w.close();
      return;
    }
    if (e.target.closest('input, .wheel, .splitter')) return;
    if (!sheet.hidden) return;
    if (e.key === 't' || e.key === 'T') { goToday(); return; }
    if (w) {
      if (e.key === 'ArrowLeft') w.goDay(-1);
      if (e.key === 'ArrowRight') w.goDay(1);
      if (e.key === 'n' || e.key === '+') { e.preventDefault(); openSheet(w, {}); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && w.selectedId) openSheet(w, { id: w.selectedId });
    } else if (!e.target.closest('.cell')) {
      if (e.key === 'ArrowLeft') shiftMonth(-1);
      if (e.key === 'ArrowRight') shiftMonth(1);
    }
  });

  // 데이터가 바뀌면 화면 갱신
  const renderWins = () => wins.forEach(w => w.render());
  School.subscribe(() => {
    renderMonth();
    renderWins();
  });
  Store.subscribe(() => {
    renderMonth();
    renderTasks(); // 이번 주 할 일의 '시간표에 올림' 표시
    renderWins();
  });
  [Google, Microsoft].forEach(p => p.subscribe(() => {
    renderAccounts();
    if (!Sources.all().length) renderTasks();
  }));
  Sources.subscribe(() => {
    renderMonth();
    renderTasks();
    renderWins();
  });

  // 자정이 지나거나 시간이 흐르면 표시를 다시 그린다
  let lastToday = keyOf(new Date());
  setInterval(() => {
    const k = keyOf(new Date());
    if (k !== lastToday) { lastToday = k; renderMonth(); renderWins(); }
    renderTasks();
  }, 60 * 1000);

  tickClock();
  applyTheme();
  renderWeather();
  renderMonth();
  renderTasks();
  renderAccounts();
})();
