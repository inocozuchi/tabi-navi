// 旅程：時系列の一覧・予約チェック・予備ルート・編集
import { $, $$, esc, uid, store, sheet, page, toast, confirmBox, switchHTML, haptic, I, TYPES, TRANSPORT, parseLocal, hm, dayKey, mdw, dur, countdown, yen, copyText, blobs, download, segment } from './util.js';
import { openImport } from './ai.js';
import { transitLinks, mapsSearchUrl, spotSearch } from './transit.js';
import { icsDownload } from './tools.js';

const el = () => $('#view-trip');
let filter = 'all';

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
    el().innerHTML = `<div class="large-title"><h1>旅程</h1></div>
      <div class="empty">${I.route}<div style="font-size:19px;font-weight:600;color:var(--label);margin-bottom:6px">旅程をつくりましょう</div>
      乗換案内・ホテル・飛行機の予約画面のスクリーンショットを貼ると、自動で時系列に並べます。</div>
      <div class="stack"><button class="btn" data-act="import">${I.sparkles}スクショから旅程をつくる</button>
      <button class="btn secondary" data-act="add">${I.edit}手入力で追加</button></div>`;
    return;
  }
  const evs = events(t);
  const items = t.items;
  const resv = items.filter((i) => i.reserved).length;
  const cost = items.reduce((s, i) => s + (parseFloat(String(i.cost || '').replace(/[^\d.]/g, '')) || 0), 0);
  const nxt = nextEvent(now);
  const shown = evs.filter((e) => filter === 'all' || (filter === 'unres' && !e.it.reserved) || (filter === 'move' && TRANSPORT.has(e.it.type)) || (filter === 'stay' && e.it.type === 'hotel') || (filter === 'alt' && e.it.alternates?.length));
  let html = `
    <div class="large-title"><h1>旅程</h1><div class="actions"><button class="icon-btn" data-act="menu">${I.dots}</button><button class="icon-btn" data-act="addmenu">${I.plus}</button></div></div>
    <div class="trip-head"><select id="trip-sel">${d.trips.map((x) => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="__new">＋ 新しい旅…</option></select></div>
    <div class="now-banner"><span style="color:var(--red)">${I.clock}</span><span class="t" id="trip-now">${hm(now)}</span>
      <div class="grow small" style="flex:1;min-width:0" id="trip-next">${nextText(nxt, now)}</div></div>
    <div class="stats">
      <div><b>${items.length}</b><span>予定</span></div>
      <div><b style="color:${resv === items.length ? 'var(--green)' : 'var(--orange)'}">${resv}/${items.length}</b><span>予約済み</span></div>
      <div><b>${cost ? yen(cost) : '—'}</b><span>費用の合計</span></div>
    </div>
    <div class="chips">${[['all', 'すべて'], ['unres', '未予約'], ['move', '移動'], ['stay', '宿泊'], ['alt', '予備ルートあり']].map(([k, n]) => `<button class="chip ${filter === k ? 'on' : ''}" data-filter="${k}">${n}</button>`).join('')}</div>`;
  if (!items.length) html += `<div class="empty">${I.route}<div>まだ予定がありません</div><div class="small">右上の ＋ から追加できます</div></div>`;
  let lastDay = '', nowPlaced = false, prev = null;
  const noTime = shown.filter((e) => !e.at);
  html += '<div class="tl">';
  for (const e of shown.filter((x) => x.at)) {
    const dk = dayKey(e.at);
    if (dk !== lastDay) {
      if (!nowPlaced && lastDay && dayKey(now) === lastDay) { html += nowLine(now); nowPlaced = true; }
      html += `<div class="day-head ${dk === dayKey(now) ? 'today' : ''}" style="margin-left:-64px">${mdw(e.at)}<small>${dayIndex(evs, e.at)}</small></div>`;
      lastDay = dk; prev = null;
    }
    if (!nowPlaced && e.at > now && dayKey(now) === dk) { html += nowLine(now); nowPlaced = true; }
    if (prev && TRANSPORT.has(prev.it.type) && TRANSPORT.has(e.it.type) && prev.end && e.at > prev.end - 1) {
      const gap = (e.at - prev.end) / 60000;
      if (gap >= 0 && gap < 180) html += `<div class="gap-note ${gap < 5 ? 'warn' : ''}">${gap < 5 ? I.warn : I.walk} 乗り換え ${Math.round(gap)}分${gap < 5 ? '（短いので注意）' : ''}</div>`;
    }
    html += evHTML(e, now);
    prev = e;
  }
  html += '</div>';
  if (noTime.length) html += `<div class="section-title">日時が未定</div><div class="tl">${noTime.map((e) => evHTML(e, now)).join('')}</div>`;
  el().innerHTML = html;
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
  const resv = it.reserved ? `<span class="badge ok res-toggle" data-act="res">${I.check} 予約済み</span>` : `<span class="badge ng res-toggle" data-act="res">未予約</span>`;
  const sub = e.kind === 'out' ? '' : (e.end && +e.end !== +e.at && it.type !== 'hotel') ? `<small>〜${hm(e.end)}</small>` : '';
  const isMove = TRANSPORT.has(it.type);
  return `<div class="tl-item ${past ? 'past' : ''} ${cur ? 'current' : ''}" style="--c:${T.color}" data-id="${it.id}">
    <div class="time">${e.at ? hm(e.at) : '--:--'}${sub}</div><div class="line"></div><div class="dot"></div>
    <div class="ev" data-act="open">
      <div class="top"><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(itemTitle(it, e.kind))}</div>${resv}</div>
      ${isMove && (it.from || it.to) ? `<div class="route"><span>${esc(it.from || '?')}</span><span class="arrow">→</span><span>${esc(it.to || '?')}</span>${e.end && e.at && it.type !== 'hotel' ? `<span class="muted small" style="margin-left:auto">${dur(e.end - e.at)}</span>` : ''}</div>` : ''}
      ${!isMove && it.address && e.kind !== 'out' ? `<div class="small muted" style="margin-top:4px">${I.pin} ${esc(it.address)}</div>` : ''}
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      ${it.notes && e.kind !== 'out' ? `<div class="small muted" style="margin-top:6px;white-space:pre-wrap">${esc(it.notes)}</div>` : ''}
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
  const n = $('#trip-now'); if (!n) return;
  const now = new Date();
  n.textContent = hm(now);
  $('#trip-next').innerHTML = nextText(nextEvent(now), now);
}

export function bindTrip() {
  el().addEventListener('change', (e) => {
    if (e.target.id !== 'trip-sel') return;
    if (e.target.value === '__new') { newTrip(); renderTrip(); return; }
    store.data.currentTrip = e.target.value; store.save(); renderTrip();
  });
  el().addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act],[data-filter]');
    if (!t) return;
    if (t.dataset.filter) { filter = t.dataset.filter; haptic(); renderTrip(); return; }
    const act = t.dataset.act;
    const trip = currentTrip();
    const it = trip?.items.find((x) => x.id === t.closest('[data-id]')?.dataset.id);
    if (act !== 'open') e.stopPropagation();
    switch (act) {
      case 'import': openImport({}); break;
      case 'add': editItem(null); break;
      case 'addmenu': addMenu(); break;
      case 'menu': tripMenu(); break;
      case 'res': it.reserved = !it.reserved; haptic(); store.save(); renderTrip(); toast(it.reserved ? '予約済みにしました' : '未予約にしました'); break;
      case 'copyconf': copyText(it.confirmation); break;
      case 'transit': transitLinks({ from: it.from, to: it.to, when: parseLocal(it.start) }); break;
      case 'swap': swapAlternate(trip, it, t.dataset.alt); break;
      case 'imgs': showImgs(it); break;
      case 'open': if (e.target.closest('a,button')) return; editItem(it); break;
    }
  });
}

function addMenu() {
  sheet({
    title: '追加', left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="list">
        <button class="row icon-row" data-k="import"><span class="ico" style="background:var(--indigo)">${I.sparkles}</span><div class="grow">スクショから取り込む<div class="sub">乗換案内・ホテル・飛行機の予約画面など（複数まとめてOK）</div></div><span class="chev">${I.chev}</span></button>
        <button class="row icon-row" data-k="alt"><span class="ico" style="background:var(--orange)">${I.route}</span><div class="grow">予備ルートを追加<div class="sub">乗り遅れた時などの別ルートのスクショ</div></div><span class="chev">${I.chev}</span></button>
        <button class="row icon-row" data-k="add"><span class="ico" style="background:var(--blue)">${I.edit}</span><div class="grow">手入力で追加</div><span class="chev">${I.chev}</span></button>
      </div>`;
      $$('[data-k]', body).forEach((b) => b.onclick = () => {
        close();
        setTimeout(() => {
          if (b.dataset.k === 'import') openImport({});
          else if (b.dataset.k === 'alt') openImport({ alternate: true });
          else editItem(null);
        }, 250);
      });
    },
  });
}

function newTrip() {
  const name = prompt('旅の名前', '新しい旅');
  if (!name) return;
  const t = { id: uid(), name, items: [] };
  store.data.trips.push(t); store.data.currentTrip = t.id; store.save();
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
        if (k === 'rename') { const n = prompt('旅の名前', t.name); if (n) { t.name = n; store.save(); } }
        if (k === 'new') newTrip();
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
  const isNew = !orig;
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
