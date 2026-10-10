// 共通の道具：データの保存・画面部品（シート／ページ／確認）・書式
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n) => String(n).padStart(2, '0');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const WD = ['日', '月', '火', '水', '木', '金', '土'];

// ===== 日時 =====
// 旅程の時刻は「YYYY-MM-DDTHH:MM」（その土地の時刻）で持つ
export function toLocalISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function parseLocal(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
export const hm = (d) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const mdw = (d) => `${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`;
export function dur(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const s = d ? `${d}日${h}時間` : h ? `${h}時間${mm ? mm + '分' : ''}` : `${mm}分`;
  return neg ? '-' + s : s;
}
export function countdown(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
export const yen = (n, cur = 'JPY') => {
  try { return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: cur, maximumFractionDigits: cur === 'JPY' ? 0 : 2 }).format(n); }
  catch { return `${n} ${cur}`; }
};

// ===== 保存（小さなデータは localStorage、画像や音は IndexedDB） =====
const KEY = 'tabinavi.v1';
const DEFAULT = {
  settings: {
    theme: 'auto', showSeconds: true,
    apiKey: '', aiModel: 'claude-opus-5-5',
    place: null, // {name, lat, lon}（null は現在地）
    alarmMode: 'saver', // saver=イヤホン節電（画面オンで待機） / stream=確実（無音を流して待機）
    earMic: false, // マイクの一覧でイヤホンを確かめる
    requireEar: true,
    homeCurrency: 'JPY',
  },
  alarms: [],
  trips: [],
  currentTrip: null,
  checklist: null,
  expenses: [],
  memos: [],
  wishlist: [],
  budget: { people: 1, limit: 0, currency: 'JPY' },
  fired: {},
  emergency: '',
  social: { name: '', room: '', firebase: '', share: false },
  recentRoutes: [],
  favLines: [],
  geoCache: {},
};
export const store = {
  data: null,
  load() {
    try { this.data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { this.data = {}; }
    for (const [k, v] of Object.entries(DEFAULT)) {
      if (this.data[k] === undefined) this.data[k] = structuredClone(v);
    }
    this.data.settings = { ...DEFAULT.settings, ...this.data.settings };
    return this.data;
  },
  save(remote = false) {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); }
    catch (e) { toast('保存できませんでした（容量がいっぱいかもしれません）'); }
    for (const fn of listeners) fn(remote);
  },
  reset() { localStorage.removeItem(KEY); this.load(); },
};
const listeners = new Set();
export const onSave = (fn) => listeners.add(fn);

let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('tabinavi', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('blobs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export const blobs = {
  async put(key, val) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('blobs', 'readwrite'); t.objectStore('blobs').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
  async get(key) { const d = await db(); return new Promise((res, rej) => { const r = d.transaction('blobs').objectStore('blobs').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async del(key) { const d = await db(); return new Promise((res) => { const t = d.transaction('blobs', 'readwrite'); t.objectStore('blobs').delete(key); t.oncomplete = res; }); },
  async keys() { const d = await db(); return new Promise((res) => { const r = d.transaction('blobs').objectStore('blobs').getAllKeys(); r.onsuccess = () => res(r.result); }); },
};

// ===== 画面部品 =====
let toastTimer;
export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
export function haptic() { try { navigator.vibrate?.(8); } catch {} }

function backdrop(onClick) {
  const b = document.createElement('div');
  b.className = 'backdrop';
  if (onClick) b.addEventListener('click', onClick);
  $('#layers').append(b);
  requestAnimationFrame(() => b.classList.add('show'));
  return b;
}

// 下から出るシート。build(body, close) で中身を作る
export function sheet({ title, left = 'キャンセル', right = '', onRight, build, onClose }) {
  const bd = backdrop(() => close());
  const el = document.createElement('div');
  el.className = 'sheet';
  el.innerHTML = `<div class="grabber"></div><div class="sheet-head"><button class="l">${esc(left)}</button><h2>${esc(title || '')}</h2><button class="r">${esc(right)}</button></div><div class="sheet-body"></div>`;
  $('#layers').append(el);
  const body = $('.sheet-body', el);
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    el.classList.remove('show'); bd.classList.remove('show');
    setTimeout(() => { el.remove(); bd.remove(); }, 420);
    onClose?.();
  }
  $('.l', el).onclick = close;
  $('.r', el).onclick = async () => { if (!onRight || (await onRight(body, close)) !== false) close(); };
  if (!right) $('.r', el).style.visibility = 'hidden';
  build?.(body, close);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  // つまみを下へ引いて閉じる
  let y0 = null, dy = 0;
  const head = $('.sheet-head', el), grab = $('.grabber', el);
  for (const h of [head, grab]) {
    h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; el.style.transition = 'none'; }, { passive: true });
    h.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); el.style.transform = `translateY(${dy}px)`; }, { passive: true });
    h.addEventListener('touchend', () => { el.style.transition = ''; el.style.transform = ''; if (dy > 110) close(); y0 = null; dy = 0; });
  }
  return { el, body, close };
}

