// 交通：地図（Leaflet + OpenStreetMap）・乗換案内（各サービスへ条件を渡す）・運行情報
import { $, $$, esc, store, sheet, toast, haptic, I, TYPES, TRANSPORT, pad, segment, parseLocal } from './util.js';
import { getPosition } from './weather.js';
import { currentTrip } from './trip.js';

const el = () => $('#view-transit');
let tab = 'route';
let map = null, meMarker = null, layer = null;

export const mapsSearchUrl = (q) => `https://maps.apple.com/?q=${encodeURIComponent(q || '')}`;

// 乗換案内のサービスへ渡すURL
function yahooUrl(from, to, when, type) {
  const d = when || new Date();
  const p = new URLSearchParams({ from, to, y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()), hh: pad(d.getHours()), m1: Math.floor(d.getMinutes() / 10), m2: d.getMinutes() % 10, type: type || 1, ticket: 'ic', expkind: 1, ws: 3, s: 0 });
  return `https://transit.yahoo.co.jp/search/result?${p}`;
}
const googleUrl = (from, to) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;
const appleUrl = (from, to) => `https://maps.apple.com/?saddr=${encodeURIComponent(from)}&daddr=${encodeURIComponent(to)}&dirflg=r`;
const navitimeUrl = (from, to) => `https://www.navitime.co.jp/maps/routeSearch?orvStationName=${encodeURIComponent(from)}&dnvStationName=${encodeURIComponent(to)}`;

export function transitLinks({ from, to, when }) {
  sheet({
    title: '乗換案内', left: '閉じる',
    build(body) {
      body.innerHTML = `<div class="card" style="animation:none"><div style="font-weight:600;font-size:18px">${esc(from)} → ${esc(to)}</div>${when ? `<div class="small muted">${when.getMonth() + 1}/${when.getDate()} ${pad(when.getHours())}:${pad(when.getMinutes())} 出発</div>` : ''}</div>
        ${linkList(from, to, when, 1)}
        <div class="section-foot">結果の画面をスクリーンショットして「旅程 → ＋ → 予備ルートを追加」で取り込めます。</div>`;
    },
  });
}
function linkList(from, to, when, type) {
  return `<div class="list">
    <a class="row icon-row" href="${yahooUrl(from, to, when, type)}" target="_blank" rel="noopener"><span class="ico" style="background:#FF0033">Y!</span><div class="grow">Yahoo!乗換案内<div class="sub">日時・出発/到着を指定して検索</div></div>${I.ext}</a>
    <a class="row icon-row" href="${googleUrl(from, to)}" target="_blank" rel="noopener"><span class="ico" style="background:#34A853">${I.map}</span><div class="grow">Google マップ</div>${I.ext}</a>
    <a class="row icon-row" href="${appleUrl(from, to)}" target="_blank" rel="noopener"><span class="ico" style="background:#007AFF">${I.locate}</span><div class="grow">Apple マップ</div>${I.ext}</a>
    <a class="row icon-row" href="${navitimeUrl(from, to)}" target="_blank" rel="noopener"><span class="ico" style="background:#00A0E9">${I.route}</span><div class="grow">NAVITIME</div>${I.ext}</a>
  </div>`;
}

export function renderTransit() {
  el().innerHTML = `
    <div class="large-title"><h1>交通</h1></div>
    <div class="segment" id="tr-seg"><button data-v="route" class="${tab === 'route' ? 'active' : ''}">乗換案内</button><button data-v="map" class="${tab === 'map' ? 'active' : ''}">マップ</button><button data-v="info" class="${tab === 'info' ? 'active' : ''}">運行情報</button></div>
    <div id="tr-body"></div>`;
  segment($('#tr-seg'), (v) => { tab = v; drawBody(); });
  drawBody();
}
export function showTransitTab(v) { tab = v; renderTransit(); }

function drawBody() {
  if (map) { map.remove(); map = null; meMarker = null; layer = null; }
  const b = $('#tr-body');
  if (tab === 'route') drawRoute(b);
  else if (tab === 'map') drawMap(b);
  else drawInfo(b);
}

