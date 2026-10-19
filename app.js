(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const COLORS = ['#007aff', '#34c759', '#ff9500', '#ff2d55', '#af52de', '#5ac8fa', '#ffcc00', '#8e8e93'];
  const PRESETS = [15, 30, 45, 60, 90, 120, 180];
  const MIN_DUR = 5;
  const MAX_DUR = 24 * 60;

  function fmtTime(min) {
    const next = min >= 1440;
    const m = min % 1440;
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

  // ───────── 상태 ─────────
  const today = new Date();
  let viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  let openKey = null;
  let animating = false;
  let pendingHighlight = null; // 방금 추가한 스택 id. 다음 그리기에서 등장 애니메이션을 준다

  // ───────── 달력 ─────────
  const grid = $('grid');

  function renderMonth() {
    $('cal-year').textContent = `${viewMonth.getFullYear()}년`;
    $('cal-month').textContent = `${viewMonth.getMonth() + 1}월`;

    const first = addDays(viewMonth, -viewMonth.getDay());
    const todayKey = keyOf(new Date());
    const frag = document.createDocumentFragment();

    for (let i = 0; i < 42; i++) {
      const d = addDays(first, i);
      const key = keyOf(d);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.key = key;
      if (d.getMonth() !== viewMonth.getMonth()) cell.classList.add('outside');
      if (d.getDay() === 0) cell.classList.add('sun');
      if (d.getDay() === 6) cell.classList.add('sat');
      if (key === todayKey) cell.classList.add('today');

      const stacks = Store.getDay(key).stacks;
      cell.setAttribute('aria-label', `${d.getMonth() + 1}월 ${d.getDate()}일${stacks.length ? `, 스택 ${stacks.length}개` : ''}`);

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = d.getDate();
      cell.append(num);

      if (stacks.length) {
        const list = document.createElement('div');
        list.className = 'chips-mini';
        const dots = document.createElement('div');
        dots.className = 'dots';
        stacks.forEach((s, idx) => {
          if (idx < 4) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.setProperty('--c', s.color);
            dots.append(dot);
          }
          const chip = document.createElement('span');
          chip.className = 'mini';
          chip.style.setProperty('--c', s.color);
          chip.textContent = s.name;
          list.append(chip);
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
      const more = document.createElement('span');
      more.className = 'mini-more';
      list.append(more);
      let hiddenCount = 0;
      for (let i = chips.length - 1; i >= 0 && list.scrollHeight > list.clientHeight; i--) {
        chips[i].hidden = true;
        hiddenCount++;
        more.textContent = `+${hiddenCount}`;
      }
    });
  }

  function shiftMonth(delta) {
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
    renderMonth();
    if (!delta) return;
    grid.animate(
      [{ transform: `translateX(${delta * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      motion(SPRING_SMOOTH)
    );
  }

  $('prev-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('today-btn').addEventListener('click', () => {
    const t = new Date();
    const delta = (t.getFullYear() - viewMonth.getFullYear()) * 12 + t.getMonth() - viewMonth.getMonth();
    if (delta) {
      viewMonth = new Date(t.getFullYear(), t.getMonth(), 1);
      renderMonth();
      grid.animate(
        [{ transform: `translateX(${Math.sign(delta) * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
        motion(SPRING_SMOOTH)
      );
    }
    const cell = grid.querySelector('.cell.today');
    cell?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
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

  window.addEventListener('resize', () => requestAnimationFrame(trimMiniChips));

  // ───────── 하루 화면 열기/닫기 ─────────
  const dayEl = $('day');
  const dayInner = $('day-inner');
  const calendarEl = $('calendar');

  function cellRadius() {
    return matchMedia('(max-width: 640px)').matches ? 12 : 14;
  }
  function dayRadius() {
    return matchMedia('(min-width: 900px)').matches ? 28 : 0;
  }

  // 칸의 위치를 하루 화면 기준 clip-path로 바꾼다
  function insetFor(rect, dayRect, radius) {
    const t = rect.top - dayRect.top;
    const l = rect.left - dayRect.left;
    const r = dayRect.right - rect.right;
    const b = dayRect.bottom - rect.bottom;
    return `inset(${t}px ${r}px ${b}px ${l}px round ${radius}px)`;
  }
  // 내용물은 칸 크기만큼 작게, 칸 중심에서 시작
  function transformFor(rect, dayRect) {
    const s = Math.max(rect.width / dayRect.width, 0.15);
    const dx = (rect.left + rect.width / 2) - (dayRect.left + dayRect.width / 2);
    const dy = (rect.top + rect.height / 2) - (dayRect.top + dayRect.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${s})`;
  }

  function openDay(key, cell) {
    if (animating || openKey) return;
    openKey = key;
    renderDay();
    dayEl.hidden = false;
    document.documentElement.style.setProperty('--open', '1');

    const dayRect = dayEl.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const m = motion(SPRING_SMOOTH);

    scrollToStart(false);
    animating = true;
    const a = dayEl.animate(
      [{ clipPath: insetFor(rect, dayRect, cellRadius()) }, { clipPath: `inset(0px 0px 0px 0px round ${dayRadius()}px)` }],
      m
    );
    dayInner.animate(
      [
        { transform: transformFor(rect, dayRect), opacity: 0 },
        { opacity: 1, offset: 0.35 },
        { transform: 'none', opacity: 1 },
      ],
      m
    );
    calendarEl.animate(
      [{ transform: 'none', opacity: 1 }, { transform: 'scale(0.94)', opacity: 0.4 }],
      { ...m, fill: 'forwards' }
    );
    a.finished.finally(() => { animating = false; });
    $('add-stack').focus({ preventScroll: true });
  }

  function closeDay() {
    if (animating || !openKey) return;
    closeSheet(true);
    const key = openKey;
    // 하루 화면에서 다른 날로 이동했으면 그 달로 맞춰 둔다
    const d = parseKey(key);
    if (d.getFullYear() !== viewMonth.getFullYear() || d.getMonth() !== viewMonth.getMonth()) {
      viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    renderMonth();

    // 칸 위치는 달력이 원래 크기일 때 기준으로 잰다
    calendarEl.getAnimations().forEach(an => an.cancel());
    const cell = grid.querySelector(`.cell[data-key="${key}"]`);
    const rect = cell?.getBoundingClientRect();
    const dayRect = dayEl.getBoundingClientRect();
    const m = motion(SPRING_SMOOTH);
    animating = true;

    calendarEl.animate([{ transform: 'scale(0.94)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], m);

    let a;
    if (cell) {
      a = dayEl.animate(
        [{ clipPath: `inset(0px 0px 0px 0px round ${dayRadius()}px)` }, { clipPath: insetFor(rect, dayRect, cellRadius()) }],
        { ...m, fill: 'forwards' }
      );
      dayInner.animate(
        [
          { transform: 'none', opacity: 1 },
          { opacity: 0, offset: 0.6 },
          { transform: transformFor(rect, dayRect), opacity: 0 },
        ],
        { ...m, fill: 'forwards' }
      );
    } else {
      a = dayEl.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }], { ...m, fill: 'forwards' });
    }

    a.finished.finally(() => {
      dayEl.hidden = true;
      dayEl.getAnimations().forEach(an => an.cancel());
      dayInner.getAnimations().forEach(an => an.cancel());
      openKey = null;
      animating = false;
      cell?.focus({ preventScroll: true });
    });
  }

  $('day-back').addEventListener('click', closeDay);

  function goDay(delta) {
    if (!openKey || animating) return;
    openKey = keyOf(addDays(parseKey(openKey), delta));
    renderDay();
    scrollToStart(false);
    dayInner.animate(
      [{ transform: `translateX(${delta * 36}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      motion(SPRING_SMOOTH)
    );
  }
  $('prev-day').addEventListener('click', () => goDay(-1));
  $('next-day').addEventListener('click', () => goDay(1));

  // ───────── 하루 화면 그리기 ─────────
  const HOUR_PX = 64;
  const PX_PER_MIN = HOUR_PX / 60;
  const hoursEl = $('hours');
  const stacksEl = $('stacks');
  const scrollEl = $('timeline-scroll');
  const nowLine = $('now-line');

  function renderDay() {
    if (!openKey) return;
    const highlightId = pendingHighlight;
    pendingHighlight = null;
    const d = parseKey(openKey);
    const day = Store.getDay(openKey);

    const wd = $('day-weekday');
    wd.textContent = WEEKDAYS[d.getDay()] + (openKey === keyOf(new Date()) ? ' · 오늘' : '');
    wd.classList.toggle('sun', d.getDay() === 0);
    $('day-date').textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    $('day-back-label').textContent = `${d.getMonth() + 1}월`;
    $('day-start').value = `${pad(Math.floor(day.start / 60))}:${pad(day.start % 60)}`;

    const total = day.stacks.reduce((sum, s) => sum + s.minutes, 0);
    $('day-summary').textContent = day.stacks.length
      ? `스택 ${day.stacks.length}개 · ${fmtDur(total)} · ${fmtTime(day.start + total)} 종료`
      : '아직 스택이 없다';

    // 시간 눈금. 스택이 자정을 넘기면 그만큼 늘린다
    const endHour = Math.max(24, Math.ceil((day.start + total) / 60));
    if (hoursEl.childElementCount !== endHour) {
      const frag = document.createDocumentFragment();
      for (let h = 0; h < endHour; h++) {
        const row = document.createElement('div');
        row.className = 'hour';
        const label = document.createElement('span');
        label.textContent = h === 0 ? '' : `${pad(h % 24)}:00`;
        row.append(label);
        frag.append(row);
      }
      hoursEl.replaceChildren(frag);
    }

    // 기존 스택 요소는 재사용해서 위치가 바뀔 때 부드럽게 움직이게 한다
    const existing = new Map([...stacksEl.querySelectorAll('.stack')].map(el => [el.dataset.id, el]));
    stacksEl.querySelector('.empty-hint')?.remove();

    let cursor = day.start;
    day.stacks.forEach((s, i) => {
      let el = existing.get(s.id);
      const isNew = !el;
      if (isNew) {
        el = document.createElement('div');
        el.className = 'stack';
        el.dataset.id = s.id;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'stack-card';
        card.innerHTML = '<span class="stack-name"></span><span class="stack-time"></span>';
        el.append(card);
      }
      existing.delete(s.id);

      const h = s.minutes * PX_PER_MIN;
      el.style.top = `${cursor * PX_PER_MIN}px`;
      el.style.height = `${h}px`;
      el.style.setProperty('--c', s.color);
      el.classList.toggle('compact', h < 48);
      el.classList.toggle('tiny', h < 26);
      el.querySelector('.stack-name').textContent = s.name;
      el.querySelector('.stack-time').textContent = `${fmtTime(cursor)} – ${fmtTime(cursor + s.minutes)} · ${fmtDur(s.minutes)}`;
      el.querySelector('.stack-card').setAttribute('aria-label', `${s.name}, ${fmtTime(cursor)}부터 ${fmtDur(s.minutes)}`);
      el.dataset.index = i;

      if (stacksEl.children[i] !== el) stacksEl.insertBefore(el, stacksEl.children[i] || null);

      if (isNew && s.id === highlightId) {
        el.animate(
          [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          motion(SPRING_BOUNCY)
        );
      }
      cursor += s.minutes;
    });
    existing.forEach(el => el.remove());

    if (!day.stacks.length) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.style.top = `${day.start * PX_PER_MIN + 4}px`;
      hint.textContent = '+ 버튼으로 첫 스택을 쌓아 보자';
      stacksEl.append(hint);
    }

    updateNowLine();
  }

  function updateNowLine() {
    const now = new Date();
    if (!openKey || openKey !== keyOf(now)) { nowLine.hidden = true; return; }
    nowLine.hidden = false;
    nowLine.style.top = `${(now.getHours() * 60 + now.getMinutes()) * PX_PER_MIN}px`;
  }
  setInterval(updateNowLine, 30 * 1000);

  function scrollToStart(smooth) {
    const day = Store.getDay(openKey);
    const top = Math.max(0, (day.start - 30) * PX_PER_MIN);
    scrollEl.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  function scrollToStack(id) {
    const el = stacksEl.querySelector(`.stack[data-id="${id}"]`);
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const view = scrollEl.clientHeight;
    if (top < scrollEl.scrollTop || bottom > scrollEl.scrollTop + view - 100) {
      scrollEl.scrollTo({ top: Math.max(0, bottom - view + 140), behavior: 'smooth' });
    }
  }

  $('day-start').addEventListener('change', e => {
    const v = e.target.value;
    if (!v || !openKey) return;
    const [h, m] = v.split(':').map(Number);
    Store.updateDay(openKey, day => { day.start = h * 60 + m; });
    scrollToStart(true);
  });

  stacksEl.addEventListener('click', e => {
    const el = e.target.closest('.stack');
    if (el) openSheet(el.dataset.id);
  });

  // 하루 화면에서 좌우로 밀어서 날짜 넘기기
  let dayTouch = null;
  scrollEl.addEventListener('touchstart', e => {
    const t = e.touches[0];
    dayTouch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  scrollEl.addEventListener('touchend', e => {
    if (!dayTouch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - dayTouch.x, dy = t.clientY - dayTouch.y;
    dayTouch = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) goDay(dx < 0 ? 1 : -1);
  });

  // ───────── 스택 입력 시트 ─────────
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  const nameInput = $('stack-name');
  const durOut = $('dur-out');
  const chipsEl = $('dur-chips');
  const colorsEl = $('colors');
  const deleteBtn = $('delete-stack');

  let editingId = null;
  let draftMinutes = 60;
  let draftColor = COLORS[0];
  let deleteArmed = false;

  PRESETS.forEach(min => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.min = min;
    b.textContent = fmtDur(min);
    chipsEl.append(b);
  });
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `색상 ${c}`);
    colorsEl.append(b);
  });

  function syncSheet() {
    durOut.textContent = fmtDur(draftMinutes);
    chipsEl.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.min === draftMinutes)));
    colorsEl.querySelectorAll('.swatch').forEach(b => b.setAttribute('aria-checked', String(b.dataset.color === draftColor)));
    $('dur-minus').disabled = draftMinutes <= MIN_DUR;
    $('dur-plus').disabled = draftMinutes >= MAX_DUR;
    $('sheet-save').disabled = !nameInput.value.trim();
  }

  function openSheet(id) {
    if (!openKey || !sheet.hidden) return;
    const day = Store.getDay(openKey);
    editingId = id || null;
    deleteArmed = false;
    deleteBtn.textContent = '스택 삭제';

    if (editingId) {
      const s = day.stacks.find(x => x.id === editingId);
      if (!s) return;
      const idx = day.stacks.indexOf(s);
      nameInput.value = s.name;
      draftMinutes = s.minutes;
      draftColor = s.color;
      $('sheet-title').textContent = '스택 편집';
      $('sheet-save').textContent = '완료';
      $('move-up').disabled = idx === 0;
      $('move-down').disabled = idx === day.stacks.length - 1;
    } else {
      nameInput.value = '';
      draftMinutes = 60;
      // 직전 스택과 다른 색을 기본으로
      const last = day.stacks[day.stacks.length - 1];
      draftColor = last ? COLORS[(COLORS.indexOf(last.color) + 1) % COLORS.length] : COLORS[0];
      $('sheet-title').textContent = '새 스택';
      $('sheet-save').textContent = '추가';
    }
    $('edit-actions').hidden = !editingId;
    syncSheet();

    backdrop.hidden = false;
    sheet.hidden = false;
    const centered = matchMedia('(min-width: 640px)').matches;
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: 'ease-out' });
    sheet.animate(
      centered
        ? [{ transform: 'translateY(-50%) scale(0.9)', opacity: 0 }, { transform: 'translateY(-50%)', opacity: 1 }]
        : [{ transform: 'translateY(100%)' }, { transform: 'none' }],
      { ...motion(centered ? SPRING_BOUNCY : SPRING_SMOOTH), fill: 'both' }
    );
    if (!editingId) setTimeout(() => nameInput.focus(), centered ? 0 : 80);
  }

  function closeSheet(immediate) {
    if (sheet.hidden) return;
    nameInput.blur();
    if (immediate) {
      sheet.getAnimations().forEach(a => a.cancel());
      sheet.hidden = true;
      backdrop.hidden = true;
      return;
    }
    const centered = matchMedia('(min-width: 640px)').matches;
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    const a = sheet.animate(
      centered
        ? [{ transform: 'translateY(-50%)', opacity: 1 }, { transform: 'translateY(-50%) scale(0.94)', opacity: 0 }]
        : [{ transform: 'none' }, { transform: 'translateY(100%)' }],
      { duration: centered ? 180 : 280, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }
    );
    a.finished.then(() => {
      sheet.hidden = true;
      backdrop.hidden = true;
      sheet.getAnimations().forEach(x => x.cancel());
      backdrop.getAnimations().forEach(x => x.cancel());
    });
  }

  nameInput.addEventListener('input', syncSheet);
  $('dur-minus').addEventListener('click', () => {
    draftMinutes = Math.max(MIN_DUR, Math.ceil(draftMinutes / 5) * 5 - 5);
    syncSheet();
  });
  $('dur-plus').addEventListener('click', () => {
    draftMinutes = Math.min(MAX_DUR, Math.floor(draftMinutes / 5) * 5 + 5);
    syncSheet();
  });
  chipsEl.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    draftMinutes = +b.dataset.min;
    syncSheet();
  });
  colorsEl.addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    draftColor = b.dataset.color;
    syncSheet();
  });

  sheet.addEventListener('submit', e => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || !openKey) return;
    let id = editingId;
    Store.updateDay(openKey, day => {
      if (id) {
        const s = day.stacks.find(x => x.id === id);
        if (s) Object.assign(s, { name, minutes: draftMinutes, color: draftColor });
      } else {
        id = Store.newId();
        pendingHighlight = id;
        day.stacks.push({ id, name, minutes: draftMinutes, color: draftColor });
      }
    });
    closeSheet();
    requestAnimationFrame(() => scrollToStack(id));
  });

  function move(delta) {
    const id = editingId;
    Store.updateDay(openKey, day => {
      const i = day.stacks.findIndex(x => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= day.stacks.length) return;
      [day.stacks[i], day.stacks[j]] = [day.stacks[j], day.stacks[i]];
    });
    closeSheet();
  }
  $('move-up').addEventListener('click', () => move(-1));
  $('move-down').addEventListener('click', () => move(1));

  deleteBtn.addEventListener('click', () => {
    if (!deleteArmed) {
      deleteArmed = true;
      deleteBtn.textContent = '한 번 더 누르면 삭제';
      return;
    }
    const id = editingId;
    const el = stacksEl.querySelector(`.stack[data-id="${id}"]`);
    closeSheet();
    const done = () => Store.updateDay(openKey, day => { day.stacks = day.stacks.filter(x => x.id !== id); });
    if (el) {
      el.animate([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.85)', opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
        .finished.then(done);
    } else {
      done();
    }
  });

  $('sheet-cancel').addEventListener('click', () => closeSheet());
  backdrop.addEventListener('click', () => closeSheet());
  $('add-stack').addEventListener('click', () => openSheet(null));

  // 시트 손잡이를 아래로 끌어서 닫기
  let drag = null;
  sheet.addEventListener('touchstart', e => {
    if (matchMedia('(min-width: 640px)').matches) return;
    if (sheet.scrollTop > 0 || e.target.closest('input, .chips, .colors')) return;
    drag = { y: e.touches[0].clientY, dy: 0 };
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (!drag) return;
    drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
    sheet.getAnimations().forEach(a => a.cancel());
    sheet.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!drag) return;
    const { dy } = drag;
    drag = null;
    sheet.style.transform = '';
    if (dy > 110) {
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(100%)' }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(() => {
        sheet.hidden = true;
        backdrop.hidden = true;
        sheet.getAnimations().forEach(a => a.cancel());
        backdrop.getAnimations().forEach(a => a.cancel());
      });
    } else if (dy > 0) {
      sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], motion(SPRING_BOUNCY));
    }
  });

  // ───────── 키보드 ─────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!sheet.hidden) closeSheet();
      else if (openKey) closeDay();
      return;
    }
    if (e.target.closest('input')) return;
    if (!sheet.hidden) return;
    if (openKey) {
      if (e.key === 'ArrowLeft') goDay(-1);
      if (e.key === 'ArrowRight') goDay(1);
      if (e.key === 'n' || e.key === '+') { e.preventDefault(); openSheet(null); }
    } else {
      if (e.key === 'ArrowLeft' && !e.target.closest('.cell')) shiftMonth(-1);
      if (e.key === 'ArrowRight' && !e.target.closest('.cell')) shiftMonth(1);
    }
  });

  // 저장소가 바뀌면 화면 갱신
  Store.subscribe(() => {
    renderMonth();
    if (openKey) renderDay();
  });

  // 자정이 지나면 오늘 표시를 다시 그린다
  let lastToday = keyOf(new Date());
  setInterval(() => {
    const k = keyOf(new Date());
    if (k !== lastToday) { lastToday = k; renderMonth(); if (openKey) renderDay(); }
  }, 60 * 1000);

  renderMonth();
})();
