// 시간표에 스택을 놓을 자리를 정한다. 화면과 상관없는 계산만 있어서 따로 시험할 수 있다.
//
// 규칙
// 1. 스택끼리 겹치지 않는다. 살짝 겹치게 놓으면 가장 가까운 빈자리로 붙여 놓는다.
// 2. 다른 스택의 중간(양쪽 끝에서 SPLIT_MIN분 이상 안쪽)에 놓으면 그 스택을 두 조각으로 나누고
//    사이에 끼워 넣는다. 나뉜 두 조각의 길이 합은 원래 길이와 같고, 뒤쪽 스택들은 그만큼 밀린다.
// 3. 학교 가는 날에는 교시가 고정된 칸이다. 교시 안에 놓으면 길이와 상관없이 그 교시(50분)를
//    채우고, 한 교시에는 스택 하나만 들어간다. 교시 밖 스택은 교시와 겹칠 수 없다.
//    교시에서 다시 빼면 원래 길이로 돌아간다.
// 가로로 나란히 놓은 스택(폭이 겹치지 않는 것)끼리는 시간이 겹쳐도 된다.
(() => {
  'use strict';

  const DAY = 24 * 60;
  const END = 2 * DAY;     // 자정을 넘겨 다음날까지 이어질 수 있다
  const SPLIT_MIN = 10;
  const EPS = 1e-6;

  const endOf = s => s.start + s.minutes;
  const hOverlap = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS;
  const tOverlap = (a, b) => a.start < endOf(b) && b.start < endOf(a);
  const collide = (a, b) => hOverlap(a, b) && tOverlap(a, b);

  const blocksOf = periods => periods.map(p => ({ id: `@${p.id}`, start: p.start, minutes: p.end - p.start, x: 0, w: 1, fixed: true, label: p.label }));

  // 나뉜 조각 사이가 비면(끼워 넣었던 스택을 뺐을 때) 뒤 조각을 당겨 붙인다
  function heal(list, blocks) {
    const groups = new Map();
    list.forEach(s => { if (s.group) (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s); });
    groups.forEach(parts => {
      parts.sort((a, b) => a.start - b.start);
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1], cur = parts[i];
        const gap = { start: endOf(prev), minutes: cur.start - endOf(prev), x: cur.x, w: cur.w };
        if (gap.minutes <= 0) continue;
        const busy = [...blocks, ...list].some(o => o !== cur && o !== prev && collide(o, gap));
        if (!busy) cur.start = gap.start;
      }
    });
    return list;
  }

  // 같은 그룹 조각이 다시 맞닿으면 하나로 합친다
  function mergeGroups(list, blocks) {
    heal(list, blocks || []);
    const groups = new Map();
    list.forEach(s => { if (s.group) (groups.get(s.group) || groups.set(s.group, []).get(s.group)).push(s); });
    const drop = new Set();
    groups.forEach(parts => {
      parts.sort((a, b) => a.start - b.start);
      for (let i = 1; i < parts.length; i++) {
        const prev = parts[i - 1], cur = parts[i];
        if (!drop.has(prev.id) && endOf(prev) === cur.start && prev.x === cur.x && prev.w === cur.w) {
          prev.minutes += cur.minutes;
          drop.add(cur.id);
          parts[i] = prev;
        }
      }
    });
    const out = list.filter(s => !drop.has(s.id));
    // 조각이 하나만 남으면 그룹 표시를 지운다
    const count = new Map();
    out.forEach(s => { if (s.group) count.set(s.group, (count.get(s.group) || 0) + 1); });
    out.forEach(s => { if (s.group && count.get(s.group) < 2) delete s.group; });
    return out;
  }

  // pinned는 그대로 두고, 나머지 중 무언가와 겹치는 스택을 아래로 민다(시작 순서대로)
  function ripple(list, pinnedIds, blocks) {
    const placed = list.filter(s => pinnedIds.has(s.id) || s.period);
    const movable = list.filter(s => !placed.includes(s)).sort((a, b) => a.start - b.start);
    for (const s of movable) {
      for (let guard = 0; guard < 100; guard++) {
        const hit = [...blocks, ...placed].find(o => collide(o, s));
        if (!hit) break;
        s.start = endOf(hit);
      }
      placed.push(s);
    }
    return placed;
  }

  // 가장 가까운 빈자리의 시작 시각. 없으면 null
  function nearestFree(obstacles, want, minutes) {
    const busy = obstacles.map(o => [o.start, endOf(o)]).sort((a, b) => a[0] - b[0]);
    const gaps = [];
    let cur = 0;
    busy.forEach(([a, b]) => {
      if (a > cur) gaps.push([cur, a]);
      cur = Math.max(cur, b);
    });
    if (cur < END) gaps.push([cur, END]);
    let best = null;
    gaps.forEach(([g0, g1]) => {
      const hi = Math.min(g1 - minutes, DAY - 5); // 시작은 그날 안이어야 한다
      if (hi < g0) return;
      const pos = Math.min(Math.max(want, g0), hi);
      if (best == null || Math.abs(pos - want) < Math.abs(best - want)) best = pos;
    });
    return best;
  }

  // stacks: 그날 스택 전부. cand: 놓으려는 스택(기존 스택이면 같은 id, 새 스택이면 새 id)
  // opts: { periods: 교시 목록(학교 안 가는 날은 []), newId() }
  // 반환: { ok, stacks, placed, kind: 'free'|'snap'|'split'|'period', note }
  function place(stacks, cand, opts) {
    const periods = opts.periods || [];
    const blocks = blocksOf(periods);
    const others = stacks.filter(s => s.id !== cand.id).map(s => ({ ...s }));
    let c = { ...cand };

    // 교시 안에 놓았다
    const p = periods.find(q => c.start >= q.start && c.start < q.end);
    if (p) {
      const slot = { start: p.start, minutes: p.end - p.start };
      const occ = others.find(o => o.period === p.id || tOverlap(o, slot));
      if (occ) return { ok: false, note: `${p.label}에는 이미 '${occ.name}'이(가) 있다` };
      c = { ...c, start: p.start, minutes: p.end - p.start, period: p.id, baseMinutes: c.baseMinutes || c.minutes, x: 0, w: 1 };
      delete c.group;
      const note = cand.period === p.id ? null : `${p.label}에 넣었다(50분)`;
      return { ok: true, stacks: mergeGroups([...others, c], blocks), placed: c, kind: 'period', note };
    }

    // 교시 밖: 교시에서 나온 스택은 원래 길이로
    if (c.period) {
      c.minutes = c.baseMinutes || c.minutes;
      delete c.period;
      delete c.baseMinutes;
    }

    // 다른 스택 중간에 끼워 넣기
    const host = others.find(o => !o.period && hOverlap(o, c) && o.start < c.start && c.start < endOf(o));
    if (host && c.start - host.start >= SPLIT_MIN && endOf(host) - c.start >= SPLIT_MIN && !blocks.some(b => tOverlap(b, c))) {
      const group = host.group || host.id;
      const first = { ...host, minutes: c.start - host.start, group };
      const second = { ...host, id: opts.newId(), start: endOf(c), minutes: endOf(host) - c.start, group };
      const list = others.map(o => (o.id === host.id ? first : o));
      list.push(c, second);
      const settled = ripple(list, new Set([first.id, c.id]), blocks);
      return { ok: true, stacks: mergeGroups(settled, blocks), placed: c, kind: 'split', note: `'${host.name}'을(를) 나누어 사이에 넣었다` };
    }

    // 겹치면 가장 가까운 빈자리로
    const obstacles = [...blocks, ...others.filter(o => hOverlap(o, c))];
    const pos = nearestFree(obstacles, c.start, c.minutes);
    if (pos == null) return { ok: false, note: '들어갈 빈자리가 없다' };
    const snapped = pos !== c.start;
    c.start = pos;
    return { ok: true, stacks: mergeGroups([...others, c], blocks), placed: c, kind: snapped ? 'snap' : 'free', note: snapped ? '겹치지 않게 옆으로 붙였다' : null };
  }

  // 손잡이로 크기를 바꿀 때 넘을 수 없는 경계
  function limits(stacks, s, periods) {
    const blocks = blocksOf(periods || []);
    const others = [...blocks, ...stacks.filter(o => o.id !== s.id)];
    const sameCol = others.filter(o => hOverlap(o, s));
    const minStart = Math.max(0, ...sameCol.filter(o => endOf(o) <= s.start).map(endOf));
    const maxEnd = Math.min(END, ...sameCol.filter(o => o.start >= endOf(s)).map(o => o.start));
    const sameTime = others.filter(o => !o.fixed && tOverlap(o, s));
    const minX = Math.max(0, ...sameTime.filter(o => o.x + o.w <= s.x + EPS).map(o => o.x + o.w));
    const maxR = Math.min(1, ...sameTime.filter(o => o.x >= s.x + s.w - EPS).map(o => o.x));
    return { minStart, maxEnd, minX, maxR };
  }

  // 스택을 지운 뒤 등: 나뉜 조각 사이가 비었으면 다시 붙인다
  function tidy(stacks, periods) {
    return mergeGroups(stacks.map(s => ({ ...s })), blocksOf(periods || []));
  }

  window.Placement = { place, limits, tidy, SPLIT_MIN };
})();