// ===== 乗換案内 =====
function drawRoute(b) {
  const d = store.data;
  const now = new Date();
  b.innerHTML = `
    <div class="list route-form" style="position:relative">
      <div class="row"><span style="color:var(--green)">●</span><input type="text" id="rt-from" class="left" placeholder="出発（駅・住所・施設）"></div>
      <div class="row"><span style="color:var(--red)">●</span><input type="text" id="rt-to" class="left" placeholder="到着"></div>
      <button class="icon-btn swap" id="rt-swap">${I.swap}</button>
    </div>
    <div class="list" style="margin-top:12px">
      <div class="row"><div class="grow">日時</div><input type="datetime-local" id="rt-when" value="${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}"></div>
      <div class="row"><div class="grow">条件</div><select id="rt-type"><option value="1">出発</option><option value="4">到着</option><option value="3">始発</option><option value="2">終電</option></select></div>
    </div>
    <div class="hstack" style="margin-top:12px"><button class="btn secondary" id="rt-here" style="flex:1">${I.locate}現在地から</button><button class="btn" id="rt-go" style="flex:1.4">${I.search}検索</button></div>
    <div id="rt-links" style="margin-top:14px"></div>
    ${tripLegs()}
    ${d.recentRoutes.length ? `<div class="section-title">最近の検索</div><div class="list">${d.recentRoutes.map((r, i) => `<button class="row" data-recent="${i}">${I.clock}<div class="grow">${esc(r.from)} → ${esc(r.to)}</div><span class="chev">${I.chev}</span></button>`).join('')}</div>` : ''}
    <div class="section-foot">乗換の検索は Yahoo!乗換案内・Google マップなどで開きます（各サービスの最新ダイヤで検索されます）。</div>`;
  const from = $('#rt-from'), to = $('#rt-to');
  $('#rt-swap').onclick = () => { [from.value, to.value] = [to.value, from.value]; haptic(); };
  $('#rt-here').onclick = async () => {
    try { toast('現在地を調べています…'); const p = await getPosition(); from.value = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`; from.dataset.here = '1'; toast('現在地を入れました'); }
    catch { toast('現在地を取得できませんでした'); }
  };
  const show = () => {
    if (!from.value || !to.value) { toast('出発と到着を入れてください'); return; }
    const when = parseLocal($('#rt-when').value) || new Date();
    const type = $('#rt-type').value;
    $('#rt-links').innerHTML = linkList(from.value, to.value, when, type);
    if (!from.dataset.here) {
      d.recentRoutes = [{ from: from.value, to: to.value }, ...d.recentRoutes.filter((r) => r.from !== from.value || r.to !== to.value)].slice(0, 8);
      store.save();
    }
  };
  $('#rt-go').onclick = show;
  $$('[data-recent]', b).forEach((x) => x.onclick = () => { const r = d.recentRoutes[+x.dataset.recent]; from.value = r.from; to.value = r.to; delete from.dataset.here; show(); });
  $$('[data-leg]', b).forEach((x) => x.onclick = () => { from.value = x.dataset.from; to.value = x.dataset.to; delete from.dataset.here; const w = parseLocal(x.dataset.when); if (w) $('#rt-when').value = x.dataset.when; show(); });
}
function tripLegs() {
  const t = currentTrip();
  if (!t) return '';
  const now = new Date();
  const legs = t.items.filter((i) => TRANSPORT.has(i.type) && i.from && i.to && (!i.start || parseLocal(i.start) > new Date(now - 3 * 3600e3))).sort((a, b) => (a.start || '').localeCompare(b.start || '')).slice(0, 6);
  if (!legs.length) return '';
  return `<div class="section-title">旅程の区間から</div><div class="list">${legs.map((l) => { const T = TYPES[l.type]; return `<button class="row icon-row" data-leg data-from="${esc(l.from)}" data-to="${esc(l.to)}" data-when="${esc(l.start || '')}"><span class="ico" style="background:${T.color}">${I[T.icon]}</span><div class="grow">${esc(l.from)} → ${esc(l.to)}<div class="sub">${l.start ? l.start.replace('T', ' ') : ''} ${esc(l.title || '')}</div></div><span class="chev">${I.chev}</span></button>`; }).join('')}</div>`;
}

// ===== マップ =====
const NEARBY = [
  ['コンビニ', '🏪', 'nwr["shop"="convenience"]'],
  ['駅', '🚉', 'nwr["railway"="station"]'],
  ['トイレ', '🚻', 'nwr["amenity"="toilets"]'],
  ['ATM', '🏧', 'nwr["amenity"="atm"];nwr["amenity"="bank"]'],
  ['コインランドリー', '🧺', 'nwr["shop"="laundry"]'],
  ['銭湯・温泉', '♨️', 'nwr["amenity"="public_bath"]'],
  ['薬局', '💊', 'nwr["amenity"="pharmacy"]'],
  ['カフェ', '☕️', 'nwr["amenity"="cafe"]'],
  ['ロッカー', '🔐', 'nwr["amenity"="luggage_locker"];nwr["amenity"="locker"]'],
  ['観光案内所', 'ℹ️', 'nwr["tourism"="information"]["information"="office"]'],
];
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}
function drawMap(b) {
  b.innerHTML = `
    <div class="list" style="margin-bottom:10px"><div class="row">${I.search}<input type="text" id="mp-q" class="left" placeholder="場所を検索（例：京都駅）" enterkeyhint="search"></div></div>
    <div id="map" class="${isDark() ? 'map-dark' : ''}"></div>
    <div class="chips"><button class="chip" id="mp-me">${I.locate}現在地</button><button class="chip" id="mp-trip">${I.route}旅程の場所</button>${NEARBY.map((n, i) => `<button class="chip" data-near="${i}">${n[1]} ${n[0]}</button>`).join('')}</div>
    <div id="mp-list"></div>
    <div class="section-foot">地図 © OpenStreetMap 協力者。近くの施設は OpenStreetMap のデータから探します（載っていない店もあります）。</div>`;
  if (!window.L) { b.querySelector('#map').innerHTML = '<div class="empty">地図を読み込めませんでした</div>'; loadLeaflet().then(() => tab === 'map' && drawBody()); return; }
  const p = store.data.settings.place;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView(p ? [p.lat, p.lon] : [35.681, 139.767], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  locate(true);
  $('#mp-me').onclick = () => locate(false);
  $('#mp-trip').onclick = showTripPlaces;
  $$('[data-near]', b).forEach((x) => x.onclick = () => nearby(NEARBY[+x.dataset.near]));
  $('#mp-q').onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.target.blur();
    const r = await geocode(e.target.value);
    if (!r) { toast('見つかりませんでした'); return; }
    layer.clearLayers();
    addPin(r.lat, r.lon, '📍', e.target.value, '#FF3B30');
    map.setView([r.lat, r.lon], 16);
  };
}
function loadLeaflet() {
  return new Promise((res) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = res; s.onerror = res;
    document.head.append(s);
  });
}
async function locate(quiet) {
  try {
    const p = await getPosition();
    if (!map) return;
    const icon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    meMarker?.remove();
    meMarker = L.marker([p.lat, p.lon], { icon }).addTo(map);
    map.setView([p.lat, p.lon], 15);
  } catch { if (!quiet) toast('現在地を取得できませんでした（設定で位置情報を許可してください）'); }
}
function addPin(lat, lon, emoji, label, color = '#5856D6', extra = '') {
  const icon = L.divIcon({ className: '', html: `<div class="pin" style="background:${color}"><span>${emoji}</span></div>`, iconSize: [28, 28], iconAnchor: [14, 28] });
  L.marker([lat, lon], { icon }).addTo(layer).bindPopup(`<b>${esc(label)}</b>${extra}<br><a href="https://maps.apple.com/?daddr=${lat},${lon}" target="_blank">Apple マップで経路</a> ・ <a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank">Google</a>`);
}
// 地名 → 緯度経度（Nominatim）。結果は保存しておく
export async function geocode(q) {
  if (!q) return null;
  const c = store.data.geoCache;
  if (c[q]) return c[q];
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ja&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j[0]) return null;
    c[q] = { lat: +j[0].lat, lon: +j[0].lon };
    store.save();
    return c[q];
  } catch { return null; }
}
async function showTripPlaces() {
  const t = currentTrip();
  if (!t?.items.length) { toast('旅程に予定がありません'); return; }
  layer.clearLayers();
  toast('旅程の場所を探しています…');
  const pts = [];
  const seen = new Set();
  for (const it of [...t.items].sort((a, b) => (a.start || '').localeCompare(b.start || ''))) {
    const T = TYPES[it.type] || TYPES.other;
    const names = it.type === 'hotel' || !TRANSPORT.has(it.type) ? [it.address || it.title] : [it.from, it.to];
    for (const n of names) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      const r = await geocode(n);
      if (!r || !map) continue;
      addPin(r.lat, r.lon, it.type === 'hotel' ? '🛏️' : it.type === 'flight' ? '✈️' : TRANSPORT.has(it.type) ? '🚉' : '⭐️', n, T.color, `<br>${esc(it.title || '')}`);
      pts.push([r.lat, r.lon]);
      await new Promise((r) => setTimeout(r, 300)); // 検索サービスへの気づかい
    }
  }
  if (!map) return;
  if (pts.length > 1) { L.polyline(pts, { color: '#0A84FF', weight: 3, opacity: .6, dashArray: '6 8' }).addTo(layer); map.fitBounds(pts, { padding: [30, 30] }); }
  else if (pts.length) map.setView(pts[0], 14);
  else toast('場所が見つかりませんでした');
}
async function nearby([name, emoji, q]) {
  if (!map) return;
  const c = map.getCenter();
  toast(`${name}を探しています…`);
  const query = `[out:json][timeout:20];(${q.split(';').map((x) => `${x}(around:900,${c.lat},${c.lng});`).join('')});out center 40;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(query) });
    const j = await r.json();
    layer.clearLayers();
    const list = [];
    for (const e of j.elements) {
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      if (lat == null) continue;
      const label = e.tags?.name || e.tags?.brand || name;
      const dist = map.distance(c, [lat, lon]);
      list.push({ lat, lon, label, dist, hours: e.tags?.opening_hours });
      addPin(lat, lon, emoji, label, '#FF9500', e.tags?.opening_hours ? `<br>営業: ${esc(e.tags.opening_hours)}` : '');
    }
    list.sort((a, b) => a.dist - b.dist);
    $('#mp-list').innerHTML = list.length ? `<div class="list">${list.slice(0, 15).map((x) => `<a class="row" href="https://maps.apple.com/?daddr=${x.lat},${x.lon}&dirflg=w" target="_blank"><span>${emoji}</span><div class="grow">${esc(x.label)}${x.hours ? `<div class="sub">${esc(x.hours)}</div>` : ''}</div><span class="val small">${x.dist < 1000 ? Math.round(x.dist) + 'm' : (x.dist / 1000).toFixed(1) + 'km'}</span></a>`).join('')}</div>` : '<div class="empty">近くに見つかりませんでした</div>';
    toast(`${list.length}件見つかりました`);
  } catch { toast('探せませんでした（通信を確認してください）'); }
}

// ===== 運行情報 =====
const LINKS = [
  ['全国の運行情報（Yahoo!）', 'https://transit.yahoo.co.jp/diainfo', '#FF0033'],
  ['JR東日本', 'https://traininfo.jreast.co.jp/train_info/', '#2E8B57'],
  ['JR東海', 'https://traininfo.jr-central.co.jp/', '#F77F00'],
  ['JR西日本', 'https://trafficinfo.westjr.co.jp/list.html', '#0072BC'],
  ['JR九州', 'https://www.jrkyushu.co.jp/trains/info/', '#E60012'],
  ['JR北海道', 'https://www3.jrhokkaido.co.jp/webunkou/', '#3CB371'],
  ['JR四国', 'https://www.jr-shikoku.co.jp/info/', '#00A0DE'],
  ['東京メトロ', 'https://www.tokyometro.jp/unkou/', '#00A7DB'],
  ['ANA 運航状況', 'https://www.ana.co.jp/fs/dom/jp/', '#13448F'],
  ['JAL 運航状況', 'https://www.jal.co.jp/jp/ja/dom/', '#CC0000'],
];
let delayCache = null;
async function delays(force) {
  if (!force && delayCache && Date.now() - delayCache.t < 5 * 60000) return delayCache.list;
  const r = await fetch('https://tetsudo.rti-giken.jp/free/delay.json', { cache: 'no-store' });
  const list = await r.json();
  delayCache = { t: Date.now(), list };
  return list;
}
export async function tripDelays() {
  try {
    const list = await delays();
    const t = currentTrip();
    if (!t) return [];
    const words = t.items.flatMap((i) => [i.operator, i.title]).filter(Boolean).join(' ');
    return list.filter((l) => l.name && words.includes(l.name.replace(/線$/, '')));
  } catch { return []; }
}
function drawInfo(b) {
  const fav = store.data.favLines;
  b.innerHTML = `
    <div class="card"><h3>${I.warn} いま遅れている路線</h3><div id="dl-box"><span class="spinner"></span></div>
      <div class="list" style="margin-top:10px;background:var(--bg3)"><div class="row">${I.search}<input type="text" id="dl-q" class="left" placeholder="路線名でしぼりこむ（例：山手線）"></div></div></div>
    ${fav.length ? `<div class="section-title">お気に入りの路線</div><div class="list">${fav.map((f, i) => `<div class="row"><div class="grow">${esc(f)}</div><span class="val" id="fav-${i}"></span><button data-unfav="${i}" style="color:var(--red)">${I.trash}</button></div>`).join('')}</div>` : ''}
    <div class="section-title">公式の運行情報</div>
    <div class="list">${LINKS.map(([n, u, c]) => `<a class="row icon-row" href="${u}" target="_blank" rel="noopener"><span class="ico" style="background:${c}">${I.train}</span><div class="grow">${n}</div>${I.ext}</a>`).join('')}</div>
    <div class="section-foot">「いま遅れている路線」は、有志が公開している鉄道遅延情報（tetsudo.rti-giken.jp・各社の発表をもとに数分おきに更新）を表示しています。正確な情報は公式サイトでご確認ください。</div>`;
  let list = [];
  const draw = () => {
    const q = $('#dl-q')?.value.trim();
    const shown = q ? list.filter((l) => (l.name + l.company).includes(q)) : list;
    $('#dl-box').innerHTML = !list.length ? '<div class="small" style="color:var(--green)">遅延の発表はありません</div>'
      : `${q && !shown.length ? `<div class="small" style="color:var(--green)">「${esc(q)}」の遅延の発表はありません</div>` : ''}<div class="list" style="background:var(--bg3)">${shown.slice(0, 40).map((l) => `<div class="row delay-row"><span class="dot"></span><div class="grow">${esc(l.name)}<div class="sub">${esc(l.company)}</div></div><button class="small link-btn" data-fav="${esc(l.name)}">☆</button></div>`).join('')}</div>`;
    $$('[data-fav]', b).forEach((x) => x.onclick = () => { if (!fav.includes(x.dataset.fav)) { fav.push(x.dataset.fav); store.save(); toast('お気に入りに追加しました'); drawInfo(b); } });
  };
  delays().then((l) => {
    list = l;
    draw();
    fav.forEach((f, i) => { const e = $('#fav-' + i); if (e) e.innerHTML = l.some((x) => x.name === f) ? '<span class="badge ng">遅延あり</span>' : '<span class="badge ok">平常</span>'; });
  }).catch(() => { $('#dl-box').innerHTML = '<div class="small muted">遅延情報を取得できませんでした。公式の運行情報をご確認ください。</div>'; });
  $('#dl-q').oninput = draw;
  $$('[data-unfav]', b).forEach((x) => x.onclick = () => { fav.splice(+x.dataset.unfav, 1); store.save(); drawInfo(b); });
}

// ===== スポット検索（名前を入れるだけで、住所・営業時間・電話などを自動入力） =====
const CAT = (c, t) => {
  if (['hotel', 'hostel', 'guest_house', 'motel', 'apartment', 'camp_site'].includes(t)) return 'hotel';
  if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream'].includes(t)) return 'meal';
  if (t === 'aerodrome' || c === 'aeroway') return 'flight';
  if (['station', 'halt', 'stop'].includes(t) || c === 'railway') return 'train';
  if (t === 'bus_station' || t === 'bus_stop') return 'bus';
  if (t === 'ferry_terminal') return 'ferry';
  return 'activity';
};
export async function spotSearch(q, near) {
  const p = new URLSearchParams({ format: 'jsonv2', q, limit: 8, 'accept-language': 'ja', extratags: 1, addressdetails: 1, namedetails: 1 });
  if (near) p.set('viewbox', `${near.lon - 0.5},${near.lat + 0.5},${near.lon + 0.5},${near.lat - 0.5}`);
  const j = await (await fetch(`https://nominatim.openstreetmap.org/search?${p}`)).json();
  return j.map((x) => {
    const a = x.address || {};
    const addr = [a.province || a.state, a.city || a.town || a.village, a.city_district || a.suburb, a.quarter || a.neighbourhood, a.road, a.house_number].filter(Boolean).join('');
    const ex = x.extratags || {};
    return {
      name: x.namedetails?.['name:ja'] || x.name || x.display_name.split(',')[0],
      address: addr || x.display_name, lat: +x.lat, lon: +x.lon,
      hours: ex.opening_hours || '', phone: ex.phone || ex['contact:phone'] || '', website: ex.website || ex['contact:website'] || '',
      fee: ex.fee || ex.charge || '', type: CAT(x.category, x.type), kind: x.type,
    };
  });
}
// 2地点のおおよその移動時間（直線距離から推定）
export function roughMove(a, b) {
  const R = 6371e3, rad = Math.PI / 180;
  const d = 2 * R * Math.asin(Math.sqrt(Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2));
  const walk = (d * 1.3) / 75; // 分（分速75m・道のりは直線の1.3倍）
  const ride = (d * 1.4) / 500 + 10; // 電車・バスのおおよそ（分速500m＋待ち10分）
  return { m: d, walkMin: Math.round(walk), rideMin: Math.round(ride), best: d < 1500 ? `徒歩 約${Math.round(walk)}分` : `電車など 約${Math.round(ride)}分` };
}
export function distText(m) { return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`; }
