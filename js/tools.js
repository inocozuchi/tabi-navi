// 旅の道具：行きたいリスト・メモ（写真から文字化）・リマインド・旅費・持ち物・通貨・カレンダー登録
import { $, $$, esc, uid, store, sheet, page, toast, confirmBox, haptic, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, yen, pad, toLocalISO, shrinkImage, blobs, download, copyText, segment } from './util.js';
import { callClaude, todayText, imageContent, friendlyError, ocr, review } from './ai.js';
import { currentTrip, ensureTrip, events, editItem, renderTrip } from './trip.js';
import { spotSearch, geocode, mapsSearchUrl } from './transit.js';

// ===== カレンダー登録（.ics：iPhone のカレンダーが通知してくれる。アプリを閉じていても届く） =====
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const icsEsc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
export function icsDownload(items, name = '旅ナビ') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TabiNavi//JP', 'CALSCALE:GREGORIAN'];
  for (const it of items) {
    const s = parseLocal(it.start);
    if (!s) continue;
    const e = parseLocal(it.end) || new Date(s.getTime() + 30 * 60000);
    const T = TYPES[it.type] || TYPES.other;
    const title = it.type === 'hotel' ? `🛏 ${it.title || '宿'}` : `${T.name} ${it.title || ''}${it.from ? ` ${it.from}→${it.to || ''}` : ''}`;
    const desc = [it.platform, it.seat && `座席 ${it.seat}`, it.confirmation && `予約番号 ${it.confirmation}`, it.cost, it.notes].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${it.id}@tabinavi`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(s)}`, `DTEND:${icsDate(e > s ? e : new Date(s.getTime() + 30 * 60000))}`, `SUMMARY:${icsEsc(title)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEsc(desc)}`);
    if (it.address || it.from) lines.push(`LOCATION:${icsEsc(it.address || it.from)}`);
    const rem = it.remind || 30;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(title)}`, `TRIGGER:-PT${rem}M`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  download(`${name}.ics`, lines.join('\r\n'), 'text/calendar');
  toast('開いて「カレンダーに追加」を押してください', 3500);
}

// ===== リマインド（アプリを開いている間の通知） =====
export function checkReminders(now = Date.now()) {
  const fired = store.data.fired;
  const due = [];
  const t = currentTrip();
  for (const it of t?.items || []) {
    if (!it.remind) continue;
    const s = parseLocal(it.start);
    if (!s) continue;
    const at = s.getTime() - it.remind * 60000;
    const key = `i:${it.id}:${it.start}:${it.remind}`;
    if (now >= at && now < s.getTime() + 60000 && !fired[key]) { fired[key] = 1; due.push({ title: `${it.remind >= 1440 ? '明日' : `${it.remind}分後`}：${it.title || TYPES[it.type]?.name}`, body: [it.from && `${it.from}→${it.to || ''}`, it.platform, it.seat && `座席 ${it.seat}`].filter(Boolean).join('　') }); }
  }
  for (const m of store.data.memos) {
    if (!m.remindAt || m.done) continue;
    const at = parseLocal(m.remindAt)?.getTime();
    const key = `m:${m.id}:${m.remindAt}`;
    if (at && now >= at && now < at + 6 * 3600e3 && !fired[key]) { fired[key] = 1; due.push({ title: `📝 ${m.title || 'メモ'}`, body: (m.text || '').slice(0, 80) }); }
  }
  if (!due.length) return;
  store.save();
  for (const d of due) {
    confirmBox(d.title, d.body, 'OK', { cancel: '' });
    try { navigator.vibrate?.([200, 100, 200]); } catch {}
    try {
      if (Notification?.permission === 'granted') navigator.serviceWorker?.ready.then((r) => r.showNotification(d.title, { body: d.body, icon: 'icons/icon-192.png' }));
    } catch {}
  }
}

// ===== 写真 → 文字 =====
async function photoToText(files, say) {
  const small = [];
  for (const f of files) small.push(await shrinkImage(f, 1568));
  if (store.data.settings.apiKey) {
    say?.('AIが文字にしています…');
    const content = await imageContent(small);
    content.push({ type: 'text', text: '画像に写っている文字を、メモとして読みやすく書き起こしてください。部屋番号・暗証番号・集合時間・集合場所・電話番号などの大事な情報は落とさないでください。日時が書いてあれば events に入れてください（YYYY-MM-DDTHH:MM、年が無ければ今日以降で最も近い日付）。' + todayText() });
    const r = await callClaude({
      system: '旅行者のメモを手伝うアシスタントです。',
      content,
      schema: { type: 'object', additionalProperties: false, required: ['title', 'text', 'events'], properties: { title: { type: 'string' }, text: { type: 'string' }, events: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'start', 'place'], properties: { title: { type: 'string' }, start: { type: 'string' }, place: { type: 'string' } } } } } },
      effort: 'low',
    });
    return { ...r, small };
  }
  let text = '';
  for (let i = 0; i < small.length; i++) { say?.(`文字を読み取っています… ${i + 1}/${small.length}`); text += (await ocr(small[i])) + '\n'; }
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { title: text.split('\n')[0].slice(0, 30), text, events: findEvents(text), small };
}
// 文章から日時を探す（キーが無い時の簡易版）
export function findEvents(text) {
  const now = new Date();
  const out = [];
  const z = text.replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const dm = /(\d{1,2})[月/](\d{1,2})日?/.exec(z);
  let y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
  if (dm) { mo = +dm[1]; d = +dm[2]; if (new Date(y, mo - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++; }
  for (const m of z.matchAll(/(\d{1,2})[:時](\d{2})?分?/g)) {
    const h = +m[1], mi = +(m[2] || 0);
    if (h > 29) continue;
    const line = z.slice(Math.max(0, z.lastIndexOf('\n', m.index) + 1), z.indexOf('\n', m.index) > 0 ? z.indexOf('\n', m.index) : undefined);
    out.push({ title: line.replace(m[0], '').replace(/\d{1,2}[月/]\d{1,2}日?/, '').trim().slice(0, 30) || '予定', start: `${y}-${pad(mo)}-${pad(d)}T${pad(h % 24)}:${pad(mi)}`, place: '' });
  }
  return out.slice(0, 5);
}

// ===== メモ =====
const MEMO_TEMPLATES = [
  ['🛏 宿メモ', '部屋・ベッド番号：\nロッカー番号・暗証番号：\nWi-Fi：\n門限・消灯：\nチェックアウト：\n大浴場・シャワー：'],
  ['🚌 ツアー集合', '集合時間：\n集合場所：\nガイド・連絡先：\nバス番号：\n持ち物：'],
  ['🅿️ 駐車・ロッカー', '場所：\n番号：\n料金・期限：'],
  ['🆘 緊急連絡先', '保険会社：\n保険証券番号：\n家族の連絡先：\nカード紛失時：\n大使館・領事館：'],
];
export function openMemos() {
  page({
    title: 'メモ', right: `<button class="link-btn">${I.plus}</button>`,
    onRight: (body) => editMemo(null, () => draw(body)),
    build(body) { draw(body); },
  });
  function draw(body) {
    const list = [...store.data.memos].sort((a, b) => (b.pinned - a.pinned) || b.updated - a.updated);
    body.innerHTML = `
      <div class="chips">${MEMO_TEMPLATES.map((t, i) => `<button class="chip" data-tpl="${i}">${t[0]}</button>`).join('')}</div>
      <label class="btn secondary" style="margin-bottom:14px">${I.camera}写真から文字にしてメモ<input type="file" accept="image/*" multiple hidden id="mm-photo"></label>
      ${list.length ? list.map((m) => `<div class="card tappable" data-id="${m.id}" style="cursor:pointer;padding:14px">
        <div class="hstack"><b style="flex:1">${m.pinned ? '📌 ' : ''}${esc(m.title || '無題')}</b>${m.remindAt && !m.done ? `<span class="badge ng">${I.clock} ${esc(m.remindAt.slice(5).replace('T', ' '))}</span>` : ''}</div>
        <div class="small muted" style="white-space:pre-wrap;margin-top:6px;max-height:4.2em;overflow:hidden">${esc(m.text || '')}</div></div>`).join('') : `<div class="empty">${I.note}<div>メモはまだありません</div><div class="small">部屋番号・集合時間・暗証番号などを残せます</div></div>`}`;
    $$('[data-tpl]', body).forEach((b) => b.onclick = () => { const t = MEMO_TEMPLATES[+b.dataset.tpl]; editMemo({ id: uid(), title: t[0].slice(2).trim(), text: t[1], _new: true }, () => draw(body)); });
    $$('[data-id]', body).forEach((c) => c.onclick = () => editMemo(store.data.memos.find((m) => m.id === c.dataset.id), () => draw(body)));
    $('#mm-photo', body).onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      toast('読み取っています…', 60000);
      try {
        const r = await photoToText(files, (m) => toast(m, 60000));
        const keys = [];
        for (const b of r.small) { const k = 'img:' + uid(); await blobs.put(k, b); keys.push(k); }
        toast('文字にしました');
        editMemo({ id: uid(), title: r.title, text: r.text, imgs: keys, _events: r.events, _new: true }, () => draw(body));
      } catch (err) { toast(friendlyError(err), 4000); }
    };
  }
}
function editMemo(orig, done) {
  const isNew = !orig || orig._new;
  const m = structuredClone(orig || { id: uid(), title: '', text: '' });
  const evs = m._events || [];
  delete m._new; delete m._events;
  sheet({
    title: isNew ? '新しいメモ' : 'メモ', right: '保存',
    onRight: () => {
      m.updated = Date.now();
      const i = store.data.memos.findIndex((x) => x.id === m.id);
      if (i >= 0) store.data.memos[i] = m; else store.data.memos.push(m);
      store.save(); done?.();
    },
    build(body, close) {
      body.innerHTML = `
        <div class="list"><div class="row"><input type="text" id="me-t" class="left" placeholder="タイトル" value="${esc(m.title)}" style="font-weight:600;font-size:18px"></div>
          <div class="row" style="align-items:stretch"><textarea id="me-x" placeholder="本文" style="min-height:180px">${esc(m.text)}</textarea></div></div>
        <div class="list" style="margin-top:12px">
          <div class="row"><div class="grow">ピン留め</div><label class="switch"><input type="checkbox" id="me-pin" ${m.pinned ? 'checked' : ''}><span></span></label></div>
          <div class="row"><div class="grow">リマインド</div><input type="datetime-local" id="me-rem" value="${esc(m.remindAt || '')}"></div>
        </div>
        ${evs.length ? `<div class="section-title">見つかった日時</div><div class="list">${evs.map((e, i) => `<button class="row" data-ev="${i}">${I.clock}<div class="grow">${esc(e.title)}<div class="sub">${esc(e.start.replace('T', ' '))} ${esc(e.place || '')}</div></div><span class="small" style="color:var(--blue)">旅程へ</span></button>`).join('')}</div>` : ''}
        <div class="stack" style="margin-top:14px">
          <button class="btn secondary" id="me-sched">${I.route}スケジュールに組み込む</button>
          <button class="btn secondary" id="me-copy">${I.copy}本文をコピー</button>
          ${m.imgs?.length ? `<button class="btn secondary" id="me-img">${I.photo}元の写真を見る</button>` : ''}
          ${isNew ? '' : `<button class="btn danger" id="me-del">${I.trash}削除</button>`}
        </div>
        <div class="section-foot">リマインドはアプリを開いている間に通知します。閉じていても確実に知らせたい時は、旅程に組み込んで「カレンダーに登録」を使ってください。</div>`;
      $('#me-t', body).oninput = (e) => (m.title = e.target.value);
      $('#me-x', body).oninput = (e) => (m.text = e.target.value);
      $('#me-pin', body).onchange = (e) => (m.pinned = e.target.checked);
      $('#me-rem', body).onchange = (e) => { m.remindAt = e.target.value; m.done = false; askNotify(); };
      $('#me-copy', body).onclick = () => copyText(m.text);
      $('#me-del', body)?.addEventListener('click', async () => {
        if (!(await confirmBox('メモを削除しますか？', '', '削除', { destructive: true }))) return;
        store.data.memos = store.data.memos.filter((x) => x.id !== m.id); store.save(); done?.(); close();
      });
      $('#me-img', body)?.addEventListener('click', () => page({ title: '写真', async build(b) { for (const k of m.imgs) { const bl = await blobs.get(k); if (bl) { const im = document.createElement('img'); im.src = URL.createObjectURL(bl); im.style.cssText = 'width:100%;border-radius:12px;margin-bottom:10px'; b.append(im); } } } }));
      const toItem = (e) => editItem({ id: uid(), type: /ツアー|集合|観光/.test(e.title + m.text) ? 'activity' : 'other', title: e.title || m.title, start: e.start || '', end: '', address: e.place || '', notes: m.text, reserved: false, remind: 30 }, {
        onSave: (it) => { ensureTrip().items.push(it); store.save(); renderTrip(); toast('旅程に入れました（30分前にお知らせ）'); },
      });
      $$('[data-ev]', body).forEach((b) => b.onclick = () => toItem(evs[+b.dataset.ev]));
      $('#me-sched', body).onclick = () => { const f = findEvents(m.text)[0]; toItem(f || { title: m.title, start: '', place: '' }); };
    },
  });
}
export function askNotify() {
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
}

// ===== 行きたいリスト =====
const WISH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['spots'],
  properties: {
    spots: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'category', 'area', 'address', 'hours', 'price', 'stay_minutes', 'notes', 'transport_from', 'transport_to', 'transport_time'],
        properties: {
          name: { type: 'string' }, category: { type: 'string', enum: ['観光', 'グルメ', 'カフェ', '宿', '温泉', '買い物', '体験', '交通', 'その他'] },
          area: { type: 'string' }, address: { type: 'string' }, hours: { type: 'string' }, price: { type: 'string' },
          stay_minutes: { type: 'integer', description: '目安の滞在時間（分）' }, notes: { type: 'string' },
          transport_from: { type: 'string' }, transport_to: { type: 'string' }, transport_time: { type: 'string' },
        },
      },
    },
  },
};
const CAT_ICON = { 観光: '⛩️', グルメ: '🍜', カフェ: '☕️', 宿: '🛏️', 温泉: '♨️', 買い物: '🛍️', 体験: '🎟️', 交通: '🚉', その他: '📍' };
const CAT_TYPE = { 宿: 'hotel', グルメ: 'meal', カフェ: 'meal', 交通: 'train' };

export function openWishlist() {
  let cat = 'すべて';
  page({
    title: '行きたいリスト', right: `<button class="link-btn">${I.plus}</button>`,
    onRight: (body) => addSpot(() => draw(body)),
    build(body) { draw(body); },
  });
  function draw(body) {
    const all = store.data.wishlist;
    const cats = ['すべて', ...new Set(all.map((w) => w.category))];
    const list = all.filter((w) => cat === 'すべて' || w.category === cat).sort((a, b) => (a.done - b.done) || (b.star - a.star) || (b.added - a.added));
    body.innerHTML = `
      <div class="stack" style="margin-bottom:14px">
        <label class="btn">${I.photo}スクショから追加（Googleマップ・検索・乗換など）<input type="file" accept="image/*" multiple hidden id="wl-photo"></label>
        <div class="hstack"><button class="btn secondary" id="wl-search" style="flex:1">${I.search}スポット検索</button><button class="btn secondary" id="wl-plan" style="flex:1">${I.sparkles}旅程を提案</button></div>
      </div>
      <div id="wl-prog"></div>
      ${all.length ? `<div class="chips">${cats.map((c) => `<button class="chip ${cat === c ? 'on' : ''}" data-cat="${esc(c)}">${CAT_ICON[c] || ''} ${esc(c)}</button>`).join('')}</div>` : ''}
      ${list.length ? list.map((w) => `<div class="card" data-id="${w.id}" style="padding:14px;${w.done ? 'opacity:.55' : ''}">
        <div class="hstack"><span style="font-size:24px">${CAT_ICON[w.category] || '📍'}</span><div style="flex:1;min-width:0"><b>${esc(w.name)}</b><div class="small muted">${esc([w.area, w.category, w.stay ? `滞在 約${w.stay}分` : ''].filter(Boolean).join('・'))}</div></div>
          <button data-a="star" style="font-size:20px">${w.star ? '⭐️' : '☆'}</button></div>
        ${w.hours || w.price ? `<div class="meta" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap">${w.hours ? `<span class="badge">${I.clock} ${esc(w.hours)}</span>` : ''}${w.price ? `<span class="badge">${esc(w.price)}</span>` : ''}</div>` : ''}
        ${w.notes ? `<div class="small muted" style="margin-top:6px;white-space:pre-wrap">${esc(w.notes)}</div>` : ''}
        <div class="hstack" style="margin-top:10px;flex-wrap:wrap">
          <button class="btn small secondary" data-a="plan">${I.plus}旅程に入れる</button>
          <a class="btn small secondary" href="${mapsSearchUrl(w.address || w.name)}" target="_blank">${I.pin}地図</a>
          <button class="btn small secondary" data-a="done">${w.done ? '未訪問に戻す' : '行った！'}</button>
          <button class="btn small danger" data-a="del">${I.trash}</button>
        </div></div>`).join('') : `<div class="empty">${I.star}<div>行きたい場所をためていきましょう</div><div class="small">Googleマップや検索結果のスクショを送ると、自動で場所の情報を取り出します</div></div>`}`;
    $$('[data-cat]', body).forEach((b) => b.onclick = () => { cat = b.dataset.cat; draw(body); });
    $$('[data-id] [data-a]', body).forEach((b) => b.onclick = async () => {
      const w = store.data.wishlist.find((x) => x.id === b.closest('[data-id]').dataset.id);
      const a = b.dataset.a;
      if (a === 'star') w.star = !w.star;
      if (a === 'done') w.done = !w.done;
      if (a === 'del') { if (!(await confirmBox('リストから消しますか？', w.name, '削除', { destructive: true }))) return; store.data.wishlist = store.data.wishlist.filter((x) => x !== w); }
      if (a === 'plan') { planSpot(w); return; }
      haptic(); store.save(); draw(body);
    });
    $('#wl-search', body).onclick = () => addSpot(() => draw(body));
    $('#wl-plan', body).onclick = () => suggestPlan();
    $('#wl-photo', body).onchange = async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const prog = $('#wl-prog', body);
      const say = (m) => (prog.innerHTML = `<div class="hstack small" style="margin-bottom:12px"><span class="spinner"></span>${esc(m)}</div>`);
      try {
        const n = await spotsFromPhotos(files, say);
        prog.innerHTML = '';
        toast(`${n}件をリストに追加しました`);
        draw(body);
      } catch (err) { prog.innerHTML = `<div class="small" style="color:var(--red);margin-bottom:12px">${esc(friendlyError(err))}</div>`; }
    };
  }
}
async function spotsFromPhotos(files, say) {
  const small = [];
  for (const f of files) small.push(await shrinkImage(f, 1568));
  let spots = [];
  if (store.data.settings.apiKey) {
    say('AIが場所の情報を取り出しています…');
    const content = await imageContent(small);
    content.push({ type: 'text', text: 'これらは旅行で行きたい場所のスクリーンショット（Googleマップ、検索結果、SNS、乗換案内など）です。写っている場所・お店・宿・乗り物の情報を spots に1件ずつ取り出してください。営業時間・料金・エリア・住所が読めれば入れ、無ければ空文字。stay_minutes は一般的な滞在時間の目安。乗換案内なら category=交通 にして transport_* に区間と所要時間を入れる。' });
    spots = (await callClaude({ system: '旅行の計画を手伝うアシスタントです。', content, schema: WISH_SCHEMA })).spots;
  } else {
    for (let i = 0; i < small.length; i++) {
      say(`文字を読み取っています… ${i + 1}/${small.length}`);
      const text = await ocr(small[i]);
      const lines = text.split('\n').map((l) => l.replace(/\s+/g, '')).filter((l) => l.length >= 2 && l.length < 30);
      const name = lines.find((l) => !/^\d|営業|評価|クチコミ|ルート|保存|共有|電話|閉店|開店|km|分$/.test(l)) || lines[0] || 'スポット';
      const hours = (/(\d{1,2}:\d{2})\s*[~〜～-]\s*(\d{1,2}:\d{2})/.exec(text) || [])[0] || '';
      spots.push({ name, category: /ホテル|旅館|宿/.test(text) ? '宿' : /カフェ|喫茶/.test(text) ? 'カフェ' : /食堂|ラーメン|寿司|レストラン|居酒屋/.test(text) ? 'グルメ' : '観光', area: '', address: (/〒?\d{3}-\d{4}.*|.+[都道府県].+[市区町村].*/.exec(text) || [])[0] || '', hours, price: '', stay_minutes: 60, notes: '' });
    }
  }
  const keys = [];
  for (const b of small) { const k = 'img:' + uid(); await blobs.put(k, b); keys.push(k); }
  for (const s of spots) {
    if (store.data.wishlist.some((w) => w.name === s.name)) continue;
    store.data.wishlist.push({ id: uid(), name: s.name, category: s.category || 'その他', area: s.area, address: s.address, hours: s.hours, price: s.price, stay: s.stay_minutes || 60, notes: [s.notes, s.transport_from && `${s.transport_from}→${s.transport_to} ${s.transport_time}`].filter(Boolean).join('\n'), imgs: keys, added: Date.now(), star: false, done: false });
  }
  store.save();
  return spots.length;
}
function addSpot(done) {
  sheet({
    title: 'スポット検索', left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="list"><div class="row">${I.search}<input type="text" id="sp-q" class="left" placeholder="例：伏見稲荷大社、天神 ラーメン" enterkeyhint="search"></div></div><div id="sp-r" style="margin-top:12px"></div>
        <div class="section-foot">名前を入れて検索すると、住所・営業時間・電話番号などを自動で入れます（OpenStreetMap のデータ）。</div>`;
      const q = $('#sp-q', body);
      setTimeout(() => q.focus(), 400);
      q.onkeydown = async (e) => {
        if (e.key !== 'Enter') return;
        q.blur();
        const r = $('#sp-r', body);
        r.innerHTML = '<span class="spinner"></span>';
        let list = [];
        try { list = await spotSearch(q.value, store.data.settings.place); } catch {}
        r.innerHTML = list.length ? `<div class="list">${list.map((x, i) => `<button class="row" data-i="${i}">${I.pin}<div class="grow">${esc(x.name)}<div class="sub">${esc(x.address)}${x.hours ? '・' + esc(x.hours) : ''}</div></div><span style="color:var(--blue)">${I.plus}</span></button>`).join('')}</div>` : '<div class="empty">見つかりませんでした</div>';
        $$('[data-i]', r).forEach((b) => b.onclick = () => {
          const x = list[+b.dataset.i];
          const category = x.type === 'hotel' ? '宿' : x.type === 'meal' ? (x.kind === 'cafe' ? 'カフェ' : 'グルメ') : ['train', 'bus', 'flight', 'ferry'].includes(x.type) ? '交通' : '観光';
          store.data.wishlist.push({ id: uid(), name: x.name, category, area: '', address: x.address, lat: x.lat, lon: x.lon, hours: x.hours, price: x.fee, stay: 60, notes: [x.phone, x.website].filter(Boolean).join('\n'), added: Date.now(), star: false, done: false });
          store.save(); haptic(); toast(`「${x.name}」を追加しました`); done?.(); close();
        });
      };
    },
  });
}
function planSpot(w) {
  const d = new Date(); d.setMinutes(0); d.setHours(d.getHours() + 1);
  const t = currentTrip();
  const first = t && events(t).find((e) => e.at && e.at > new Date());
  const start = first ? first.at : d;
  editItem({ id: uid(), type: CAT_TYPE[w.category] || 'activity', title: w.name, address: w.address, lat: w.lat, lon: w.lon, start: toLocalISO(start), end: toLocalISO(new Date(start.getTime() + (w.stay || 60) * 60000)), notes: [w.hours && `営業時間: ${w.hours}`, w.price && `料金: ${w.price}`, w.notes].filter(Boolean).join('\n'), reserved: w.category !== '宿', remind: 30 }, {
    onSave: (it) => { ensureTrip().items.push(it); store.save(); renderTrip(); toast('旅程に入れました'); },
  });
}
// AI：行きたいリストと今の旅程・日程から、無理のない旅程を提案してもらう
function suggestPlan() {
  const t = currentTrip();
  const wl = store.data.wishlist.filter((w) => !w.done);
  if (!wl.length) { toast('行きたいリストが空です'); return; }
  if (!store.data.settings.apiKey) { toast('旅程の提案には「設定」で Claude の API キーを入れてください', 3500); return; }
  sheet({
    title: '旅程を提案', left: '閉じる',
    build(body) {
      const evs = t ? events(t).filter((e) => e.at) : [];
      const first = evs[0]?.at, last = evs[evs.length - 1]?.at;
      body.innerHTML = `<div class="list">
          <div class="row"><div class="grow">開始日</div><input type="date" id="pl-s" value="${first ? dayKey(first) : dayKey(new Date())}"></div>
          <div class="row"><div class="grow">終了日</div><input type="date" id="pl-e" value="${last ? dayKey(last) : dayKey(new Date())}"></div>
          <div class="row"><div class="grow">1日の動き始め</div><input type="time" id="pl-a" value="09:00"></div>
          <div class="row"><div class="grow">ペース</div><select id="pl-p"><option>ゆったり</option><option selected>ふつう</option><option>たくさん回る</option></select></div>
          <div class="row"><div style="flex:none">希望</div><input type="text" id="pl-h" class="left" placeholder="例：2日目は雨なら屋内中心"></div>
        </div>
        <div class="section-foot">行きたいリスト ${wl.length}件と、今の旅程（${t?.items.length || 0}件の予定・宿・移動）をもとに、移動時間・営業時間・チェックイン時刻を考えた予定を提案します。</div>
        <div style="margin-top:14px"><button class="btn" id="pl-go">${I.sparkles}提案してもらう</button></div><div id="pl-prog" style="margin-top:12px"></div>`;
      $('#pl-go', body).onclick = async (e) => {
        e.target.disabled = true;
        $('#pl-prog', body).innerHTML = '<div class="hstack small"><span class="spinner"></span>AIが旅程を考えています…（30秒〜1分ほど）</div>';
        try {
          const existing = (t?.items || []).map((i) => ({ type: i.type, title: i.title, from: i.from, to: i.to, start: i.start, end: i.end, address: i.address }));
          const spots = wl.map((w) => ({ name: w.name, category: w.category, area: w.area, address: w.address, hours: w.hours, price: w.price, stay_minutes: w.stay, star: !!w.star, notes: w.notes }));
          const text = `${todayText()}\n旅行期間: ${$('#pl-s', body).value} 〜 ${$('#pl-e', body).value}\n毎日 ${$('#pl-a', body).value} ごろから行動。ペース: ${$('#pl-p', body).value}。${$('#pl-h', body).value ? '希望: ' + $('#pl-h', body).value : ''}\n\n今の旅程（変えずに残す・時間が重ならないように）:\n${JSON.stringify(existing)}\n\n行きたいリスト（⭐️ star=true を優先）:\n${JSON.stringify(spots)}\n\n行きたい場所を、エリアのまとまり・移動時間・営業時間・宿の場所とチェックイン時刻を考えて旅程の空き時間に組み込み、新しく追加する予定だけを items で返してください。場所の間の移動（電車・バス・徒歩）が必要なら移動の予定も入れてください（運賃や番線が不明なら空文字）。食事の時間も考慮。入りきらない場所は入れなくてよいです。notes には「なぜこの順番か」などの短い説明を入れてください。reserved は false、is_alternate は false、route_group は "main"、source_image は 0。`;
          const r = await callClaude({ system: SYSTEM_PLAN, content: [{ type: 'text', text }], schema: (await import('./ai.js')).PLAN_SCHEMA, effort: 'high' });
          const items = r.items.map((x) => ({ id: uid(), type: TYPES[x.type] ? x.type : 'activity', title: x.title, from: x.from, to: x.to, start: x.start, end: x.end, operator: x.operator, number: x.number, platform: x.platform, seat: x.seat, confirmation: '', cost: x.cost, address: x.address, notes: x.notes, reserved: false, imgs: [], _alt: false, _group: 'main', remind: 30 }));
          if (!items.length) { $('#pl-prog', body).innerHTML = '<div class="small">追加できる予定が見つかりませんでした</div>'; e.target.disabled = false; return; }
          review(items, '', null);
        } catch (err) { $('#pl-prog', body).innerHTML = `<div class="small" style="color:var(--red)">${esc(friendlyError(err))}</div>`; e.target.disabled = false; }
      };
    },
  });
}
const SYSTEM_PLAN = 'あなたは日本と世界の旅行に詳しいトラベルプランナーです。無理のない、移動の無駄が少ない旅程を組みます。日時は必ず YYYY-MM-DDTHH:MM（現地時刻）。';

// ===== 旅費（自動計算） =====
const num = (s) => parseFloat(String(s || '').replace(/[^\d.]/g, '')) || 0;
export function tripCosts(t = currentTrip()) {
  const by = {};
  for (const it of t?.items || []) { const v = num(it.cost); if (v) by[it.type] = (by[it.type] || 0) + v; }
  const planned = Object.values(by).reduce((a, b) => a + b, 0);
  const spent = store.data.expenses.filter((e) => !t || e.trip === t.id).reduce((a, e) => a + (e.jpy ?? e.amount), 0);
  return { by, planned, spent };
}
const EXP_CATS = ['🍙 食事', '🚃 交通', '🛏 宿', '🎟 観光', '🛍 買い物', '💊 その他'];
export function openBudget() {
  page({ title: '旅費', build(body) { draw(body); } });
  function draw(body) {
    const t = currentTrip();
    const b = store.data.budget;
    const { by, planned, spent } = tripCosts(t);
    const exps = store.data.expenses.filter((e) => !t || e.trip === t.id).sort((a, b) => b.at - a.at);
    const total = planned + spent;
    const per = total / Math.max(1, b.people);
    const pct = b.limit ? Math.min(100, (total / b.limit) * 100) : 0;
    body.innerHTML = `
      <div class="card"><h3>${I.wallet} ${esc(t?.name || '旅')}の旅費</h3>
        <div class="big-num" style="text-align:left">${yen(total)}</div>
        <div class="small muted">予約・予定の料金 ${yen(planned)} ＋ 使ったお金 ${yen(spent)}</div>
        ${b.limit ? `<div class="progress" style="margin-top:10px"><i style="width:${pct}%;background:${pct >= 100 ? 'var(--red)' : pct > 80 ? 'var(--orange)' : 'var(--green)'}"></i></div><div class="small muted" style="margin-top:4px">予算 ${yen(b.limit)} のうち ${Math.round(pct)}%（残り ${yen(b.limit - total)}）</div>` : ''}
        ${b.people > 1 ? `<div style="margin-top:8px;font-weight:600">1人あたり ${yen(Math.ceil(per))}（${b.people}人）</div>` : ''}
      </div>
      <div class="list">
        <div class="row"><div class="grow">人数（割り勘）</div><input type="number" id="bg-p" min="1" value="${b.people}" style="max-width:80px"></div>
        <div class="row"><div class="grow">予算</div><input type="number" id="bg-l" min="0" value="${b.limit || ''}" placeholder="未設定" style="max-width:140px"></div>
      </div>
      <div class="section-title">予定の料金（旅程から自動）</div>
      <div class="list">${Object.keys(by).length ? Object.entries(by).map(([k, v]) => `<div class="row"><span class="ico" style="background:${TYPES[k].color}">${I[TYPES[k].icon]}</span><div class="grow">${TYPES[k].name}</div><span class="val">${yen(v)}</span></div>`).join('') : '<div class="row muted small">旅程の予定に「料金」を入れると自動で合計します</div>'}</div>
      <div class="section-title">使ったお金</div>
      <div class="card" style="padding:12px">
        <div class="chips" style="flex-wrap:wrap">${EXP_CATS.map((c, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-c="${i}">${c}</button>`).join('')}</div>
        <div class="hstack"><input type="number" inputmode="decimal" id="ex-a" placeholder="金額" style="flex:1;height:44px;border-radius:10px;border:0;background:var(--fill);padding:0 12px;font-size:18px">
          <select id="ex-cur" style="height:44px;border-radius:10px;border:0;background:var(--fill);padding:0 8px">${['JPY', 'USD', 'EUR', 'KRW', 'TWD', 'CNY', 'THB', 'GBP', 'AUD', 'SGD', 'HKD', 'VND', 'PHP', 'IDR', 'MYR'].map((c) => `<option ${c === (b.currency || 'JPY') ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <input type="text" id="ex-m" placeholder="メモ（任意）" style="width:100%;height:40px;margin-top:8px;border-radius:10px;border:0;background:var(--fill);padding:0 12px">
        <button class="btn" id="ex-add" style="margin-top:10px">${I.plus}記録する</button>
      </div>
      <div class="list">${exps.length ? exps.map((e) => `<div class="row"><div class="grow">${esc(e.cat)} ${esc(e.memo || '')}<div class="sub">${new Date(e.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${e.currency !== 'JPY' ? `・${e.amount} ${e.currency}` : ''}</div></div><span class="val">${yen(e.jpy ?? e.amount)}</span><button data-del="${e.id}" style="color:var(--red)">${I.trash}</button></div>`).join('') : '<div class="row muted small">まだ記録はありません</div>'}</div>
      ${exps.length ? `<div class="section-title">分類ごと</div><div class="list">${EXP_CATS.map((c) => { const v = exps.filter((e) => e.cat === c).reduce((a, e) => a + (e.jpy ?? e.amount), 0); return v ? `<div class="row"><div class="grow">${c}</div><span class="val">${yen(v)}</span></div>` : ''; }).join('')}</div>` : ''}`;
    let cat = EXP_CATS[0];
    $$('[data-c]', body).forEach((x) => x.onclick = () => { $$('[data-c]', body).forEach((y) => y.classList.toggle('on', y === x)); cat = EXP_CATS[+x.dataset.c]; });
    $('#bg-p', body).onchange = (e) => { b.people = Math.max(1, +e.target.value || 1); store.save(); draw(body); };
    $('#bg-l', body).onchange = (e) => { b.limit = +e.target.value || 0; store.save(); draw(body); };
    $('#ex-add', body).onclick = async () => {
      const amount = +$('#ex-a', body).value;
      if (!amount) { toast('金額を入れてください'); return; }
      const currency = $('#ex-cur', body).value;
      b.currency = currency;
      let jpy = amount;
      if (currency !== 'JPY') { const r = await rate(currency); jpy = r ? Math.round(amount * r) : amount; if (!r) toast('為替を取得できなかったので、そのままの数字で記録しました'); }
      store.data.expenses.push({ id: uid(), trip: t?.id || null, at: Date.now(), amount, currency, jpy, cat, memo: $('#ex-m', body).value });
      store.save(); haptic(); toast('記録しました'); draw(body);
    };
    $$('[data-del]', body).forEach((x) => x.onclick = () => { store.data.expenses = store.data.expenses.filter((e) => e.id !== x.dataset.del); store.save(); draw(body); });
  }
}

// ===== 通貨換算 =====
let rates = null;
async function loadRates() {
  if (rates && Date.now() - rates.t < 3600e3) return rates.r;
  try {
    const j = await (await fetch('https://open.er-api.com/v6/latest/JPY')).json();
    rates = { t: Date.now(), r: j.rates };
    localStorage.setItem('tabinavi.fx', JSON.stringify(rates));
  } catch { try { rates = JSON.parse(localStorage.getItem('tabinavi.fx')); } catch {} }
  return rates?.r;
}
async function rate(cur) { const r = await loadRates(); return r?.[cur] ? 1 / r[cur] : null; } // 1 cur = ? 円
export function openCurrency() {
  page({
    title: '通貨換算',
    async build(body) {
      body.innerHTML = '<span class="spinner"></span>';
      const r = await loadRates();
      if (!r) { body.innerHTML = '<div class="empty">為替レートを取得できませんでした</div>'; return; }
      const curs = ['USD', 'EUR', 'KRW', 'TWD', 'CNY', 'HKD', 'THB', 'SGD', 'GBP', 'AUD', 'VND', 'PHP', 'IDR', 'MYR', 'CAD', 'CHF', 'NZD', 'INR'];
      let cur = localStorage.getItem('tabinavi.cur') || 'USD';
      const draw = () => {
        body.innerHTML = `<div class="card">
          <div class="hstack"><select id="cx-c" style="height:40px;border-radius:10px;border:0;background:var(--fill);padding:0 10px;font-weight:600">${curs.map((c) => `<option ${c === cur ? 'selected' : ''}>${c}</option>`).join('')}</select><input type="number" inputmode="decimal" id="cx-a" value="100" class="big-num" style="flex:1;border:0;background:none;min-width:0"></div>
          <div style="text-align:center;color:var(--label3);margin:4px 0">${I.swap}</div>
          <div class="hstack"><b style="width:76px;padding-left:10px">JPY</b><input type="number" inputmode="decimal" id="cx-y" class="big-num" style="flex:1;border:0;background:none;min-width:0"></div></div>
          <div class="section-foot">1 ${cur} ＝ ${(1 / r[cur]).toFixed(cur === 'KRW' || cur === 'VND' || cur === 'IDR' ? 4 : 2)} 円（${new Date(rates.t).toLocaleString('ja-JP')} 時点・目安）</div>
          <div class="section-title">早見表</div>
          <div class="list">${[1, 5, 10, 50, 100, 500, 1000, 5000].map((v) => `<div class="row"><div class="grow">${v.toLocaleString()} ${cur}</div><span class="val">${yen(v / r[cur])}</span></div>`).join('')}</div>`;
        const a = $('#cx-a', body), y = $('#cx-y', body);
        const fromA = () => { y.value = Math.round((+a.value || 0) / r[cur]); };
        const fromY = () => { a.value = ((+y.value || 0) * r[cur]).toFixed(2); };
        a.oninput = fromA; y.oninput = fromY; fromA();
        $('#cx-c', body).onchange = (e) => { cur = e.target.value; localStorage.setItem('tabinavi.cur', cur); draw(); };
      };
      draw();
    },
  });
}

// ===== 持ち物リスト =====
const PACK = {
  基本: ['財布・現金', 'クレジットカード', '身分証・保険証', 'スマホの充電器', 'モバイルバッテリー', '着替え', '下着・靴下', '歯ブラシ', '常備薬', 'ハンカチ・ティッシュ'],
  'ドミトリー・カプセル': ['耳栓', 'アイマスク', 'イヤホン（充電済み）', 'イヤホンの充電ケース', '南京錠', 'サンダル', '長めの充電ケーブル', 'タオル', '小さなライト', 'ジップ袋（濡れ物用）'],
  飛行機: ['搭乗券（スマホ）', '液体は100ml以下の袋', 'ネックピロー', '上着（機内は寒い）'],
  海外: ['パスポート', '変換プラグ', 'eSIM・Wi-Fi', '海外旅行保険の書類', '少額の現地通貨'],
  冬: ['手袋', 'カイロ', 'マフラー', '保湿クリーム'],
  夏: ['日焼け止め', '帽子', '折りたたみ傘', '虫よけ', '扇子・ハンディファン'],
};
export function openPacking() {
  if (!store.data.checklist) { store.data.checklist = PACK.基本.map((t) => ({ id: uid(), text: t, done: false })); store.save(); }
  page({ title: '持ち物リスト', build(body) { draw(body); } });
  function draw(body) {
    const list = store.data.checklist;
    const done = list.filter((x) => x.done).length;
    body.innerHTML = `
      <div class="card"><div class="hstack"><b style="flex:1">${done} / ${list.length} 準備OK</b>${done === list.length && list.length ? '🎉' : ''}</div><div class="progress" style="margin-top:8px"><i style="width:${list.length ? (done / list.length) * 100 : 0}%;background:var(--green)"></i></div></div>
      <div class="list" style="margin-bottom:12px"><div class="row">${I.plus}<input type="text" id="pk-new" class="left" placeholder="持ち物を追加" enterkeyhint="done"></div></div>
      <div class="list">${list.map((x) => `<div class="row check-row ${x.done ? 'done' : ''}" data-id="${x.id}"><button class="check ${x.done ? 'on' : ''}" data-a="t">${x.done ? I.check : ''}</button><div class="grow" data-a="t">${esc(x.text)}</div><button data-a="d" style="color:var(--label3)">×</button></div>`).join('')}</div>
      <div class="section-title">テンプレートから追加</div>
      <div class="chips" style="flex-wrap:wrap">${Object.keys(PACK).map((k) => `<button class="chip" data-tpl="${k}">${k}</button>`).join('')}</div>
      <div class="hstack" style="margin-top:12px"><button class="btn secondary" id="pk-reset">全部外す</button><button class="btn danger" id="pk-clear">空にする</button></div>`;
    $('#pk-new', body).onkeydown = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { list.push({ id: uid(), text: e.target.value.trim(), done: false }); store.save(); draw(body); $('#pk-new', body).focus(); } };
    $$('[data-a]', body).forEach((b) => b.onclick = () => {
      const x = list.find((y) => y.id === b.closest('[data-id]').dataset.id);
      if (b.dataset.a === 't') { x.done = !x.done; haptic(); } else store.data.checklist = list.filter((y) => y !== x);
      store.save(); draw(body);
    });
    $$('[data-tpl]', body).forEach((b) => b.onclick = () => { for (const t of PACK[b.dataset.tpl]) if (!list.some((x) => x.text === t)) list.push({ id: uid(), text: t, done: false }); store.save(); draw(body); toast('追加しました'); });
    $('#pk-reset', body).onclick = () => { list.forEach((x) => (x.done = false)); store.save(); draw(body); };
    $('#pk-clear', body).onclick = async () => { if (await confirmBox('リストを空にしますか？', '', '空にする', { destructive: true })) { store.data.checklist = []; store.save(); draw(body); } };
  }
}
