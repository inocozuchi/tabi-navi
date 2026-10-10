// 旅程：時系列の一覧・予約チェック・予備ルート・編集
import { $, $$, esc, uid, store, sheet, page, toast, confirmBox, switchHTML, haptic, I, TYPES, TRANSPORT, needsResv, askText, parseLocal, hm, dayKey, mdw, dur, countdown, yen, copyText, blobs, download, segment, toLocalISO } from './util.js';
import { openImport, openPaste } from './ai.js';
import { heroHTML, drawWeather, statusHTML, afterStatus, dayWeather, tickHome, tickStatus } from './home.js';
import { transitLinks, mapsSearchUrl, spotSearch } from './transit.js';
import { icsDownload } from './tools.js';
import { detectGaps, suggestSpotsForGap, autoOptimizeSchedule, getRecommendedTransferTime } from './planner.js';
import { openShiori } from './shiori.js';

const el = () => $('#view-trip');
let filter = 'all';
let selectedDay = 'all';

export function currentTrip() {
  const d = store.data;
  let t = d.trips.find((x) => x.id === d.currentTrip);
  if (!t && d.trips.length) { t = d.trips[0]; d.currentTrip = t.id; }
  return t || null;
}
export function ensureTrip(name) {
  let t = currentTrip();
  if (!t) {
    t = { id: uid(), name: name || '新しい旅', items: [] };
    store.data.trips.push(t); store.data.currentTrip = t.id; store.save();
  }
  return t;
}

// 一覧に並べる「出来事」（宿泊はチェックインとチェックアウトの2つ）
export function events(trip) {
  const out = [];
  for (const it of trip?.items || []) {
    const s = parseLocal(it.start), e = parseLocal(it.end);
    if (it.type === 'hotel') {
      if (s) out.push({ it, at: s, end: s, kind: 'in' });
      if (e) out.push({ it, at: e, end: e, kind: 'out' });
      if (!s && !e) out.push({ it, at: null, kind: 'in' });
    } else out.push({ it, at: s, end: e || s, kind: '' });
  }
  return out.sort((a, b) => (a.at?.getTime() ?? 9e15) - (b.at?.getTime() ?? 9e15));
}
export function nextEvent(now = new Date()) {
  const t = currentTrip();
  if (!t) return null;
  const evs = events(t).filter((e) => e.at);
  const cur = evs.find((e) => e.at <= now && e.end > now && e.kind === '');
  const nx = evs.find((e) => e.at > now);
  return { cur, nx };
}

function itemTitle(it, kind) {
  if (it.type === 'hotel') return `${kind === 'out' ? 'チェックアウト' : 'チェックイン'}：${it.title || '宿'}`;
  return it.title || [it.operator, it.number].filter(Boolean).join(' ') || TYPES[it.type]?.name || '予定';
}

