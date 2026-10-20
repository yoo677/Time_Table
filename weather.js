// 현재 위치의 날씨. Open-Meteo(키 없이 쓰는 무료 예보 API)에서 현재 날씨와 시간별 예보를 받는다.
// 위치는 브라우저 위치 권한으로 얻고, 지명은 BigDataCloud의 클라이언트용 역지오코딩으로 붙인다.
// 위치를 못 얻으면 서울 시청 좌표로 대신 보여 준다.
(() => {
  'use strict';

  const KEY = 'timetable.weather';
  const FALLBACK = { lat: 37.5665, lon: 126.978, place: '서울' };
  const REFRESH = 15 * 60 * 1000;
  const HOURS = 12;

  // WMO 날씨 코드 → [설명, 낮 아이콘, 밤 아이콘]
  const CODES = {
    0: ['맑음', '☀️', '🌙'],
    1: ['대체로 맑음', '🌤️', '🌙'],
    2: ['구름 조금', '⛅', '☁️'],
    3: ['흐림', '☁️', '☁️'],
    45: ['안개', '🌫️', '🌫️'], 48: ['안개', '🌫️', '🌫️'],
    51: ['약한 이슬비', '🌦️', '🌧️'], 53: ['이슬비', '🌦️', '🌧️'], 55: ['강한 이슬비', '🌧️', '🌧️'],
    56: ['어는 이슬비', '🌧️', '🌧️'], 57: ['어는 이슬비', '🌧️', '🌧️'],
    61: ['약한 비', '🌦️', '🌧️'], 63: ['비', '🌧️', '🌧️'], 65: ['강한 비', '🌧️', '🌧️'],
    66: ['어는 비', '🌧️', '🌧️'], 67: ['어는 비', '🌧️', '🌧️'],
    71: ['약한 눈', '🌨️', '🌨️'], 73: ['눈', '🌨️', '🌨️'], 75: ['강한 눈', '❄️', '❄️'], 77: ['싸락눈', '🌨️', '🌨️'],
    80: ['소나기', '🌦️', '🌧️'], 81: ['소나기', '🌧️', '🌧️'], 82: ['강한 소나기', '⛈️', '⛈️'],
    85: ['눈 소나기', '🌨️', '🌨️'], 86: ['강한 눈 소나기', '❄️', '❄️'],
    95: ['뇌우', '⛈️', '⛈️'], 96: ['우박 뇌우', '⛈️', '⛈️'], 99: ['우박 뇌우', '⛈️', '⛈️'],
  };
  function describe(code, isDay) {
    const c = CODES[code] || ['알 수 없음', '🌡️', '🌡️'];
    return { text: c[0], icon: isDay ? c[1] : c[2] };
  }

  let state = { status: 'loading' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && saved.current) state = { ...saved, status: 'ok', stale: true };
  } catch (e) { /* 무시 */ }
  const listeners = new Set();
  function emit() { listeners.forEach(fn => fn()); }

  function locate() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 10000 }
      );
    });
  }

  async function placeName(lat, lon) {
    // 같은 동네면 다시 묻지 않는다(소수 둘째 자리 ≈ 1km)
    const near = state.coords && Math.abs(state.coords.lat - lat) < 0.01 && Math.abs(state.coords.lon - lon) < 0.01;
    if (near && state.place) return state.place;
    try {
      const u = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`;
      const d = await (await fetch(u)).json();
      return d.locality || d.city || d.principalSubdivision || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchForecast(lat, lon) {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    Object.entries({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      current: 'temperature_2m,apparent_temperature,weather_code,is_day',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
      timezone: 'auto',
      forecast_days: 2,
    }).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u);
    if (!res.ok) throw new Error(`날씨를 불러오지 못했다(${res.status})`);
    const d = await res.json();
    // 시각 문자열은 그 위치의 현지 시각이다. 현재 시각이 속한 정시부터 HOURS개를 자른다
    const hourPrefix = d.current.time.slice(0, 13);
    const start = Math.max(0, d.hourly.time.findIndex(t => t.startsWith(hourPrefix)));
    const hourly = [];
    for (let i = start; i < Math.min(d.hourly.time.length, start + HOURS); i++) {
      hourly.push({
        hour: Number(d.hourly.time[i].slice(11, 13)),
        temp: Math.round(d.hourly.temperature_2m[i]),
        code: d.hourly.weather_code[i],
        isDay: !!d.hourly.is_day[i],
        pop: d.hourly.precipitation_probability ? d.hourly.precipitation_probability[i] : null,
      });
    }
    return {
      current: {
        temp: Math.round(d.current.temperature_2m),
        feels: Math.round(d.current.apparent_temperature),
        code: d.current.weather_code,
        isDay: !!d.current.is_day,
      },
      hourly,
    };
  }

  let running = false;
  async function refresh() {
    if (running) return;
    running = true;
    try {
      const pos = await locate();
      const coords = pos || { lat: FALLBACK.lat, lon: FALLBACK.lon };
      const [fc, place] = await Promise.all([
        fetchForecast(coords.lat, coords.lon),
        pos ? placeName(coords.lat, coords.lon) : Promise.resolve(FALLBACK.place),
      ]);
      state = {
        status: 'ok',
        coords,
        place: place || state.place || null,
        approximate: !pos,
        fetchedAt: Date.now(),
        ...fc,
      };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 무시 */ }
    } catch (e) {
      state = state.current ? { ...state, stale: true } : { status: 'error', error: e.message };
    } finally {
      running = false;
      emit();
    }
  }

  refresh();
  setInterval(refresh, REFRESH);
  // 오래 꺼 두었던 화면으로 돌아오면 바로 새로 받는다
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.fetchedAt || Date.now() - state.fetchedAt > REFRESH)) refresh();
  });

  window.Weather = {
    get: () => state,
    describe,
    refresh,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