// 右から押し出すページ
export function page({ title, right = '', onRight, build, onClose }) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `<div class="page-head"><button class="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>戻る</button><h2>${esc(title)}</h2><div class="right">${right}</div></div><div class="page-body"></div>`;
  $('#layers').append(el);
  const body = $('.page-body', el);
  function close() { el.classList.remove('show'); setTimeout(() => el.remove(), 420); onClose?.(); }
  $('.back', el).onclick = close;
  if (onRight) $('.right', el).onclick = () => onRight(body, close);
  build?.(body, close);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  // 左端から右へなぞって戻る
  let x0 = null, dx = 0;
  el.addEventListener('touchstart', (e) => { if (e.touches[0].clientX < 24) { x0 = e.touches[0].clientX; el.style.transition = 'none'; } }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (x0 == null) return; dx = Math.max(0, e.touches[0].clientX - x0); el.style.transform = `translateX(${dx}px)`; }, { passive: true });
  el.addEventListener('touchend', () => { if (x0 == null) return; el.style.transition = ''; el.style.transform = ''; if (dx > 90) close(); x0 = null; dx = 0; });
  return { el, body, close };
}

export function confirmBox(title, msg = '', ok = 'OK', { destructive = false, cancel = 'キャンセル' } = {}) {
  return new Promise((res) => {
    const bd = backdrop();
    bd.style.zIndex = 499;
    const el = document.createElement('div');
    el.className = 'alert';
    el.innerHTML = `<div class="body"><b>${esc(title)}</b><p>${esc(msg)}</p></div><div class="btns">${cancel ? `<button class="c">${esc(cancel)}</button>` : ''}<button class="o ${destructive ? 'destructive' : ''}">${esc(ok)}</button></div>`;
    $('#layers').append(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const done = (v) => { el.classList.remove('show'); bd.classList.remove('show'); setTimeout(() => { el.remove(); bd.remove(); }, 250); res(v); };
    $('.o', el).onclick = () => done(true);
    if (cancel) $('.c', el).onclick = () => done(false);
  });
}

// セグメント（切り替えボタン）の動く背景
export function segment(el, onChange) {
  const btns = $$('button', el);
  let thumb = $('.thumb', el);
  if (!thumb) { thumb = document.createElement('i'); thumb.className = 'thumb'; el.prepend(thumb); }
  const place = () => {
    const a = btns.find((b) => b.classList.contains('active')) || btns[0];
    thumb.style.left = a.offsetLeft + 'px';
    thumb.style.width = a.offsetWidth + 'px';
  };
  btns.forEach((b) => b.addEventListener('click', () => {
    btns.forEach((x) => x.classList.toggle('active', x === b)); place(); haptic(); onChange?.(b.dataset.v);
  }));
  requestAnimationFrame(place);
  setTimeout(place, 350);
}

export function switchHTML(name, on, attrs = '') {
  return `<label class="switch"><input type="checkbox" ${name ? `name="${name}"` : ''} ${on ? 'checked' : ''} ${attrs}><span></span></label>`;
}

// ===== 絵（SF Symbols 風の線画） =====
export const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  train: '<svg viewBox="0 0 24 24"><path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 14h.01M16 14h.01M8 17l-2.5 4M16 17l2.5 4"/></svg>',
  shinkansen: '<svg viewBox="0 0 24 24"><path d="M3 15c0-5 4-9 10-9h5a3 3 0 0 1 3 3v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM13 6v5h8M3 20h18"/></svg>',
  subway: '<svg viewBox="0 0 24 24"><circle cx="12" cy="11" r="8"/><path d="M8 15V8l4 5 4-5v7M8 21l1.5-2.5M16 21l-1.5-2.5"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><path d="M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2zM4 11h16M7 17v3M17 17v3M7.5 14h.01M16.5 14h.01"/></svg>',
  gondola: '<svg viewBox="0 0 24 24"><path d="M3 4l18 3M12 5.5V9M6 9h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM4 14h16M9 9v5M15 9v5"/></svg>',
  plane: '<svg viewBox="0 0 24 24"><path d="M21 15.5v-2l-8-5V4a1.5 1.5 0 0 0-3 0v4.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z"/></svg>',
  ship: '<svg viewBox="0 0 24 24"><path d="M3 17l2 3h14l2-3-9-3zM6 15V9h12v6M9 9V5h6v4M2 21c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1"/></svg>',
  car: '<svg viewBox="0 0 24 24"><path d="M5 17h14v-5l-2-5H7l-2 5zM5 12h14M7 17v2M17 17v2M8 14.5h.01M16 14.5h.01"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M10 21l2-6 3 3v3M9 12l1-4 4 2 2 3M8 9l-2 4"/></svg>',
  bed: '<svg viewBox="0 0 24 24"><path d="M3 18V6M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5a1.5 1.5 0 1 0 0-.01"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 0-3 3-3 6s1 4 3 4v8"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><path d="M6 12h.01M12 12h.01M18 12h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alarm: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4.5l3 2M4 4.5 6.5 2.5M20 4.5l-2.5-2"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5V4l-6 2.5zm0 0v14m6-11.5v14"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
  route: '<svg viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h8"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20zM12 10v4M12 17h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  bag: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  yen: '<svg viewBox="0 0 24 24"><path d="M6 4l6 8 6-8M12 12v8M8 13h8M8 16.5h8"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14.5h.01"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  headphones: '<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>',
  locate: '<svg viewBox="0 0 24 24"><path d="M21 3 3 10.5l7.5 3 3 7.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24"><path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 20V9M7 14l5-5 5 5M5 4h14"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  wifi: '<svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

// 乗り物・予定の種類（色分け）
export const TYPES = {
  shinkansen: { name: '新幹線', color: '#0A84FF', icon: 'shinkansen' },
  train: { name: '電車', color: '#34C759', icon: 'train' },
  subway: { name: '地下鉄', color: '#00A6A6', icon: 'subway' },
  bus: { name: 'バス', color: '#FF9500', icon: 'bus' },
  flight: { name: '飛行機', color: '#5856D6', icon: 'plane' },
  ferry: { name: '船', color: '#32ADE6', icon: 'ship' },
  ropeway: { name: 'ロープウェイ', color: '#30B0C7', icon: 'gondola' },
  taxi: { name: 'タクシー・車', color: '#E0A800', icon: 'car' },
  walk: { name: '徒歩', color: '#8E8E93', icon: 'walk' },
  hotel: { name: '宿泊', color: '#AF52DE', icon: 'bed' },
  activity: { name: '観光・予定', color: '#FF2D55', icon: 'star' },
  meal: { name: '食事', color: '#A2845E', icon: 'food' },
  other: { name: 'その他', color: '#636366', icon: 'dots' },
};
export const TRANSPORT = new Set(['shinkansen', 'train', 'subway', 'bus', 'flight', 'ferry', 'ropeway', 'taxi', 'walk']);
// 予約が要る（予約チェックを出す）予定か：新幹線・飛行機・船・宿、特急や高速バスなど
export const needsResv = (it) => !!it && (it.reserved || ['shinkansen', 'flight', 'ferry', 'hotel'].includes(it.type)
  || (['train', 'bus'].includes(it.type) && /号|特急|高速|夜行|ライナー|指定|予約/.test(`${it.title || ''} ${it.number || ''} ${it.notes || ''}`)));

export function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
// 画像を長い辺 maxSide に縮めて JPEG にする（送る量を減らす）
export async function shrinkImage(file, maxSide = 1600, q = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
export function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
}
export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('コピーしました'); } catch { toast('コピーできませんでした'); }
}