export function renderTrip() {
  const d = store.data;
  const t = currentTrip();
  const now = new Date();
  if (!t) {
    el().innerHTML = `${titleHTML(false)}${heroHTML()}${statusHTML()}
      <div class="start-card">
        <div class="start-emoji">🧳</div>
        <h2>旅程をつくりましょう</h2>
        <p>旅をつくって、予約メールや旅程表を取り込むだけ。<br>時間順に並べて、いまの予定を教えます。</p>
        <button class="btn big-cta" data-act="newtrip">${I.plus}新しい旅をつくる</button>
        <div class="steps"><span><b>1</b>旅をつくる</span><i></i><span><b>2</b>取り込む</span><i></i><span><b>3</b>完成</span></div>
      </div>
      <div class="section-title">すぐ取り込む（旅も自動でつくります）</div>
      ${buildTiles(true)}`;
    drawWeather();
    return;
  }
  const evs = events(t);
  const items = t.items;
  const resvItems = items.filter(needsResv);
  const resv = resvItems.filter((i) => i.reserved).length;
  const cost = items.reduce((s, i) => s + (parseFloat(String(i.cost || '').replace(/[^\d.]/g, '')) || 0), 0);
  const nxt = nextEvent(now);

  // 日付一覧を抽出
  const dayKeys = [...new Set(evs.filter((e) => e.at).map((e) => dayKey(e.at)))];
  if (selectedDay !== 'all' && !dayKeys.includes(selectedDay) && dayKeys.length) {
    selectedDay = 'all';
  }

  // フィルタと日別選択の適用
  const shown = evs.filter((e) => {
    if (selectedDay !== 'all' && e.at && dayKey(e.at) !== selectedDay) return false;
    if (filter === 'unres' && (e.it.reserved || !needsResv(e.it))) return false;
    if (filter === 'move' && !TRANSPORT.has(e.it.type)) return false;
    if (filter === 'stay' && e.it.type !== 'hotel') return false;
    if (filter === 'alt' && !e.it.alternates?.length) return false;
    return true;
  });

  const firstAt = evs.find((e) => e.at)?.at, lastAt = [...evs].reverse().find((e) => e.at)?.at;
  const nDays = dayKeys.length;
  const ts = t.start && parseLocal(t.start + 'T00:00'), te = t.end && parseLocal(t.end + 'T00:00');
  let html = `${titleHTML(true)}${heroHTML()}${statusHTML()}
    <div class="trip-card" data-act="trips" role="button" tabindex="0">
      <div class="tc-top">
        <div class="tc-name-wrap"><div class="tc-eyebrow">表示中の旅${d.trips.length > 1 ? `・全${d.trips.length}件` : ''}</div><div class="tc-name">${esc(t.name || '旅')}<span class="tc-chev">${I.chev}</span></div></div>
        <button class="tc-new" data-act="newtrip" aria-label="新しい旅をつくる">${I.plus}<span>新しい旅</span></button>
      </div>
      <div class="tc-meta">${firstAt ? `${mdw(firstAt)}${lastAt && dayKey(lastAt) !== dayKey(firstAt) ? ` 〜 ${mdw(lastAt)}` : ''}・${nDays}日間` : ts ? `${mdw(ts)}${te && +te !== +ts ? ` 〜 ${mdw(te)}` : ''}` : '日付はまだありません'}</div>
      <div class="tc-stats">
        <div><b>${items.length}</b><span>予定</span></div>
        <div><b style="color:${!resvItems.length ? 'var(--label3)' : resv === resvItems.length ? 'var(--green)' : 'var(--orange)'}">${resvItems.length ? `${resv}/${resvItems.length}` : '—'}</b><span>予約済み</span></div>
        <div><b>${cost ? yen(cost) : '—'}</b><span>費用の合計</span></div>
      </div>
    </div>
    ${buildTiles(false)}
    <div class="section-head">
      <h2>スケジュール</h2>
      <div class="actions"><button class="text-btn" data-act="addmenu">${I.plus}予定を追加</button></div>
    </div>
    <!-- 1日ごとのタイムライン切替タブ -->
    ${dayKeys.length > 1 ? `
    <div class="day-tabs sticky">
      <button class="day-tab ${selectedDay === 'all' ? 'active' : ''}" data-day="all">すべて (${dayKeys.length}日間)</button>
      ${dayKeys.map((dk, idx) => {
        const dObj = parseLocal(dk);
        return `<button class="day-tab ${selectedDay === dk ? 'active' : ''}" data-day="${dk}">Day ${idx + 1} <small>${dObj.getMonth() + 1}/${dObj.getDate()}</small></button>`;
      }).join('')}
    </div>` : ''}

    <div class="chips">${[['all', 'すべて'], ['unres', '未予約'], ['move', '移動'], ['stay', '宿泊'], ['alt', '予備ルートあり']].map(([k, n]) => `<button class="chip ${filter === k ? 'on' : ''}" data-filter="${k}">${n}</button>`).join('')}</div>`;

  if (!items.length) html += `<div class="empty-card"><div class="ec-ico">${I.route}</div><b>まだ予定がありません</b><span>上の「写真・PDF」や「文字を貼る」から取り込むか、手入力で追加できます。</span><button class="btn small" data-act="addmenu">${I.plus}予定を追加</button></div>`;

  let lastDay = '', nowPlaced = false, prev = null;
  const noTime = shown.filter((e) => !e.at);
  html += '<div class="tl">';

  const timedEvents = shown.filter((x) => x.at);
  for (let idx = 0; idx < timedEvents.length; idx++) {
    const e = timedEvents[idx];
    const dk = dayKey(e.at);
    if (dk !== lastDay) {
      if (!nowPlaced && lastDay && dayKey(now) === lastDay) { html += nowLine(now); nowPlaced = true; }
      const dayEvs = evs.filter((x) => x.at && dayKey(x.at) === dk);
      const dayMoves = dayEvs.filter((x) => TRANSPORT.has(x.it.type)).length;
      html += `<div class="day-head ${dk === dayKey(now) ? 'today' : ''}" style="margin-left:-64px">
        <span>${mdw(e.at)}</span>
        <small>${dayIndex(evs, e.at)}・${dayEvs.length}件${dayMoves ? ` (${dayMoves}移動)` : ''}</small>
        <span class="day-wx" data-day="${dk}"></span>
      </div>`;
      lastDay = dk; prev = null;
    }
    if (!nowPlaced && e.at > now && dayKey(now) === dk) { html += nowLine(now); nowPlaced = true; }

    // 前の予定との間の乗り換え時間または空き時間の表示
    if (prev && prev.end && e.at > prev.end - 1 && dayKey(prev.end) === dk) {
      const gapMin = Math.round((e.at - prev.end) / 60000);
      const isBothMove = TRANSPORT.has(prev.it.type) && TRANSPORT.has(e.it.type);
      const recTransfer = getRecommendedTransferTime(prev.it, e.it);

      if (isBothMove && gapMin < 180) {
        // 乗り換え表示
        const isShort = gapMin < recTransfer;
        html += `<div class="gap-note ${isShort ? 'warn' : 'ok'}">
          ${isShort ? I.warn : I.walk} 乗り換え ${gapMin}分${isShort ? `（${recTransfer}分以上を推奨）` : '（余裕あり）'}
        </div>`;
      } else if (gapMin >= 30) {
        // 30分以上の空き時間スロット
        const loc = prev.it.to || prev.it.address || prev.it.title || e.it.from || '';
        // 短い空き（90分未満）は控えめに1行で、長い空きは「おすすめを探す」を大きく出す
        html += `<div class="gap-slot ${gapMin < 90 ? 'compact' : ''}" data-gap-start="${prev.end.toISOString()}" data-gap-end="${e.at.toISOString()}" data-gap-loc="${esc(loc)}" data-gap-min="${gapMin}">
          <div class="gap-info">${I.clock} <span>空き時間 ${gapMin >= 60 ? `${Math.floor(gapMin / 60)}時間${gapMin % 60 ? (gapMin % 60) + '分' : ''}` : `${gapMin}分`}</span></div>
          <button class="gap-add-btn" data-act="suggest-spot">${I.sparkles}${gapMin < 90 ? '探す' : 'おすすめを探す'}</button>
        </div>`;
      }
    }

    html += evHTML(e, now);
    prev = e;
  }
  html += '</div>';

  if (noTime.length && (selectedDay === 'all')) {
    html += `<div class="section-title">日時が未定</div><div class="tl">${noTime.map((e) => evHTML(e, now)).join('')}</div>`;
  }
  html += `<div class="now-jump-wrap"><button class="now-jump" data-act="nowjump" aria-label="いまの予定へ">${I.clock}<span>いまの予定へ</span></button></div>`;
  el().innerHTML = html;
  drawWeather();
  afterStatus();
  dayWeather(t);
  updateNowJump();
}

