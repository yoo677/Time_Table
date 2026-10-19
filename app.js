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
    classroom: { label: 'Classroom', color: 'var(--src-classroom)' },
    tasks: { label: 'Tasks', color: 'var(--src-tasks)' },
    teams: { label: 'Teams', color: 'var(--src-teams)' },
  };
  const DAY_MIN = 24 * 60;
  const SNAP_MIN = 5;      // 세로 이동·길이 조절 단위(분)
  const SNAP_X = 1 / 24;   // 가로 이동·폭 조절 단위(전체 폭 대비)
  const MIN_W = 1 / 6;     // 스택 최소 폭

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
  const motion = s => REDUCED.matches ? { duration: 1, easing: 'linear' } : s;

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
  let openKey = null;      // 창에 띄운 날짜
  let winMode = 'closed';  // 'closed' | 'open' | 'min'
  let animating = false;
  let selectedId = null;   // 손잡이가 보이는 스택
  let pendingHighlight = null;

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

  // ───────── 달력 ─────────
  const grid = $('grid');

  function renderMonth() {
    $('cal-year').textContent = `${viewMonth.getFullYear()}년`;
    $('month-label').textContent = `${viewMonth.getMonth() + 1}월`;

    const first = addDays(viewMonth, -viewMonth.getDay());
    const todayKey = keyOf(new Date());
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
      if (key === openKey && winMode !== 'closed') cell.classList.add('open');

      const stacks = Store.getDay(key).stacks.sort((a, b) => a.start - b.start);
      const dues = deadlinesOn(key);
      let label = `${d.getMonth() + 1}월 ${d.getDate()}일`;
      if (stacks.length) label += `, 스택 ${stacks.length}개`;
      if (dues.length) label += `, 마감 ${dues.length}개`;
      cell.setAttribute('aria-label', label);

      cell.append(el('span', 'num', d.getDate()));

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

  function slideGrid(dir) {
    grid.animate(
      [{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      motion(SPRING_SMOOTH)
    );
  }
  function shiftMonth(delta) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
    renderMonth();
    slideGrid(delta);
  }

  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('month-label').addEventListener('click', () => {
    const t = new Date();
    const delta = (t.getFullYear() - viewMonth.getFullYear()) * 12 + t.getMonth() - viewMonth.getMonth();
    if (delta) {
      viewMonth = new Date(t.getFullYear(), t.getMonth(), 1);
      renderMonth();
      slideGrid(Math.sign(delta));
    }
    grid.querySelector('.cell.today')?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
      { duration: 420, easing: 'ease-out' }
    );
  });

  grid.addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (cell) openDay(cell.dataset.key, cell);
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

  // ───────── 할 일 패널 ─────────
  const taskList = $('task-list');
  const accountsEl = $('accounts');

  function timeAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
  }

  function renderAccounts() {
    const frag = document.createDocumentFragment();
    const icons = {
      'google-personal': ['G', '#4285f4'],
      'google-school': ['G', '#34a853'],
      'microsoft-school': ['T', '#5b5fc7'],
    };
    const rows = [
      ...Google.status(),
      { id: 'microsoft-school', label: 'Microsoft 학교 계정', services: ['Teams 과제'], soon: true },
    ];
    rows.forEach(acc => {
      const row = el('div', 'account');
      const icon = el('span', 'account-icon', icons[acc.id][0]);
      icon.style.background = icons[acc.id][1];
      const text = el('div', 'account-text');
      let sub;
      if (acc.soon) sub = `${acc.services.join(' · ')} · 준비 중`;
      else if (acc.busy) sub = '불러오는 중…';
      else if (acc.connected) {
        sub = acc.email || '연결됨';
        if (acc.expired) sub += ' · 로그인 만료';
        else if (acc.lastSync) sub += ` · ${timeAgo(acc.lastSync)} 갱신`;
      } else sub = `${acc.services.join(' · ')} · 연결 안 됨`;
      text.append(el('div', 'account-name', acc.label), el('div', 'account-sub', sub));
      if (acc.error) text.append(el('div', 'account-error', acc.error));

      const actions = el('div', 'account-actions');
      if (acc.soon) {
        const b = el('button', 'pill-btn ghost', '연결');
        b.type = 'button';
        b.disabled = true;
        actions.append(b);
      } else {
        const main = el('button', `pill-btn${acc.connected ? ' ghost' : ''}`, acc.connected ? '새로고침' : '연결');
        main.type = 'button';
        main.disabled = acc.busy;
        main.addEventListener('click', () => {
          if (!Google.configured) {
            toast('config.js에 구글 클라이언트 ID를 아직 넣지 않았다.');
            return;
          }
          Google.connect(acc.id);
        });
        actions.append(main);
        if (acc.connected) {
          const off = el('button', 'link-btn', '연결 해제');
          off.type = 'button';
          off.addEventListener('click', () => Google.disconnect(acc.id));
          actions.append(off);
        }
      }
      row.append(icon, text, actions);
      frag.append(row);
    });
    accountsEl.replaceChildren(frag);
  }

  $('accounts-btn').addEventListener('click', e => {
    const open = accountsEl.hidden;
    accountsEl.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) accountsEl.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], motion(SPRING_SMOOTH));
  });

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

  function renderTasks() {
    const items = Sources.all().filter(it => !it.done);
    const now = new Date();
    const frag = document.createDocumentFragment();

    if (Sources.isDemo()) {
      const note = el('div', 'demo-note');
      note.append(el('span', null, '예시 데이터를 보여 주는 중'));
      const off = el('button', null, '끄기');
      off.type = 'button';
      off.addEventListener('click', () => { Sources.setDemo(false); Store.setUI({ demo: false }); });
      note.append(off);
      frag.append(note);
    }

    if (!items.length) {
      const empty = el('div', 'empty');
      const anyConnected = Google.status().some(a => a.connected);
      if (anyConnected) {
        empty.append(el('strong', null, '남은 마감이 없다'));
        empty.append(document.createTextNode('연결된 계정에서 아직 제출하지 않은 과제와 할 일을 찾지 못했다.'));
      } else {
        empty.append(el('strong', null, '연결된 계정이 없다'));
        empty.append(document.createTextNode('오른쪽 위 사람 모양 버튼에서 계정을 연결하면 마감이 가까운 순서로 여기에 모인다.'));
        empty.append(el('br'));
        const b = el('button', 'pill-btn', '예시로 미리 보기');
        b.type = 'button';
        b.addEventListener('click', () => { Sources.setDemo(true); Store.setUI({ demo: true }); });
        empty.append(b);
      }
      frag.append(empty);
      taskList.replaceChildren(frag);
      return;
    }

    // 기한(시각까지)이 가까운 순서. 날짜만 있는 항목은 그날 끝으로 본다. 기한 없는 항목은 맨 아래
    const withDue = items.map(it => {
      let t = null;
      if (it.due) {
        const d = new Date(it.due);
        t = it.hasTime ? d : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
      }
      return { it, t };
    }).sort((a, b) => (a.t ? a.t.getTime() : Infinity) - (b.t ? b.t.getTime() : Infinity));

    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const tomorrowEnd = addDays(todayEnd, 1);
    const weekEnd = addDays(todayEnd, 7);
    const groupOf = t => {
      if (!t) return '기한 없음';
      if (t < now) return '지난 마감';
      if (t <= todayEnd) return '오늘';
      if (t <= tomorrowEnd) return '내일';
      if (t <= weekEnd) return '7일 안';
      return '나중에';
    };

    let current = null;
    withDue.forEach(({ it, t }) => {
      const g = groupOf(t);
      if (g !== current) {
        current = g;
        frag.append(el('h3', `task-group${g === '지난 마감' ? ' overdue' : ''}`, g));
      }
      const src = SOURCE_INFO[it.source];
      const row = el('div', 'task');
      row.style.setProperty('--c', src.color);
      if (t && t < now) row.classList.add('overdue');
      else if (t && t - now < 24 * 3600 * 1000) row.classList.add('soon');

      const main = el('div', 'task-main');
      main.append(el('div', 'task-title', it.title));
      const meta = el('div', 'task-meta');
      const badge = el('span', 'badge', src.label + (it.account === 'school' ? ' · 학교' : ''));
      meta.append(badge);
      if (it.course) meta.append(el('span', null, it.course));
      main.append(meta);

      const due = el('div', 'task-due');
      if (t) {
        due.append(el('strong', null, relLabel(t - now, !it.hasTime)));
        due.append(document.createTextNode(dueLabel(new Date(it.due), it.hasTime)));
      }
      if (it.source === 'tasks' && it.ref) {
        // 구글 Tasks 항목은 여기서 완료 처리할 수 있다
        const check = el('button', 'task-check');
        check.type = 'button';
        check.setAttribute('aria-label', `${it.title} 완료`);
        check.addEventListener('click', async ev => {
          ev.stopPropagation();
          check.classList.add('on');
          try {
            await Google.completeTask(it);
          } catch (err) {
            check.classList.remove('on');
            toast(err.message);
          }
        });
        row.append(check);
      } else {
        row.append(el('span', 'task-bar'));
      }
      row.append(main, due);
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
      if (it.due) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          const d = new Date(it.due);
          const key = keyOf(d);
          if (d.getFullYear() !== viewMonth.getFullYear() || d.getMonth() !== viewMonth.getMonth()) {
            viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
            renderMonth();
          }
          const cell = grid.querySelector(`.cell[data-key="${key}"]`);
          openDay(key, cell || row, it.hasTime ? dueInfo(it).min : null);
        });
      }
      frag.append(row);
    });
    taskList.replaceChildren(frag);
  }

  // ───────── 하루 시간표 창 ─────────
  const win = $('win');
  const dock = $('dock');

  function defaultRect() {
    const vw = innerWidth, vh = innerHeight;
    if (vw < 640) return { x: 8, y: 8, w: vw - 16, h: vh - 92 };
    const w = Math.min(560, vw - 40);
    const h = Math.min(760, vh - 48);
    return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
  }
  let rect = ui.win || defaultRect();

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
  function applyRect() {
    rect = clampRect(rect);
    win.style.left = `${rect.x}px`;
    win.style.top = `${rect.y}px`;
    win.style.width = `${rect.w}px`;
    win.style.height = `${rect.h}px`;
  }
  addEventListener('resize', () => {
    if (winMode === 'open') applyRect();
    requestAnimationFrame(trimMiniChips);
  });

  // a에서 b로 가는 transform(transform-origin 0 0 기준)
  function flip(from, to) {
    return `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  }

  function zoomIn(fromRect) {
    const to = win.getBoundingClientRect();
    const m = motion(SPRING_SMOOTH);
    animating = true;
    const a = win.animate([{ transform: flip(fromRect, to), opacity: 0.6 }, { transform: 'none', opacity: 1 }], m);
    [...win.children].forEach(c => c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], m));
    return a.finished.finally(() => { animating = false; });
  }

  function zoomOut(toRect) {
    const from = win.getBoundingClientRect();
    animating = true;
    const opts = { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' };
    const frames = toRect
      ? [{ transform: 'none', opacity: 1 }, { transform: flip(toRect, from), opacity: 0.2 }]
      : [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.92)', opacity: 0 }];
    if (!toRect) win.style.transformOrigin = '50% 50%';
    [...win.children].forEach(c => c.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], opts));
    return win.animate(frames, REDUCED.matches ? { duration: 1, fill: 'forwards' } : opts).finished.finally(() => {
      win.hidden = true;
      win.style.transformOrigin = '';
      win.getAnimations({ subtree: true }).forEach(an => an.cancel());
      animating = false;
    });
  }

  function markOpenCell() {
    grid.querySelectorAll('.cell.open').forEach(c => c.classList.remove('open'));
    if (winMode !== 'closed') grid.querySelector(`.cell[data-key="${openKey}"]`)?.classList.add('open');
  }

  function openDay(key, fromEl, focusMin) {
    if (animating) return;
    if (winMode === 'open') {
      // 이미 열린 창이면 날짜만 바꾼다
      if (key !== openKey) {
        const dir = key > openKey ? 1 : -1;
        openKey = key;
        selectedId = null;
        renderDay();
        scrollToFocus(focusMin);
        $('win-body').animate([{ transform: `translateX(${dir * 30}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], motion(SPRING_SMOOTH));
      } else if (focusMin != null) {
        scrollToFocus(focusMin, true);
      }
      win.classList.remove('focus-pulse');
      void win.offsetWidth;
      win.classList.add('focus-pulse');
      markOpenCell();
      return;
    }
    const from = winMode === 'min' ? $('dock-item').getBoundingClientRect() : fromEl.getBoundingClientRect();
    openKey = key;
    selectedId = null;
    winMode = 'open';
    dock.hidden = true;
    win.hidden = false;
    applyRect();
    renderDay();
    scrollToFocus(focusMin);
    markOpenCell();
    zoomIn(from);
  }

  function closeDay() {
    if (animating || winMode === 'closed') return;
    closeSheet(true);
    if (winMode === 'min') {
      dock.hidden = true;
      winMode = 'closed';
      markOpenCell();
      return;
    }
    const key = openKey;
    const d = parseKey(key);
    if (d.getFullYear() !== viewMonth.getFullYear() || d.getMonth() !== viewMonth.getMonth()) {
      viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      renderMonth();
    }
    winMode = 'closed';
    markOpenCell();
    const cell = appEl.dataset.tab === 'calendar' || innerWidth >= 900
      ? grid.querySelector(`.cell[data-key="${key}"]`)
      : null;
    const target = cell && cell.offsetParent ? cell.getBoundingClientRect() : null;
    zoomOut(target).then(() => { openKey = null; });
  }

  function minimizeDay() {
    if (animating || winMode !== 'open') return;
    closeSheet(true);
    const d = parseKey(openKey);
    $('dock-label').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 시간표`;
    dock.hidden = false;
    const target = $('dock-item').getBoundingClientRect();
    winMode = 'min';
    zoomOut(target);
    $('dock-item').animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { ...motion(SPRING_BOUNCY), delay: 120, fill: 'backwards' });
  }

  $('win-close').addEventListener('click', closeDay);
  $('win-min').addEventListener('click', minimizeDay);
  $('dock-item').addEventListener('click', () => openDay(openKey, $('dock-item')));

  function goDay(delta) {
    if (winMode !== 'open' || animating) return;
    openKey = keyOf(addDays(parseKey(openKey), delta));
    selectedId = null;
    const d = parseKey(openKey);
    if (d.getFullYear() !== viewMonth.getFullYear() || d.getMonth() !== viewMonth.getMonth()) {
      viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      renderMonth();
    }
    markOpenCell();
    renderDay();
    scrollToFocus(null);
    $('win-body').animate(
      [{ transform: `translateX(${delta * 30}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      motion(SPRING_SMOOTH)
    );
  }
  $('prev-day').addEventListener('click', () => goDay(-1));
  $('next-day').addEventListener('click', () => goDay(1));

  // 제목 줄을 잡고 창 옮기기
  $('win-titlebar').addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = rect.x, oy = rect.y;
    document.body.classList.add('dragging');
    const move = ev => {
      rect = { ...rect, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy };
      applyRect();
    };
    const up = () => {
      document.body.classList.remove('dragging');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      Store.setUI({ win: rect });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });

  // 가장자리·모서리를 잡고 창 크기 바꾸기
  win.querySelectorAll('.rz').forEach(h => h.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const dir = h.dataset.dir;
    const sx = e.clientX, sy = e.clientY, o = { ...rect };
    const minW = Math.min(300, innerWidth - 16), minH = Math.min(260, innerHeight - 16);
    document.body.classList.add('resizing');
    const move = ev => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      let { x, y, w, h: hh } = o;
      if (dir.includes('e')) w = o.w + dx;
      if (dir.includes('s')) hh = o.h + dy;
      if (dir.includes('w')) { w = clamp(o.w - dx, minW, o.x + o.w - 8); x = o.x + o.w - w; }
      if (dir.includes('n')) { hh = clamp(o.h - dy, minH, o.y + o.h); y = o.y + o.h - hh; }
      rect = { x, y, w: Math.max(minW, w), h: Math.max(minH, hh) };
      applyRect();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      Store.setUI({ win: rect });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  }));

  // ───────── 타임라인 그리기 ─────────
  const HOUR_PX = 64;
  const PPM = HOUR_PX / 60; // 1분당 픽셀
  const hoursEl = $('hours');
  const stacksEl = $('stacks');
  const deadlinesEl = $('deadlines');
  const scrollEl = $('timeline-scroll');
  const nowLine = $('now-line');

  function renderDay() {
    if (!openKey) return;
    const highlightId = pendingHighlight;
    pendingHighlight = null;
    const d = parseKey(openKey);
    const day = Store.getDay(openKey);
    const isToday = openKey === keyOf(new Date());

    const title = $('win-date');
    title.replaceChildren(document.createTextNode(`${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 `));
    const wd = el('span', d.getDay() === 0 ? 'sun' : null, WEEKDAYS[d.getDay()]);
    title.append(wd);
    if (isToday) title.append(document.createTextNode(' '), el('span', 'today', '오늘'));

    const dues = deadlinesOn(openKey);
    const total = day.stacks.reduce((sum, s) => sum + s.minutes, 0);
    const parts = [];
    if (day.stacks.length) parts.push(`스택 ${day.stacks.length}개 · 합계 ${fmtDur(total)}`);
    if (dues.length) parts.push(`마감 ${dues.length}개`);
    $('win-summary').textContent = parts.length ? parts.join(' · ') : '빈 곳을 누르거나 + 버튼으로 스택을 만든다';

    // 시간 눈금. 스택이 자정을 넘기면 그만큼 늘린다
    const lastEnd = day.stacks.reduce((m, s) => Math.max(m, s.start + s.minutes), 0);
    const endHour = Math.max(24, Math.ceil(lastEnd / 60));
    if (hoursEl.childElementCount !== endHour) {
      const frag = document.createDocumentFragment();
      for (let h = 0; h < endHour; h++) {
        const row = el('div', 'hour');
        row.append(el('span', null, h === 0 ? '' : `${pad(h % 24)}:00`));
        frag.append(row);
      }
      hoursEl.replaceChildren(frag);
    }

    // 기존 요소를 재사용해야 위치가 바뀔 때 부드럽게 움직인다
    const existing = new Map([...stacksEl.querySelectorAll('.stack')].map(n => [n.dataset.id, n]));
    stacksEl.querySelector('.empty-hint')?.remove();

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
      node.classList.toggle('selected', s.id === selectedId);
      node.querySelector('.stack-name').textContent = s.name;
      node.querySelector('.stack-card').setAttribute('aria-label', `${s.name}, ${fmtTime(s.start)}부터 ${fmtDur(s.minutes)}`);
      if (stacksEl.children[i] !== node) stacksEl.insertBefore(node, stacksEl.children[i] || null);
      if (isNew && s.id === highlightId) {
        node.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], motion(SPRING_BOUNCY));
      }
    });
    existing.forEach(n => n.remove());

    if (!day.stacks.length) {
      const hint = el('div', 'empty-hint', '빈 시간을 누르면 그 시각에 스택이 생긴다');
      hint.style.top = `${Store.DEFAULT_START * PPM + 4}px`;
      stacksEl.append(hint);
    }

    // 과제 마감선
    deadlinesEl.replaceChildren(...dues.map(({ it, info }) => {
      const line = el('div', 'deadline');
      line.style.top = `${info.min * PPM}px`;
      line.style.setProperty('--c', SOURCE_INFO[it.source].color);
      line.append(el('span', null, `마감 ${fmtTime(info.min)} · ${it.title}`));
      return line;
    }));

    updateNowLine();
  }

  function placeStack(node, s) {
    const h = s.minutes * PPM;
    node.style.top = `${s.start * PPM}px`;
    node.style.height = `${h}px`;
    node.style.left = `${s.x * 100}%`;
    node.style.width = `${s.w * 100}%`;
    node.style.setProperty('--c', s.color);
    node.classList.toggle('compact', h < 44);
    node.classList.toggle('tiny', h < 26);
    node.querySelector('.stack-time').textContent = `${fmtTime(s.start)}–${fmtTime(s.start + s.minutes)} · ${fmtDur(s.minutes)}`;
  }

  function updateNowLine() {
    const now = new Date();
    if (!openKey || openKey !== keyOf(now)) { nowLine.hidden = true; return; }
    nowLine.hidden = false;
    nowLine.style.top = `${(now.getHours() * 60 + now.getMinutes()) * PPM}px`;
  }
  setInterval(updateNowLine, 30 * 1000);

  // 처음 열 때 볼 위치: 지정한 시각, 오늘이면 지금, 아니면 첫 스택이나 08:00
  function scrollToFocus(min, smooth) {
    if (min == null) {
      const day = Store.getDay(openKey);
      if (openKey === keyOf(new Date())) {
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
    scrollEl.scrollTo({ top: Math.max(0, min * PPM), behavior: smooth ? 'smooth' : 'auto' });
  }

  function scrollToStack(id) {
    const node = stacksEl.querySelector(`.stack[data-id="${id}"]`);
    if (!node) return;
    const top = node.offsetTop, bottom = top + node.offsetHeight;
    const view = scrollEl.clientHeight;
    if (top < scrollEl.scrollTop + 10 || bottom > scrollEl.scrollTop + view - 80) {
      scrollEl.scrollTo({ top: Math.max(0, top - 60), behavior: 'smooth' });
    }
  }

  function select(id) {
    selectedId = id;
    stacksEl.querySelectorAll('.stack').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
  }

  // ───────── 스택 끌기: 이동, 시간 조절, 폭 조절 ─────────
  // 마우스는 바로 끌 수 있다. 터치는 길게 눌러서 집어 든다(그냥 밀면 스크롤).
  // 손잡이(위·아래·왼쪽·오른쪽)는 터치든 마우스든 바로 끈다.
  const tip = $('drag-tip');
  let gesture = null;

  stacksEl.addEventListener('contextmenu', e => { if (e.target.closest('.stack')) e.preventDefault(); });

  stacksEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || gesture) return;
    const node = e.target.closest('.stack');
    if (!node) return;
    const s = Store.getDay(openKey).stacks.find(x => x.id === node.dataset.id);
    if (!s) return;
    const handle = e.target.closest('.sh');
    gesture = {
      node, orig: s, cur: { ...s },
      sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY,
      scroll0: scrollEl.scrollTop,
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
  });

  // 집어 든 동안에는 터치 스크롤을 막는다
  document.addEventListener('touchmove', e => { if (gesture && gesture.active) e.preventDefault(); }, { passive: false });

  function begin(mode) {
    const g = gesture;
    if (!g) return;
    clearTimeout(g.timer);
    g.active = true;
    g.mode = mode;
    g.node.classList.add('live');
    if (mode === 'move') g.node.classList.add('lifted');
    select(g.orig.id);
    document.body.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    if (g.type !== 'mouse' && navigator.vibrate) navigator.vibrate(8);
    updateTip();
    tip.hidden = false;
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
    const dyMin = (g.ly - g.sy + scrollEl.scrollTop - g.scroll0) / PPM;
    const dx = (g.lx - g.sx) / stacksEl.clientWidth;
    const end = o.start + o.minutes;
    const c = { ...o };
    switch (g.mode) {
      case 'move':
        c.start = clamp(snap(o.start + dyMin, SNAP_MIN), 0, DAY_MIN - SNAP_MIN);
        c.x = clamp(snap(o.x + dx, SNAP_X), 0, 1 - o.w);
        break;
      case 't':
        c.start = clamp(snap(o.start + dyMin, SNAP_MIN), 0, end - SNAP_MIN);
        c.minutes = end - c.start;
        break;
      case 'b':
        c.minutes = clamp(snap(o.minutes + dyMin, SNAP_MIN), SNAP_MIN, 2 * DAY_MIN - o.start);
        break;
      case 'l':
        c.x = clamp(snap(o.x + dx, SNAP_X), 0, o.x + o.w - MIN_W);
        c.w = o.x + o.w - c.x;
        break;
      case 'r':
        c.w = clamp(snap(o.w + dx, SNAP_X), MIN_W, 1 - o.x);
        break;
    }
    c.x = +c.x.toFixed(4);
    c.w = +c.w.toFixed(4);
    g.cur = c;
    placeStack(g.node, c);
    updateTip();
  }

  function updateTip() {
    const c = gesture.cur;
    if (gesture.mode === 'l' || gesture.mode === 'r') {
      tip.textContent = `폭 ${Math.round(c.w * 100)}%`;
    } else {
      tip.textContent = `${fmtTime(c.start)} – ${fmtTime(c.start + c.minutes)} · ${fmtDur(c.minutes)}`;
    }
  }

  // 위·아래 가장자리 근처에서는 저절로 스크롤
  function autoScroll() {
    const g = gesture;
    if (!g || !g.active) return;
    if (g.mode !== 'l' && g.mode !== 'r') {
      const r = scrollEl.getBoundingClientRect();
      const edge = 48;
      let v = 0;
      if (g.ly < r.top + edge) v = -Math.ceil((r.top + edge - g.ly) / 4);
      else if (g.ly > r.bottom - edge) v = Math.ceil((g.ly - (r.bottom - edge)) / 4);
      if (v) {
        const before = scrollEl.scrollTop;
        scrollEl.scrollTop += v;
        if (scrollEl.scrollTop !== before) computeGesture();
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
    tip.hidden = true;
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
      if (c.start !== o.start || c.minutes !== o.minutes || c.x !== o.x || c.w !== o.w) {
        Store.updateDay(openKey, day => {
          const s = day.stacks.find(x => x.id === c.id);
          if (s) Object.assign(s, { start: c.start, minutes: c.minutes, x: c.x, w: c.w });
        });
      }
      return;
    }
    const id = g.orig.id;
    const moved = g.moved;
    cleanupGesture();
    if (!moved) openSheet({ id }); // 짧게 누르면 편집
  }

  function onGestureCancel() {
    const g = gesture;
    if (!g) return;
    if (g.active) placeStack(g.node, g.orig);
    cleanupGesture();
  }

  // 빈 곳을 누르면: 선택 해제, 선택이 없었으면 그 시각에 새 스택
  stacksEl.addEventListener('click', e => {
    if (e.target !== stacksEl) return;
    if (selectedId) { select(null); return; }
    const y = e.clientY - stacksEl.getBoundingClientRect().top;
    const start = clamp(Math.floor(y / PPM / 15) * 15, 0, DAY_MIN - 15);
    openSheet({ start });
  });

  stacksEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const node = e.target.closest('.stack');
    if (!node) return;
    e.preventDefault();
    openSheet({ id: node.dataset.id });
  });

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
      const up = ev => {
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

  let editingId = null;
  let draftColor = COLORS[0];
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

  function openSheet({ id, start }) {
    if (!openKey || !sheet.hidden) return;
    const day = Store.getDay(openKey);
    editingId = id || null;
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
      nameInput.value = '';
      mins = 60;
      if (start != null) st = start;
      else if (day.stacks.length) st = Math.min(DAY_MIN - 15, Math.max(...day.stacks.map(s => s.start + s.minutes)));
      else if (openKey === keyOf(new Date())) {
        const n = new Date();
        st = Math.min(DAY_MIN - 15, Math.ceil((n.getHours() * 60 + n.getMinutes()) / 15) * 15);
      } else st = Store.DEFAULT_START;
      // 직전 스택과 다른 색을 기본으로
      const last = day.stacks[day.stacks.length - 1];
      draftColor = last ? COLORS[(COLORS.indexOf(last.color) + 1) % COLORS.length] : COLORS[0];
      $('sheet-title').textContent = '새 스택';
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
    if (!editingId) setTimeout(() => nameInput.focus({ preventScroll: true }), centered ? 0 : 80);
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
    const name = nameInput.value.trim();
    const minutes = draftMinutes();
    if (!name || !minutes || !openKey) return;
    const start = draftStart();
    let id = editingId;
    Store.updateDay(openKey, day => {
      if (id) {
        const s = day.stacks.find(x => x.id === id);
        if (s) Object.assign(s, { name, start, minutes, color: draftColor });
      } else {
        id = Store.newId();
        pendingHighlight = id;
        day.stacks.push({ id, name, start, minutes, color: draftColor, x: 0, w: 1 });
      }
    });
    closeSheet();
    requestAnimationFrame(() => scrollToStack(id));
  });

  deleteBtn.addEventListener('click', () => {
    if (!deleteArmed) {
      deleteArmed = true;
      deleteBtn.textContent = '한 번 더 누르면 삭제';
      return;
    }
    const id = editingId;
    const node = stacksEl.querySelector(`.stack[data-id="${id}"]`);
    closeSheet();
    if (selectedId === id) selectedId = null;
    const done = () => Store.updateDay(openKey, day => { day.stacks = day.stacks.filter(x => x.id !== id); });
    if (node) {
      node.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.85)', opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
        .finished.then(done);
    } else {
      done();
    }
  });

  $('sheet-cancel').addEventListener('click', () => closeSheet());
  backdrop.addEventListener('click', () => closeSheet());
  $('add-stack').addEventListener('click', () => openSheet({}));

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

  // ───────── 키보드 ─────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!sheet.hidden) closeSheet();
      else if (selectedId) select(null);
      else if (winMode === 'open') closeDay();
      return;
    }
    if (e.target.closest('input, .wheel')) return;
    if (!sheet.hidden) return;
    if (winMode === 'open') {
      if (e.key === 'ArrowLeft') goDay(-1);
      if (e.key === 'ArrowRight') goDay(1);
      if (e.key === 'n' || e.key === '+') { e.preventDefault(); openSheet({}); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) openSheet({ id: selectedId });
    } else if (!e.target.closest('.cell')) {
      if (e.key === 'ArrowLeft') shiftMonth(-1);
      if (e.key === 'ArrowRight') shiftMonth(1);
    }
  });

  // 데이터가 바뀌면 화면 갱신
  Store.subscribe(() => {
    renderMonth();
    if (winMode === 'open') renderDay();
  });
  Google.subscribe(() => {
    renderAccounts();
    if (!Sources.all().length) renderTasks();
  });
  Sources.subscribe(() => {
    renderMonth();
    renderTasks();
    if (winMode === 'open') renderDay();
  });

  // 자정이 지나거나 시간이 흐르면 표시를 다시 그린다
  let lastToday = keyOf(new Date());
  setInterval(() => {
    const k = keyOf(new Date());
    if (k !== lastToday) { lastToday = k; renderMonth(); if (winMode === 'open') renderDay(); }
    renderTasks();
  }, 60 * 1000);

  renderMonth();
  renderTasks();
  renderAccounts();
})();
