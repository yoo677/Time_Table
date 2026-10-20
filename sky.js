// 날씨 모드. 배경을 지금 날씨에 맞춰 바꾸고, 비·눈이 오면 화면 위에 빗방울과 눈송이를 떨어뜨린다.
// 빗방울은 칸(달력 칸, 할 일 패널, 시간표 창)에 맞으면 거기 맺혔다가 유리창의 물방울처럼
// 멈췄다 미끄러졌다를 되풀이하며 흘러내리고, 칸 아래 끝에 닿으면 다시 떨어진다.
// 눈송이는 칸에 쌓였다가 녹아서 물방울이 되어 흘러내린다.
// 어떤 칸에 부딪칠지는 app.js가 setTargets로 알려 준다.
(() => {
  'use strict';

  const sky = document.getElementById('sky');
  const canvas = document.getElementById('sky-fx');
  const ctx = canvas.getContext('2d');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  const MAX_DROPS = 420;
  const MAX_BEADS = 220;
  const SCAN_EVERY = 250; // ms. 칸 위치를 다시 읽는 간격

  let kind = null;          // null | 'clear' | 'cloud' | 'rain' | 'snow'
  let opts = { intensity: 1, night: false, dark: false };
  let targetsFn = () => ({ rects: [], top: 0 });
  let rects = [];
  let byEl = new Map();
  let top = 0;
  let W = 0, H = 0;
  let raf = 0, last = 0, lastScan = 0;
  const drops = [];   // 떨어지는 중
  const beads = [];   // 칸에 맺힌 것(머무름·흘러내림)
  const sparks = [];  // 부딪칠 때 튀는 작은 물방울

  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 칸 위치를 읽고, 옮겨진 칸에 맺힌 물방울은 같이 옮긴다. 사라진 칸의 물방울은 떨어진다
  function scan() {
    const t = targetsFn();
    top = t.top || 0;
    rects = t.rects;
    const next = new Map(rects.map(r => [r.el, r]));
    for (let i = beads.length - 1; i >= 0; i--) {
      const b = beads[i];
      const r = next.get(b.el);
      if (!r) { detach(b); beads.splice(i, 1); continue; }
      const dx = r.l - b.rect.l, dy = r.t - b.rect.t;
      if (dx || dy) {
        b.x += dx; b.y += dy;
        b.trail.forEach(p => { p.x += dx; p.y += dy; });
      }
      b.rect = r;
    }
    byEl = next;
  }

  // (x, y)를 덮고 있는 더 위층의 칸이 있으면 그 칸
  function coveredBy(x, y, layer) {
    return rects.find(r => r.layer > layer && x >= r.l && x <= r.r && y >= r.t && y <= r.b) || null;
  }

  function addDrop() {
    const x = rand(-60, W + 60);
    const y = top - rand(10, 60);
    if (kind === 'rain') {
      drops.push({ x, y, vx: rand(-70, -40), vy: rand(760, 1080), len: rand(9, 17), a: rand(0.28, 0.6), g: 0, face: null });
    } else {
      drops.push({ x, y, vx: rand(-12, 12), vy: rand(32, 75), r: rand(1.2, 3.2), a: rand(0.6, 0.95), phase: rand(0, 6.3), g: 0, face: null });
    }
  }

  function stick(d, r, y, edge) {
    if (beads.length >= MAX_BEADS) {
      // 가장 오래된 것부터 빨리 마르게
      beads.slice(0, 20).forEach(b => { b.dry = true; });
    }
    const snow = kind === 'snow' && d.r != null;
    beads.push({
      x: d.x, y, el: r.el, rect: r,
      r: snow ? d.r : rand(1.3, 2.9) * (opts.intensity > 1.3 ? 1.15 : 1),
      snow,
      a: snow ? d.a : rand(0.5, 0.8),
      state: 'hold',
      hold: snow ? rand(1.8, 5) : rand(0.12, 0.9),
      v: 0, target: 0, retarget: 0,
      wob: rand(0, 6.3),
      trail: [],
      age: 0,
      dry: false,
    });
    if (!snow && edge) {
      for (let i = 0; i < 3; i++) sparks.push({ x: d.x, y, vx: rand(-60, 60), vy: rand(-90, -30), life: rand(0.18, 0.32), a: 0.5 });
    }
  }

  // 칸 아래 끝에 닿은 물방울은 다시 떨어진다
  function detach(b) {
    if (drops.length >= MAX_DROPS) return;
    drops.push({ x: b.x, y: b.y + 1, vx: 0, vy: 60, len: 5 + b.r * 2, a: b.a * 0.8, g: 1900, face: null, bead: !b.snow, r: b.snow ? b.r : null });
  }

  function stepDrops(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const py = d.y;
      if (d.g) d.vy = Math.min(d.vy + d.g * dt, 950);
      if (d.r != null && kind === 'snow') {
        d.phase += dt * 1.6;
        d.x += (d.vx + Math.sin(d.phase) * 18) * dt;
      } else {
        d.x += d.vx * dt;
      }
      d.y += d.vy * dt;

      if (d.face) {
        // 칸 앞면에 맞을 높이까지 떨어졌다
        if (d.y >= d.face.y) {
          const r = byEl.get(d.face.el);
          if (r && d.x >= r.l + 2 && d.x <= r.r - 2) stick(d, r, d.face.y, false);
          drops.splice(i, 1);
        }
        continue;
      }
      // 칸 위쪽 테두리를 지나갔는가
      let hit = null;
      for (const r of rects) {
        if (py < r.t && d.y >= r.t && d.x >= r.l + 2 && d.x <= r.r - 2 && !coveredBy(d.x, r.t, r.layer)) { hit = r; break; }
      }
      if (hit) {
        // 절반은 위 테두리에, 나머지는 칸 앞면 어딘가에 맺힌다
        if (Math.random() < (kind === 'snow' ? 0.55 : 0.4)) {
          stick(d, hit, hit.t + 1, true);
          drops.splice(i, 1);
        } else {
          d.face = { el: hit.el, y: rand(hit.t + 6, Math.max(hit.t + 8, hit.b - 6)) };
        }
        continue;
      }
      if (d.y > H + 30 || d.x < -80 || d.x > W + 80) drops.splice(i, 1);
    }
  }

  function stepBeads(dt) {
    for (let i = beads.length - 1; i >= 0; i--) {
      const b = beads[i];
      b.age += dt;
      if (b.dry) b.a -= dt * 1.5;
      else if (b.age > 16) b.a -= dt * 0.25; // 오래 머문 물방울은 천천히 마른다
      if (b.a <= 0.02) { beads.splice(i, 1); continue; }

      if (b.state === 'hold') {
        b.hold -= dt;
        if (b.hold <= 0) {
          b.state = 'slide';
          if (b.snow) { b.snow = false; b.r = Math.max(1.1, b.r * 0.75); b.a = 0.6; } // 녹아서 물방울로
        }
        continue;
      }
      // 미끄러짐: 멈칫했다가 다시 흐르는 것을 되풀이한다. 큰 방울일수록 빠르다
      b.retarget -= dt;
      if (b.retarget <= 0) {
        b.retarget = rand(0.15, 0.6);
        b.target = Math.random() < 0.28 ? 0 : rand(14, 48) * (b.r / 1.8);
      }
      b.v += (b.target - b.v) * Math.min(1, dt * 6);
      const ny = b.y + b.v * dt;
      b.wob += dt * 2.3;
      const nx = b.x + Math.sin(b.wob) * 0.12;
      if (!b.trail.length || Math.abs(ny - b.trail[b.trail.length - 1].y) > 2) b.trail.push({ x: b.x, y: b.y });
      while (b.trail.length > 24) b.trail.shift();
      b.x = nx;
      b.y = ny;
      if (b.y >= b.rect.b - 1) {
        b.y = b.rect.b;
        detach(b);
        beads.splice(i, 1);
      }
    }
  }

  function stepSparks(dt) {
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) { sparks.splice(i, 1); continue; }
      s.vy += 900 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // 맨 위 흰 띠 아래에서만 그린다
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, H - top);
    ctx.clip();
    const water = opts.dark ? '170, 200, 235' : '96, 128, 170';
    const snowEdge = opts.dark ? '200, 215, 235' : '150, 170, 200';

    // 떨어지는 빗줄기·눈송이
    ctx.lineCap = 'round';
    drops.forEach(d => {
      if (d.r != null && !d.bead) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${d.a})`;
        ctx.fill();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = `rgba(${snowEdge}, ${d.a * 0.7})`;
        ctx.stroke();
        return;
      }
      const len = d.len;
      const k = len / Math.max(1, Math.hypot(d.vx, d.vy));
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.vx * k, d.y - d.vy * k);
      ctx.lineWidth = d.bead ? 1.8 : 1.1;
      ctx.strokeStyle = `rgba(${water}, ${d.a})`;
      ctx.stroke();
    });

    // 칸에 맺힌 물방울과 흘러내린 자국
    beads.forEach(b => {
      if (b.snow) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${b.a})`;
        ctx.fill();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = `rgba(${snowEdge}, ${b.a * 0.8})`;
        ctx.stroke();
        return;
      }
      if (b.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(b.trail[0].x, b.trail[0].y);
        b.trail.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = b.r * 0.9;
        ctx.strokeStyle = `rgba(${water}, ${b.a * 0.16})`;
        ctx.stroke();
      }
      // 아래가 약간 무거운 물방울 모양
      ctx.beginPath();
      ctx.ellipse(b.x, b.y, b.r * 0.85, b.r * (b.state === 'slide' && b.v > 8 ? 1.2 : 1), 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${water}, ${b.a * 0.42})`;
      ctx.fill();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `rgba(${water}, ${b.a * 0.55})`;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${b.a * 0.85})`;
      ctx.fill();
    });

    sparks.forEach(s => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 0.9, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${water}, ${s.a * (s.life / 0.3)})`;
      ctx.fill();
    });
    ctx.restore();
  }

  function frame(t) {
    raf = 0;
    if (!kind || document.hidden) return;
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016);
    last = t;
    if (t - lastScan > SCAN_EVERY) { scan(); lastScan = t; }

    if (kind === 'rain' || kind === 'snow') {
      const perSec = (kind === 'rain' ? 75 : 26) * opts.intensity * Math.max(0.5, W / 1000);
      let n = perSec * dt;
      while (n > 0 && drops.length < MAX_DROPS) { if (Math.random() < n) addDrop(); n -= 1; }
    }
    stepDrops(dt);
    stepBeads(dt);
    stepSparks(dt);
    draw();
    if (kind === 'rain' || kind === 'snow' || drops.length || beads.length) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  }

  // kind: null이면 날씨 모드 끔
  function set(nextKind, nextOpts) {
    opts = { ...opts, ...(nextOpts || {}) };
    const same = nextKind === kind;
    kind = nextKind;
    sky.hidden = !kind;
    sky.className = `sky${kind ? ` sky-${kind}` : ''}${opts.night ? ' night' : ''}`;
    document.body.classList.toggle('weather-mode', !!kind);
    const moving = (kind === 'rain' || kind === 'snow') && !REDUCED.matches;
    canvas.hidden = !moving;
    if (!moving) {
      drops.length = 0;
      beads.length = 0;
      sparks.length = 0;
      ctx.clearRect(0, 0, W, H);
      return;
    }
    // 비에서 눈으로 바뀌면 떨어지던 것은 새로. 같은 날씨로 다시 부르면 이어서
    if (!same) drops.length = 0;
    resize();
    scan();
    start();
  }

  addEventListener('resize', () => { if (!canvas.hidden) { resize(); scan(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && kind) start(); });

  window.Sky = {
    set,
    setTargets(fn) { targetsFn = fn; },
  };
})();