// 上の時計の部分：スクロールに合わせて少しゆっくり動き、薄くなる（iOS の大きい見出しのように）
function parallax() {
  const h = $('#hero', el());
  if (!h) return;
  const y = Math.max(0, el().scrollTop);
  if (y > 420) return;
  h.style.transform = y ? `translate3d(0, ${y * 0.28}px, 0) scale(${1 - Math.min(y, 300) / 3000})` : '';
  h.style.opacity = y ? String(Math.max(0.15, 1 - y / 380)) : '';
}

// いま（進行中・次）の予定が画面の外にある時だけ「いまの予定へ」を出す
function nowTarget() {
  return $('.now-line', el()) || $('.tl-item.current', el()) || $('.tl-item:not(.past)', el());
}
function updateNowJump() {
  const b = $('.now-jump', el());
  if (!b) return;
  const tg = nowTarget();
  const r = tg?.getBoundingClientRect(), v = el().getBoundingClientRect();
  // スケジュールの所まで下りてきた時だけ（上のカードに重ならないように）
  const tl = $('.tl', el());
  const inTl = !!tl && tl.getBoundingClientRect().top < v.top + v.height * 0.45;
  const off = inTl && !!r && (r.bottom < v.top + 80 || r.top > v.bottom - 140) && $('.tl-item.past', el());
  b.classList.toggle('show', !!off);
  if (r) b.classList.toggle('up', r.bottom < v.top + 80);
}

// いちばん上：日付と大きな見出し（iOS の大きいタイトル）
function titleHTML(hasTrip) {
  const n = new Date();
  return `<header class="large-title home"><div><div class="eyebrow">${n.getMonth() + 1}月${n.getDate()}日 ${'日月火水木金土'[n.getDay()]}曜日</div><h1>旅程</h1></div>
    <div class="actions">${hasTrip ? `<button class="icon-btn" data-act="menu" aria-label="旅のメニュー">${I.dots}</button>` : ''}<button class="icon-btn filled" data-act="${hasTrip ? 'addmenu' : 'newtrip'}" aria-label="${hasTrip ? '予定を追加' : '新しい旅をつくる'}">${I.plus}</button></div></header>`;
}

// 旅程をつくる・ふやす入口（はじめは大きいタイル、旅がある時は横に並ぶ小さいタイル）
const TILES = [
  ['import', '写真・PDF', '旅程表・スクショ', 'var(--indigo)', 'photo', true],
  ['paste', '文字を貼る', '予約メール・メモ', 'var(--blue)', 'copy'],
  ['add', '手入力', '1件ずつ追加', 'var(--green)', 'edit'],
  ['wish', '行きたい場所', 'リストから組み立て', 'var(--pink)', 'star'],
  ['optimize', '自動調整', '空き時間・乗換', 'var(--purple)', 'sparkles', false, true],
  ['pdf', 'しおり', '印刷・PDF', 'var(--orange)', 'note', false, true],
];
function buildTiles(big) {
  const list = TILES.filter((x) => big ? !x[6] : true);
  return big
    ? `<div class="tile-grid">${list.map(([k, n, sub, c, ic, rec], i) => `<button class="tile" data-act="${k}" style="--c:${c};--i:${i}">${rec ? '<span class="tile-rec">おすすめ</span>' : ''}<span class="tile-ico">${I[ic]}</span><b>${n}</b><span class="tile-sub">${sub}</span></button>`).join('')}</div>`
    : `<div class="section-head small"><h3>つくる・ふやす</h3></div><div class="tile-row">${list.map(([k, n, , c, ic], i) => `<button class="tile-s" data-act="${k}" style="--c:${c};--i:${i}"><span class="tile-ico">${I[ic]}</span><span>${n}</span></button>`).join('')}</div>`;
}
// 旅の切り替え
function tripSwitcher() {
  sheet({
    title: '旅を選ぶ', left: '閉じる',
    build(body, close) {
      const d = store.data;
      body.innerHTML = `<button class="btn" data-new style="margin-bottom:14px">${I.plus}新しい旅をつくる</button>
      <div class="section-title" style="margin-top:4px">旅の一覧</div>
      <div class="list">${d.trips.map((x) => {
        const ev = events(x).filter((e) => e.at);
        const a = ev[0]?.at || (x.start && parseLocal(x.start + 'T00:00')), z = ev[ev.length - 1]?.at || (x.end && parseLocal(x.end + 'T00:00'));
        return `<button class="row icon-row" data-trip="${x.id}"><span class="ico" style="background:${x.id === d.currentTrip ? 'var(--blue)' : 'var(--gray)'}">${I.route}</span><div class="grow">${esc(x.name || '旅')}<div class="sub">${a ? `${mdw(a)}${z && dayKey(z) !== dayKey(a) ? '〜' + mdw(z) : ''}・` : ''}予定${x.items.length}件</div></div>${x.id === d.currentTrip ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button>`;
      }).join('')}</div>
      <div class="list" style="margin-top:14px"><button class="row icon-row" data-menu><span class="ico" style="background:var(--gray)">${I.dots}</span><div class="grow">この旅の設定<div class="sub">名前・しおり・共有・削除など</div></div><span class="chev">${I.chev}</span></button></div>`;
      $$('[data-trip]', body).forEach((b) => b.onclick = () => { d.currentTrip = b.dataset.trip; selectedDay = 'all'; store.save(); haptic(); close(); renderTrip(); el().scrollTo({ top: 0, behavior: 'smooth' }); });
      $('[data-new]', body).onclick = () => { close(); setTimeout(() => newTrip(), 300); };
      $('[data-menu]', body).onclick = () => { close(); setTimeout(tripMenu, 250); };
    },
  });
}

function dayIndex(evs, at) {
  const first = evs.find((e) => e.at)?.at;
  if (!first) return '';
  const n = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()) - new Date(first.getFullYear(), first.getMonth(), first.getDate())) / 864e5) + 1;
  return `${n}日目`;
}
function nowLine(now) { return `<div class="now-line"><span class="pill">いま ${hm(now)}</span></div>`; }
export function nextText(nxt, now) {
  if (!nxt) return '';
  const parts = [];
  if (nxt.cur) parts.push(`<b>移動中</b> ${esc(itemTitle(nxt.cur.it))}・到着まで ${dur(nxt.cur.end - now)}`);
  if (nxt.nx) parts.push(`次: ${esc(itemTitle(nxt.nx.it, nxt.nx.kind))} まで <b class="mono">${countdown(nxt.nx.at - now)}</b>`);
  return parts.join('<br>') || '<span class="muted">これからの予定はありません</span>';
}

