// 天気（Open-Meteo：キー不要）と現在地
import { store } from './util.js';

const WMO = {
  0: ['☀️', '快晴'], 1: ['🌤️', '晴れ'], 2: ['⛅️', '一部くもり'], 3: ['☁️', 'くもり'],
  45: ['🌫️', '霧'], 48: ['🌫️', '霧'],
  51: ['🌦️', '霧雨'], 53: ['🌦️', '霧雨'], 55: ['🌧️', '霧雨'], 56: ['🌧️', '着氷性の霧雨'], 57: ['🌧️', '着氷性の霧雨'],
  61: ['🌦️', '小雨'], 63: ['🌧️', '雨'], 65: ['🌧️', '大雨'], 66: ['🌧️', '着氷性の雨'], 67: ['🌧️', '着氷性の雨'],
  71: ['🌨️', '小雪'], 73: ['🌨️', '雪'], 75: ['❄️', '大雪'], 77: ['🌨️', '霧雪'],
  80: ['🌦️', 'にわか雨'], 81: ['🌧️', 'にわか雨'], 82: ['⛈️', '激しいにわか雨'],
  85: ['🌨️', 'にわか雪'], 86: ['❄️', '激しいにわか雪'],
  95: ['⛈️', '雷雨'], 96: ['⛈️', '雷雨（ひょう）'], 99: ['⛈️', '激しい雷雨'],
};
export const wmo = (c, night) => {
  const w = WMO[c] || ['🌡️', '—'];
  if (night && (c === 0 || c === 1)) return ['🌙', w[1]];
  return w;
};

export function getPosition(timeout = 8000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('位置情報が使えません'));
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }), rej, { enableHighAccuracy: false, timeout, maximumAge: 10 * 60000 });
  });
}

async function placeName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ja`);
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || '現在地';
  } catch { return '現在地'; }
}

export async function searchCity(q) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=ja&format=json`);
  const j = await r.json();
  return (j.results || []).map((x) => ({ name: x.name, sub: [x.admin1, x.country].filter(Boolean).join('・'), lat: x.latitude, lon: x.longitude }));
}

let cache = null;
export async function getWeather(force = false) {
  if (!force && cache && Date.now() - cache.t < 15 * 60000) return cache.data;
  try {
    const saved = JSON.parse(localStorage.getItem('tabinavi.wx') || 'null');
    if (!force && saved && Date.now() - saved.t < 15 * 60000 && samePlace(saved.data.where)) { cache = saved; return saved.data; }
  } catch {}
  let where = store.data.settings.place;
  if (!where) {
    try {
      const p = await getPosition();
      where = { lat: p.lat, lon: p.lon, name: await placeName(p.lat, p.lon), gps: true };
    } catch {
      where = { lat: 35.681, lon: 139.767, name: '東京（現在地が使えません）' };
    }
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,precipitation&hourly=temperature_2m,weather_code,precipitation_probability,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max&timezone=auto&forecast_days=7`;
  const j = await (await fetch(url)).json();
  const data = { where, ...j };
  cache = { t: Date.now(), data };
  try { localStorage.setItem('tabinavi.wx', JSON.stringify(cache)); } catch {}
  return data;
}
function samePlace(w) {
  const p = store.data.settings.place;
  if (!p) return !!w?.gps || !w;
  return w && Math.abs(w.lat - p.lat) < 1e-3 && Math.abs(w.lon - p.lon) < 1e-3;
}
export function clearWeatherCache() { cache = null; localStorage.removeItem('tabinavi.wx'); }

// 旅程の場所の天気（日別）
export async function dailyFor(lat, lon) {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=14`);
  return r.json();
}