function evHTML(e, now) {
  const it = e.it, T = TYPES[it.type] || TYPES.other;
  const past = e.at && (e.end || e.at) < now;
  const cur = e.at && e.kind === '' && e.at <= now && e.end > now;
  const meta = [];
  if (it.type !== 'hotel' || e.kind === 'in') {
    if (it.platform) meta.push(`<span class="badge">${esc(it.platform)}</span>`);
    if (it.seat) meta.push(`<span class="badge">座席 ${esc(it.seat)}</span>`);
    if (it.room) meta.push(`<span class="badge">${I.bed} ${esc(it.room)}</span>`);
    if (it.cost) meta.push(`<span class="badge">${esc(it.cost)}</span>`);
    if (it.confirmation) meta.push(`<span class="badge" data-act="copyconf" style="cursor:pointer">${I.copy} ${esc(it.confirmation)}</span>`);
  }
  const resv = !needsResv(it) ? '' : it.reserved ? `<span class="badge ok res-toggle" data-act="res">${I.check} 予約済み</span>` : `<span class="badge ng res-toggle" data-act="res">未予約</span>`;
  const title = itemTitle(it, e.kind);
  const addr = it.address && it.address !== it.title && !title.includes(it.address) ? it.address : '';
  const sub = e.kind === 'out' ? '' : (e.end && +e.end !== +e.at && it.type !== 'hotel') ? `<small>〜${hm(e.end)}</small>` : '';
  const isMove = TRANSPORT.has(it.type);
  return `<div class="tl-item ${past ? 'past' : ''} ${cur ? 'current' : ''}" style="--c:${T.color}" data-id="${it.id}">
    <div class="time">${e.at ? hm(e.at) : '--:--'}${sub}</div><div class="line"></div><div class="dot"></div>
    <div class="ev" data-act="open">
      <div class="top"><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(title)}</div>${resv}</div>
      ${isMove && (it.from || it.to) ? `<div class="route"><span>${esc(it.from || '?')}</span><span class="arrow">→</span><span>${esc(it.to || '?')}</span>${e.end && e.at && it.type !== 'hotel' ? `<span class="muted small" style="margin-left:auto">${dur(e.end - e.at)}</span>` : ''}</div>` : ''}
      ${!isMove && addr && e.kind !== 'out' ? `<div class="ev-addr">${I.pin}<span>${esc(addr)}</span></div>` : ''}
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      ${it.notes && e.kind !== 'out' ? `<div class="ev-notes" data-act="more">${esc(it.notes)}</div>` : ''}
      ${it.alternates?.length && e.kind !== 'out' ? `<div class="alt-box"><div class="alt-title">${I.route} 予備ルート ${it.alternates.length}件</div>${it.alternates.map((r) => `<div style="margin-bottom:6px"><div class="hstack"><b class="small">${esc(r.name || '予備')}</b><span class="spacer"></span><button class="link-btn small" data-act="swap" data-alt="${r.id}">このルートに切替</button></div>${r.legs.map((l) => `<div class="alt-leg"><span class="lt">${hm(parseLocal(l.start))}${l.end ? '→' + hm(parseLocal(l.end)) : ''}</span><span style="color:${(TYPES[l.type] || TYPES.other).color}">${I[(TYPES[l.type] || TYPES.other).icon]}</span><span class="small">${esc(l.title || '')} ${esc(l.from || '')}${l.to ? '→' + esc(l.to) : ''}</span></div>`).join('')}</div>`).join('')}</div>` : ''}
      ${e.kind !== 'out' ? `<div class="acts">
        ${isMove && it.from && it.to ? `<button data-act="transit">${I.route}乗換案内</button>` : ''}
        ${it.type === 'flight' && it.number ? `<a href="https://www.google.com/search?q=${encodeURIComponent(it.number.replace(/\s/g, '') + ' 運航状況')}" target="_blank" rel="noopener">${I.plane}運航状況</a>` : ''}
        ${(it.address || it.to || it.title) ? `<a href="${mapsSearchUrl(it.type === 'hotel' || !isMove ? (it.address || it.title) : it.to)}" target="_blank" rel="noopener">${I.pin}地図</a>` : ''}
        ${it.imgs?.length ? `<button data-act="imgs">${I.photo}スクショ</button>` : ''}
      </div>` : ''}
    </div></div>`;
}

export function tickTrip() {
  tickHome();
  tickStatus();
}

export function bindTrip() {
  let raf = 0;
  el().addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateNowJump(); parallax(); }); }, { passive: true });
  el().addEventListener('change', (e) => {
    if (e.target.id !== 'trip-sel') return;
    if (e.target.value === '__new') { newTrip(); return; }
    store.data.currentTrip = e.target.value; store.save(); renderTrip();
  });
  el().addEventListener('click', async (e) => {
    const tDay = e.target.closest('[data-day]');
    if (tDay) {
      selectedDay = tDay.dataset.day;
      haptic();
      renderTrip();
      return;
    }
    const t = e.target.closest('[data-act],[data-filter]');
    if (!t) return;
    if (t.dataset.filter) { filter = t.dataset.filter; haptic(); renderTrip(); return; }
    const act = t.dataset.act;
    const trip = currentTrip();
    const it = trip?.items.find((x) => x.id === t.closest('[data-id]')?.dataset.id);
    if (act !== 'open') e.stopPropagation();
    switch (act) {
      case 'pdf': openShiori(); break;
      case 'nowjump': haptic(); nowTarget()?.scrollIntoView({ behavior: 'smooth', block: 'center' }); break;
      case 'optimize': if (trip) openOptimizeSheet(trip); break;
      case 'suggest-spot': {
        const slotEl = t.closest('.gap-slot');
        if (trip && slotEl) openSuggestSpotSheet(trip, slotEl);
        break;
      }
      case 'import': openImport({}); break;
      case 'trips': tripSwitcher(); break;
      case 'newtrip': newTrip(); break;
      case 'wish': (await import('./tools.js')).openWishlist(); break;
      case 'paste': openPaste({}); break;
      case 'add': editItem(null); break;
      case 'addmenu': addMenu(); break;
      case 'menu': tripMenu(); break;
      case 'res': it.reserved = !it.reserved; haptic(); store.save(); renderTrip(); toast(it.reserved ? '予約済みにしました' : '未予約にしました'); break;
      case 'copyconf': copyText(it.confirmation); break;
      case 'transit': transitLinks({ from: it.from, to: it.to, when: parseLocal(it.start) }); break;
      case 'swap': swapAlternate(trip, it, t.dataset.alt); break;
      case 'imgs': showImgs(it); break;
      case 'more':
        // 長いメモは2行に畳んである。タップで全部表示／畳む（短いメモなら予定を開く）
        if (t.classList.contains('open') || t.scrollHeight > t.clientHeight + 2) { t.classList.toggle('open'); haptic(); break; }
        editItem(it); break;
      case 'open': if (e.target.closest('a,button')) return; editItem(it); break;
    }
  });
}

function openOptimizeSheet(trip) {
  sheet({
    title: 'スケジュール最適化', left: '閉じる', right: '最適化を実行',
    onRight: async (body, close) => {
      const prog = $('#opt-prog', body);
      prog.innerHTML = '<div class="hstack small"><span class="spinner"></span>移動時間・乗り換え・おすすめスポットを計算中…</div>';
      try {
        const res = await autoOptimizeSchedule(trip);
        trip.items = res.items;
        store.save();
        renderTrip();
        haptic();
        toast('スケジュールを最適化しました');
        confirmBox('最適化が完了しました', res.summary, 'OK', { cancel: '' });
        return true;
      } catch (e) {
        prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(e.message || String(e))}</div>`;
        return false;
      }
    },
    build(body) {
      const gaps = detectGaps(trip);
      body.innerHTML = `
        <div class="card" style="margin:0 0 12px">
          <div style="font-weight:600;margin-bottom:4px">${I.sparkles} 旅程のスマート分析</div>
          <div class="small muted">予定間の移動時間や乗り換えバッファを自動チェックし、無理のない時間に整えます。空き時間には周辺の観光スポットや食事処を考慮します。</div>
        </div>
        <div class="section-title">検出された状況</div>
        <div class="list">
          <div class="row"><div>登録されている予定</div><b style="margin-left:auto">${trip.items.length}件</b></div>
          <div class="row"><div>30分以上の空き時間</div><b style="margin-left:auto">${gaps.length}箇所</b></div>
        </div>
        <div id="opt-prog" style="margin-top:14px"></div>
      `;
    }
  });
}

function openSuggestSpotSheet(trip, slotEl) {
  const gapStart = new Date(slotEl.dataset.gapStart);
  const gapEnd = new Date(slotEl.dataset.gapEnd);
  const loc = slotEl.dataset.gapLoc || '';
  const gapMin = parseInt(slotEl.dataset.gapMin || '60', 10);

  sheet({
    title: 'おすすめスポットの提案', left: '閉じる',
    build(body, close) {
      body.innerHTML = `
        <div class="small muted" style="margin-bottom:12px">
          ${hm(gapStart)} 〜 ${hm(gapEnd)}（${gapMin}分間）の空き時間<br>
          ${loc ? `周辺エリア: <b>${esc(loc)}</b>` : ''}
        </div>
        <div id="spot-sugg-list"><div class="hstack small"><span class="spinner"></span>おすすめ候補を探しています…</div></div>
      `;
      (async () => {
        const spots = await suggestSpotsForGap({ location: loc, minutes: gapMin });
        const listEl = $('#spot-sugg-list', body);
        if (!spots.length) {
          listEl.innerHTML = `<div class="empty">${I.pin}<div>近くのおすすめが見つかりませんでした</div><div class="small">手動でスポットを検索するか予定を追加できます</div><button class="btn small" style="margin-top:10px" id="gap-manual-add">${I.plus}手入力で予定を追加</button></div>`;
          $('#gap-manual-add', body)?.addEventListener('click', () => { close(); editItem({ start: toLocalISO(gapStart), end: toLocalISO(gapEnd) }); });
          return;
        }
        listEl.innerHTML = `
          <div class="list">
            ${spots.map((s, idx) => `
              <div class="row icon-row" data-spot-idx="${idx}" style="cursor:pointer">
                <span class="ico" style="background:${s.category === 'グルメ' || s.category === 'カフェ' ? 'var(--orange)' : 'var(--blue)'}">${s.category === 'グルメ' ? I.food : I.star}</span>
                <div class="grow">
                  <b>${esc(s.name)}</b>
                  <div class="sub">${esc(s.category)}・目安${s.stay}分${s.notes ? `・${esc(s.notes)}` : ''} ${s.source === 'wishlist' ? '<span class="badge ok">行きたいリスト</span>' : ''}</div>
                </div>
                <button class="btn small" style="flex:none" data-add-spot="${idx}">追加</button>
              </div>
            `).join('')}
          </div>
          <div style="margin-top:14px"><button class="btn secondary" id="gap-search-more">${I.search}行きたいリストを開く</button></div>
        `;
        $$('[data-add-spot]', listEl).forEach((b) => b.onclick = () => {
          const s = spots[parseInt(b.dataset.addSpot, 10)];
          const durMs = (s.stay || 45) * 60000;
          const endMs = Math.min(gapEnd.getTime(), gapStart.getTime() + durMs);
          const newItem = {
            id: uid(),
            type: s.category === 'グルメ' || s.category === 'カフェ' ? 'meal' : 'activity',
            title: s.name,
            start: toLocalISO(gapStart),
            end: toLocalISO(new Date(endMs)),
            address: s.address || '',
            notes: s.notes || '',
            reserved: false,
            imgs: []
          };
          trip.items.push(newItem);
          store.save();
          renderTrip();
          haptic();
          toast(`「${s.name}」を旅程に追加しました`);
          close();
        });
        $('#gap-search-more', body)?.addEventListener('click', () => {
          close();
          import('./tools.js').then((m) => m.openWishlist?.());
        });
      })();
    }
  });
}

function addMenu() {
  sheet({
    title: '予定を追加', left: '閉じる',
    build(body, close) {
      body.innerHTML = `${buildTiles(true)}
        <div class="list"><button class="row icon-row" data-act="alt"><span class="ico" style="background:var(--orange)">${I.route}</span><div class="grow">予備ルートを追加<div class="sub">乗り遅れた時などの別ルート</div></div><span class="chev">${I.chev}</span></button></div>`;
      $$('[data-act]', body).forEach((b) => b.onclick = () => {
        const k = b.dataset.act;
        haptic(); close();
        setTimeout(async () => {
          if (k === 'paste') openPaste({});
          else if (k === 'import') openImport({});
          else if (k === 'alt') openImport({ alternate: true });
          else if (k === 'wish') (await import('./tools.js')).openWishlist();
          else editItem(null);
        }, 250);
      });
    },
  });
}
// ===== 新しい旅をつくる =====
// 名前と日程（どちらもあとで変えられる）を入れて、そのまま予定の入れ方を選べる
export function newTrip({ then } = {}) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let made = null;
  const create = (body) => {
    if (made) return made;
    const name = $('#nt-name', body).value.trim();
    const st = $('#nt-s', body).value, en = $('#nt-e', body).value;
    const sd = st && parseLocal(st + 'T00:00');
    made = { id: uid(), name: name || (sd ? `${sd.getMonth() + 1}月${sd.getDate()}日からの旅` : '新しい旅'), items: [], created: Date.now() };
    if (st) made.start = st;
    if (en) made.end = en;
    store.data.trips.push(made); store.data.currentTrip = made.id; selectedDay = 'all'; store.save();
    renderTrip(); haptic();
    toast(`「${made.name}」をつくりました`);
    return made;
  };
  sheet({
    title: '新しい旅', right: 'つくる',
    onRight: (body) => { create(body); then?.(); },
    build(body, close) {
      body.innerHTML = `
        <div class="nt-hero"><span>🧳</span></div>
        <div class="list"><div class="row"><input id="nt-name" class="big-input" placeholder="旅の名前（例：京都 2泊3日）" enterkeyhint="done" autocomplete="off"></div></div>
        <div class="section-title">日程<span class="opt">あとで決めてもOK</span></div>
        <div class="list">
          <div class="row"><div style="flex:none;min-width:84px">行く日</div><input type="date" id="nt-s" value=""></div>
          <div class="row"><div style="flex:none;min-width:84px">帰る日</div><input type="date" id="nt-e" value=""></div>
        </div>
        <div class="section-title">つくったら、予定を入れる</div>
        <div class="tile-grid compact">${TILES.filter((x) => !x[6]).map(([k, n, sub, c, ic, rec], i) => `<button class="tile" data-go="${k}" style="--c:${c};--i:${i}">${rec ? '<span class="tile-rec">おすすめ</span>' : ''}<span class="tile-ico">${I[ic]}</span><b>${n}</b><span class="tile-sub">${sub}</span></button>`).join('')}</div>
        <button class="btn" id="nt-go" style="margin-top:6px">${I.plus}旅をつくる（予定はあとで）</button>`;
      const nm = $('#nt-name', body), s1 = $('#nt-s', body), s2 = $('#nt-e', body);
      s1.min = iso(new Date(today.getFullYear() - 1, 0, 1));
      s1.onchange = () => { if (s1.value && (!s2.value || s2.value < s1.value)) s2.value = s1.value; };
      nm.onkeydown = (e) => { if (e.key === 'Enter') nm.blur(); };
      $('#nt-go', body).onclick = () => { create(body); close(); then?.(); };
      $$('[data-go]', body).forEach((b) => b.onclick = () => {
        create(body); close();
        const k = b.dataset.go;
        setTimeout(async () => {
          if (k === 'import') openImport({});
          else if (k === 'paste') openPaste({});
          else if (k === 'wish') (await import('./tools.js')).openWishlist();
          else editItem(null);
        }, 300);
      });
      setTimeout(() => nm.focus(), 450);
    },
  });
}

function tripMenu() {
  const t = currentTrip();
  sheet({
    title: t.name, left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="list">
        <button class="row" data-k="rename">${I.edit}<div class="grow">名前を変える</div></button>
        <button class="row" data-k="new">${I.plus}<div class="grow">新しい旅をつくる</div></button>
        <button class="row" data-k="shiori">${I.note}<div class="grow">旅のしおりをつくる（印刷・PDF）</div></button>
        <button class="row" data-k="ics">${I.clock}<div class="grow">全部の予定をカレンダーに登録</div></button>
        <button class="row" data-k="social">${I.globe}<div class="grow">旅仲間と共有・チャット</div></button>
        <button class="row" data-k="share">${I.share}<div class="grow">旅程を文字で共有</div></button>
        <button class="row" data-k="export">${I.download}<div class="grow">この旅をファイルに保存</div></button>
        <label class="row">${I.upload}<div class="grow">ファイルから旅を読み込む</div><input type="file" accept=".json,application/json" hidden id="trip-imp"></label>
        <button class="row" data-k="reset" style="color:var(--orange)">${I.check}<div class="grow">予約チェックを全部外す</div></button>
        <button class="row" data-k="del" style="color:var(--red)">${I.trash}<div class="grow">この旅を削除</div></button>
      </div>`;
      $$('[data-k]', body).forEach((b) => b.onclick = async () => {
        const k = b.dataset.k;
        if (k === 'shiori') { close(); (await import('./shiori.js')).openShiori(); return; }
        if (k === 'ics') { icsDownload(t.items, t.name); close(); return; }
        if (k === 'social') { close(); (await import('./social.js')).openSocial(); return; }
        if (k === 'rename') { close(); const n = await askText({ title: '旅の名前', value: t.name, placeholder: '旅の名前' }); if (n) { t.name = n; store.save(); renderTrip(); } return; }
        if (k === 'new') { close(); setTimeout(() => newTrip(), 300); return; }
        if (k === 'share') {
          const txt = tripText(t);
          if (navigator.share) { try { await navigator.share({ title: t.name, text: txt }); } catch {} } else copyText(txt);
        }
        if (k === 'export') download(`${t.name}.json`, JSON.stringify(t, null, 2));
        if (k === 'reset') { t.items.forEach((i) => (i.reserved = false)); store.save(); }
        if (k === 'del') {
          if (!(await confirmBox(`「${t.name}」を削除しますか？`, 'この操作は取り消せません', '削除', { destructive: true }))) return;
          store.data.trips = store.data.trips.filter((x) => x.id !== t.id); store.data.currentTrip = null; store.save();
        }
        close(); renderTrip();
      });
      $('#trip-imp', body).onchange = async (e) => {
        try {
          const j = JSON.parse(await e.target.files[0].text());
          if (!Array.isArray(j.items)) throw 0;
          j.id = uid(); store.data.trips.push(j); store.data.currentTrip = j.id; store.save(); close(); renderTrip(); toast('読み込みました');
        } catch { toast('読み込めませんでした'); }
      };
    },
  });
}

export function tripText(t) {
  let out = `【${t.name}】\n`, last = '';
  for (const e of events(t)) {
    if (e.at && dayKey(e.at) !== last) { last = dayKey(e.at); out += `\n■ ${mdw(e.at)}\n`; }
    const it = e.it;
    out += `${e.at ? hm(e.at) : '--:--'}${e.kind === '' && e.end && +e.end !== +e.at ? '-' + hm(e.end) : ''} ${TYPES[it.type]?.name || ''} ${itemTitle(it, e.kind)}`;
    if (TRANSPORT.has(it.type) && (it.from || it.to)) out += `（${it.from || ''}→${it.to || ''}）`;
    if (it.platform) out += ` ${it.platform}`;
    if (it.seat) out += ` 座席${it.seat}`;
    out += it.reserved ? ' ✅' : ' ⬜';
    out += '\n';
  }
  return out;
}

function swapAlternate(trip, it, altId) {
  const alt = it.alternates.find((a) => a.id === altId);
  if (!alt) return;
  const idx = trip.items.indexOf(it);
  const others = it.alternates.filter((a) => a !== alt);
  const { alternates, ...plain } = it;
  const legs = alt.legs.map((l) => ({ ...l, id: uid() }));
  legs[0].alternates = [{ id: uid(), name: `元のルート（${it.title || ''}）`, legs: [plain] }, ...others];
  trip.items.splice(idx, 1, ...legs);
  store.save(); renderTrip(); haptic(); toast('予備ルートに切り替えました（元のルートは予備に残しています）', 3000);
}

async function showImgs(it) {
  page({
    title: 'スクリーンショット',
    async build(body) {
      body.innerHTML = '<div class="stack" id="imgs"></div>';
      for (const k of it.imgs || []) {
        const b = await blobs.get(k);
        if (!b) continue;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(b);
        img.style.cssText = 'width:100%;border-radius:12px;box-shadow:var(--shadow)';
        $('#imgs', body).append(img);
      }
    },
  });
}

// ===== 予定の編集 =====
const FIELDS = {
  common: [['title', '名前', 'text', '例：のぞみ 5号 / ○○ホテル']],
  move: [['from', '出発地', 'text', '東京'], ['to', '到着地', 'text', '新大阪'], ['start', '出発', 'datetime-local'], ['end', '到着', 'datetime-local'], ['operator', '会社・路線', 'text', 'JR東海'], ['number', '便名・列車名', 'text', 'NH 123'], ['platform', '番線・ゲート', 'text', '14番線'], ['seat', '座席', 'text', '7号車 3A']],
  hotel: [['start', 'チェックイン', 'datetime-local'], ['end', 'チェックアウト', 'datetime-local'], ['address', '住所', 'text', ''], ['room', '部屋・ベッド番号', 'text', 'ドミトリー 上段 12'], ['wifi', 'Wi-Fi', 'text', 'SSID / パスワード']],
  other: [['start', '開始', 'datetime-local'], ['end', '終了', 'datetime-local'], ['address', '場所・住所', 'text', '']],
  tail: [['confirmation', '予約番号', 'text', ''], ['cost', '料金', 'text', '¥14,170'], ['phone', '電話', 'tel', ''], ['notes', 'メモ', 'textarea', '']],
};

export function editItem(orig, { onSave, asAlternateOf } = {}) {
  const it = structuredClone(orig || { id: uid(), type: 'train', reserved: false, start: '', end: '' });
  // 新しい予定（ひな形を渡された時も、まだ旅程に無ければ新規）
  const isNew = !orig || (!onSave && !currentTrip()?.items.some((x) => x.id === orig.id));
  sheet({
    title: isNew ? '予定を追加' : '予定を編集', right: '保存',
    onRight: () => {
      if (onSave) { onSave(it); return; }
      const t = ensureTrip();
      if (isNew) t.items.push(it); else Object.assign(orig, it);
      store.save(); renderTrip(); toast('保存しました');
    },
    build(body, close) {
      const draw = () => {
        const kind = it.type === 'hotel' ? 'hotel' : TRANSPORT.has(it.type) ? 'move' : 'other';
        const fields = [...FIELDS.common, ...FIELDS[kind], ...FIELDS.tail];
        body.innerHTML = `
          <div class="chips" style="flex-wrap:wrap">${Object.entries(TYPES).map(([k, v]) => `<button class="chip ${it.type === k ? 'on' : ''}" data-type="${k}" style="${it.type === k ? `background:${v.color}` : ''}"><span style="color:${it.type === k ? '#fff' : v.color}">${I[v.icon]}</span>${v.name}</button>`).join('')}</div>
          <div class="list" style="margin-bottom:12px"><div class="row">${I.search}<input type="text" id="it-spot" class="left" placeholder="${TRANSPORT.has(it.type) ? '駅・空港を検索して入力' : 'スポット・宿を検索して自動入力'}" enterkeyhint="search"></div><div id="it-spots"></div></div>
          <div class="list">${fields.map(([k, label, type, ph]) => type === 'textarea'
            ? `<div class="row" style="flex-direction:column;align-items:stretch"><div class="sub">${label}</div><textarea data-f="${k}" placeholder="${esc(ph)}">${esc(it[k] || '')}</textarea></div>`
            : `<div class="row"><div style="flex:none;min-width:96px">${label}</div><input type="${type}" data-f="${k}" value="${esc(it[k] || '')}" placeholder="${esc(ph || '')}"></div>`).join('')}
            <div class="row"><div class="grow">予約済み</div>${switchHTML('', it.reserved, 'id="it-res"')}</div>
            <div class="row"><div class="grow">リマインド</div><select id="it-rem">${[[0, 'なし'], [10, '10分前'], [30, '30分前'], [60, '1時間前'], [120, '2時間前'], [1440, '前日']].map(([v, t]) => `<option value="${v}" ${+(it.remind || 0) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          </div>
          ${it.start ? `<div style="margin-top:12px"><button class="btn secondary" id="it-ics">${I.clock}iPhoneのカレンダーに登録（通知つき）</button></div>` : ''}
          ${!isNew && !onSave ? `
          ${it.alternates?.length ? `<div class="section-title">予備ルート</div><div class="list">${it.alternates.map((a) => `<div class="row"><div class="grow">${esc(a.name || '予備')}<div class="sub">${a.legs.map((l) => `${hm(parseLocal(l.start))} ${esc(l.from || '')}→${esc(l.to || '')}`).join(' / ')}</div></div><button data-rmalt="${a.id}" style="color:var(--red)">${I.trash}</button></div>`).join('')}</div>` : ''}
          <div class="stack" style="margin-top:18px">
            <button class="btn secondary" id="it-alt">${I.route}予備ルートを追加（スクショ）</button>
            <button class="btn secondary" id="it-altm">${I.edit}予備ルートを手入力で追加</button>
            <button class="btn danger" id="it-del">${I.trash}この予定を削除</button>
          </div>` : ''}`;
        $$('[data-type]', body).forEach((b) => b.onclick = () => { it.type = b.dataset.type; haptic(); draw(); });
        $$('[data-f]', body).forEach((f) => f.oninput = () => { it[f.dataset.f] = f.value; });
        $('#it-res', body).onchange = (e) => { it.reserved = e.target.checked; };
        $('#it-rem', body).onchange = (e) => { it.remind = +e.target.value; };
        $('#it-ics', body)?.addEventListener('click', () => icsDownload([it]));
        const spot = $('#it-spot', body);
        spot.onkeydown = async (e) => {
          if (e.key !== 'Enter' || !spot.value.trim()) return;
          spot.blur();
          const box = $('#it-spots', body);
          box.innerHTML = '<div class="row"><span class="spinner"></span></div>';
          let list = [];
          try { list = await spotSearch(spot.value.trim(), store.data.settings.place); } catch {}
          box.innerHTML = list.length ? list.map((x, i) => `<button class="row" data-spot="${i}">${I.pin}<div class="grow">${esc(x.name)}<div class="sub">${esc(x.address)}${x.hours ? '・' + esc(x.hours) : ''}</div></div></button>`).join('') : '<div class="row muted small">見つかりませんでした</div>';
          $$('[data-spot]', box).forEach((b) => b.onclick = () => {
            const x = list[+b.dataset.spot];
            if (TRANSPORT.has(it.type)) {
              if (!it.from) it.from = x.name; else it.to = x.name;
            } else {
              if (!orig && it.type === 'train') it.type = x.type;
              it.title = x.name; it.address = x.address; it.lat = x.lat; it.lon = x.lon;
              if (x.phone) it.phone = x.phone;
              const extra = [x.hours && `営業時間: ${x.hours}`, x.fee && `料金: ${x.fee}`, x.website].filter(Boolean).join('\n');
              if (extra && !(it.notes || '').includes(extra)) it.notes = [it.notes, extra].filter(Boolean).join('\n');
            }
            haptic(); toast('入力しました'); draw();
          });
        };
        $$('[data-rmalt]', body).forEach((b) => b.onclick = () => { it.alternates = it.alternates.filter((a) => a.id !== b.dataset.rmalt); draw(); });
        $('#it-del', body)?.addEventListener('click', async () => {
          if (!(await confirmBox('この予定を削除しますか？', '', '削除', { destructive: true }))) return;
          const t = currentTrip(); t.items = t.items.filter((x) => x.id !== orig.id); store.save(); renderTrip(); close();
        });
        $('#it-alt', body)?.addEventListener('click', () => { Object.assign(orig, it); store.save(); close(); setTimeout(() => openImport({ alternate: true, targetId: orig.id }), 300); });
        $('#it-altm', body)?.addEventListener('click', () => {
          editItem({ id: uid(), type: it.type, from: it.from, to: it.to, start: it.start, end: '', reserved: false }, {
            onSave: (leg) => { it.alternates = [...(it.alternates || []), { id: uid(), name: `予備 ${(it.alternates?.length || 0) + 1}`, legs: [leg] }]; Object.assign(orig, it); store.save(); renderTrip(); draw(); toast('予備ルートを追加しました'); },
          });
        });
      };
      draw();
    },
  });
}
