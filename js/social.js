// 旅仲間：共有コードでつながる（アカウント登録なし）
//  ・ホストが「参加受付」をオンにしている間だけ、6けたの共有コードを発行（受付中のコードは重ならない）
//  ・コードで参加した人は、その後ずっと同期（旅程・チャット・位置）。脱退・追放もできる
//  ・裏では Firebase（Cloud Firestore）を使う。ログインは端末ごとの「匿名ログイン」で自動
//
// Firestore の構成
//   tabi_codes/{6けた}            … 受付中のコード → { gid, host }
//   tabi_groups/{gid}             … { name, host, code, trip, tripAt, tripBy, kicked: [uid] }
//   tabi_groups/{gid}/members/{uid} … { name, color, joined, loc, sharing, seen }
//   tabi_groups/{gid}/messages/{id} … { uid, name, text, at, kind, lat, lon }
import { $, $$, esc, uid, store, page, sheet, toast, confirmBox, haptic, I, switchHTML, copyText, hm } from './util.js';
import { currentTrip, renderTrip } from './trip.js';

const COLORS = ['#FF3B30', '#FF9500', '#34C759', '#007AFF', '#AF52DE', '#FF2D55', '#5AC8FA', '#A2845E'];
let fb = null, db = null, me = null;
let unsub = [];
export const social = { group: null, members: [], messages: [], ready: false, error: '', listeners: new Set() };
const emit = () => social.listeners.forEach((f) => f());
const S = () => store.data.social;

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('通信できませんでした')); document.head.append(s); });
}
async function config() {
  if (S().firebase) {
    const txt = S().firebase.slice(S().firebase.indexOf('{'), S().firebase.lastIndexOf('}') + 1);
    try { return JSON.parse(txt); } catch {}
    try { return new Function(`return (${txt});`)(); } catch { throw new Error('Firebase の設定の形が正しくありません'); }
  }
  // このアプリと一緒に置いた設定（firebase-config.js）を使う
  if (!window.FIREBASE_CONFIG) { try { await loadScript('firebase-config.js'); } catch {} }
  if (window.FIREBASE_CONFIG) return window.FIREBASE_CONFIG;
  throw new Error('共有サーバーがまだ設定されていません（設定 → 旅仲間の共有 → 共有サーバー）');
}
export async function connect() {
  if (db) return;
  const base = 'https://www.gstatic.com/firebasejs/10.12.5/';
  if (!window.firebase?.firestore) for (const f of ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js']) await loadScript(base + f);
  const cfg = await config();
  fb = firebase.apps.find((a) => a.name === 'tabi') || firebase.initializeApp(cfg, 'tabi');
  const cred = fb.auth().currentUser || (await fb.auth().signInAnonymously()).user;
  me = cred.uid;
  db = fb.firestore();
}
const g = () => db.collection('tabi_groups').doc(S().room);
const ts = () => firebase.firestore.FieldValue.serverTimestamp();

// 起動時：参加中のグループがあれば見張りを始める
export async function startSocial() {
  if (!S().room) return;
  try { await connect(); watch(); }
  catch (e) { social.error = e.message; emit(); }
}
function stop() { unsub.forEach((u) => u()); unsub = []; social.group = null; social.members = []; social.messages = []; }
let lastMsgCount = -1;
function watch() {
  stop();
  const gid = S().room;
  unsub.push(g().onSnapshot((d) => {
    if (!d.exists) { leaveLocal('グループが解散されました'); return; }
    social.group = { id: gid, ...d.data() };
    if ((social.group.kicked || []).includes(me)) { leaveLocal('グループから外されました'); return; }
    pullTrip();
    emit();
  }, (e) => { social.error = e.code === 'permission-denied' ? 'Firebase のルールで共有が許可されていません（設定 → 旅仲間の共有 を確認）' : e.message; emit(); }));
  unsub.push(g().collection('members').onSnapshot((q) => {
    social.members = q.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (social.group && !social.members.some((m) => m.id === me)) { leaveLocal('グループから外されました'); return; }
    emit();
  }));
  unsub.push(g().collection('messages').orderBy('at', 'desc').limit(200).onSnapshot((q) => {
    social.messages = q.docs.map((d) => ({ id: d.id, ...d.data() })).reverse();
    const last = social.messages[social.messages.length - 1];
    if (lastMsgCount >= 0 && social.messages.length > lastMsgCount && last && last.uid !== me && !document.querySelector('#chat-list')) toast(`💬 ${last.name}：${(last.text || '位置を共有しました').slice(0, 30)}`, 3500);
    lastMsgCount = social.messages.length;
    emit();
  }));
  social.ready = true;
  if (S().share) startLocation();
}
function leaveLocal(msg) {
  stop(); stopLocation();
  S().room = ''; store.save();
  social.ready = false;
  if (msg) toast(msg, 4000);
  emit();
}

// ===== グループをつくる・参加・脱退・追放 =====
export async function createGroup(name) {
  await connect();
  const gid = uid() + uid() + uid(); // 推測されにくい長い名前
  await db.collection('tabi_groups').doc(gid).set({ name: name || '旅仲間', host: me, code: null, trip: null, tripAt: 0, kicked: [], created: ts() });
  S().room = gid; store.save();
  await joinMember();
  watch();
}
async function joinMember() {
  const used = new Set(social.members.map((m) => m.color));
  await g().collection('members').doc(me).set({ name: S().name || '旅人', color: COLORS.find((c) => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)], joined: ts(), seen: ts(), sharing: !!S().share, loc: null }, { merge: true });
}
export async function joinByCode(code) {
  await connect();
  const c = await db.collection('tabi_codes').doc(code).get();
  if (!c.exists) throw new Error('そのコードは見つかりません（受付が終わっているかもしれません）');
  const gid = c.data().gid;
  const gd = await db.collection('tabi_groups').doc(gid).get();
  if (!gd.exists) throw new Error('グループが見つかりません');
  if ((gd.data().kicked || []).includes(me)) throw new Error('このグループには参加できません');
  S().room = gid; store.save();
  await joinMember();
  await g().collection('messages').add({ uid: me, name: S().name || '旅人', text: `${S().name || '旅人'}さんが参加しました`, kind: 'system', at: ts() });
  watch();
}
// 参加受付のオン・オフ（ホストだけ）。オンの間だけ、重ならない6けたのコードを持つ
export async function setRecruit(on) {
  const grp = social.group;
  if (!grp || grp.host !== me) return;
  if (!on) {
    if (grp.code) await db.collection('tabi_codes').doc(grp.code).delete().catch(() => {});
    await g().update({ code: null });
    return;
  }
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const ref = db.collection('tabi_codes').doc(code);
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists) throw new Error('dup');
        tx.set(ref, { gid: grp.id, host: me, at: ts() });
      });
      await g().update({ code });
      return code;
    } catch (e) { if (e.message !== 'dup') throw e; }
  }
  throw new Error('コードを作れませんでした。もう一度お試しください');
}
export async function leaveGroup() {
  const grp = social.group;
  const others = social.members.filter((m) => m.id !== me).sort((a, b) => (a.joined?.seconds || 0) - (b.joined?.seconds || 0));
  if (grp?.host === me) {
    if (grp.code) await db.collection('tabi_codes').doc(grp.code).delete().catch(() => {});
    if (others.length) await g().update({ host: others[0].id, code: null });
    else { await g().delete(); leaveLocal(''); return; }
  }
  await g().collection('messages').add({ uid: me, name: S().name || '旅人', text: `${S().name || '旅人'}さんが抜けました`, kind: 'system', at: ts() }).catch(() => {});
  await g().collection('members').doc(me).delete();
  leaveLocal('グループから抜けました');
}
export async function kick(id) {
  if (social.group?.host !== me) return;
  await g().update({ kicked: firebase.firestore.FieldValue.arrayUnion(id) });
  await g().collection('members').doc(id).delete();
}
export async function disband() {
  const grp = social.group;
  if (grp?.host !== me) return;
  if (grp.code) await db.collection('tabi_codes').doc(grp.code).delete().catch(() => {});
  await g().delete();
  leaveLocal('グループを解散しました');
}
export async function rename(name) {
  S().name = name; store.save();
  if (S().room && db) await g().collection('members').doc(me).update({ name }).catch(() => {});
}

// ===== チャット =====
export async function send(text, extra = {}) {
  if (!text && !extra.kind) return;
  await g().collection('messages').add({ uid: me, name: S().name || '旅人', text: text || '', at: ts(), kind: 'text', ...extra });
}

// ===== 旅程の共有（グループの旅程 ⇄ 端末の旅程。新しい方を使う） =====
let pushT;
export function linkTrip(trip) {
  if (!S().room || !trip) return;
  trip.groupId = S().room;
  trip.updated = Date.now();
  store.save();
  pushTrip(trip);
}
export function pushTrip(trip = currentTrip()) {
  if (!db || !S().room || trip?.groupId !== S().room) return;
  clearTimeout(pushT);
  pushT = setTimeout(() => {
    const clean = JSON.parse(JSON.stringify(trip, (k, v) => (k === 'imgs' ? undefined : v)));
    g().update({ trip: clean, tripAt: trip.updated || Date.now(), tripBy: me }).catch(() => {});
  }, 800);
}
function pullTrip() {
  const grp = social.group;
  if (!grp?.trip || grp.tripBy === me) return;
  const trips = store.data.trips;
  let local = trips.find((t) => t.groupId === grp.id);
  if (local && (local.updated || 0) >= grp.tripAt) return;
  const imgs = Object.fromEntries((local?.items || []).map((i) => [i.id, i.imgs]));
  const remote = { ...grp.trip, groupId: grp.id, updated: grp.tripAt };
  remote.items = (remote.items || []).map((i) => ({ ...i, imgs: imgs[i.id] || [] }));
  if (local) Object.assign(local, remote);
  else { remote.id = remote.id || uid(); trips.push(remote); if (!store.data.currentTrip) store.data.currentTrip = remote.id; }
  store.save(true);
  renderTrip();
}

// ===== 位置の共有（アプリを開いている間） =====
let watchId = null, lastSent = null;
export function myPos() { return lastSent; }
export function startLocation() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition((p) => {
    const c = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() };
    window.dispatchEvent(new CustomEvent('tabi-pos', { detail: c }));
    if (!S().share || !S().room || !db) return;
    const moved = !lastSent || Math.hypot(c.lat - lastSent.lat, c.lon - lastSent.lon) > 0.0004;
    if (moved || c.at - lastSent.at > 60000) {
      lastSent = c;
      g().collection('members').doc(me).update({ loc: c, seen: ts(), sharing: true }).catch(() => {});
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
}
export function stopLocation() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
export async function setShare(on) {
  S().share = on; store.save();
  if (on) startLocation();
  if (S().room && db) await g().collection('members').doc(me).update({ sharing: on, ...(on ? {} : { loc: null }) }).catch(() => {});
}
export const myId = () => me;

// ===== 画面 =====
const ago = (t) => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 90 ? 'たった今' : s < 3600 ? `${Math.round(s / 60)}分前` : `${Math.round(s / 3600)}時間前`; };
export function openSocial() {
  let off;
  page({
    title: '旅仲間',
    build(body) { const draw = () => render(body); off = draw; social.listeners.add(draw); draw(); if (S().room && !social.ready) startSocial(); },
    onClose: () => social.listeners.delete(off),
  });
}
function render(body) {
  const s = S();
  if (!s.room) {
    body.innerHTML = `
      <div class="card" style="text-align:center"><div style="font-size:44px">👫</div><b>友達と旅をつなげる</b><div class="small muted" style="margin-top:4px">共有コードを入れるだけ。アカウント登録はいりません。<br>旅程・チャット・いまいる場所を共有できます。</div></div>
      <div class="list"><div class="row"><div style="flex:none">あなたの名前</div><input type="text" id="sc-name" value="${esc(s.name)}" placeholder="例：たろう"></div></div>
      <div class="section-title">コードで参加</div>
      <div class="list"><div class="row"><input type="text" inputmode="numeric" maxlength="6" id="sc-code" class="left mono" placeholder="6けたの共有コード" style="font-size:24px;letter-spacing:.2em"></div></div>
      <div style="margin-top:10px"><button class="btn" id="sc-join">参加する</button></div>
      <div class="section-title">自分がホストになる</div>
      <div class="list"><div class="row"><div style="flex:none">グループ名</div><input type="text" id="sc-gname" placeholder="例：大阪旅行"></div></div>
      <div style="margin-top:10px"><button class="btn secondary" id="sc-create">グループをつくる</button></div>
      ${social.error ? `<div class="section-foot" style="color:var(--red)">${esc(social.error)}</div>` : ''}`;
    $('#sc-name', body).onchange = (e) => rename(e.target.value.trim());
    $('#sc-join', body).onclick = async (e) => {
      const code = $('#sc-code', body).value.replace(/\D/g, '');
      if (code.length !== 6) { toast('6けたのコードを入れてください'); return; }
      if (!s.name) { toast('名前を入れてください'); return; }
      e.target.disabled = true;
      try { await joinByCode(code); toast('参加しました'); } catch (err) { toast(err.message, 4000); e.target.disabled = false; }
    };
    $('#sc-create', body).onclick = async (e) => {
      if (!s.name) { toast('名前を入れてください'); return; }
      e.target.disabled = true;
      try { await createGroup($('#sc-gname', body).value.trim()); toast('グループをつくりました'); } catch (err) { toast(err.message, 4000); e.target.disabled = false; }
    };
    return;
  }
  const grp = social.group;
  if (!grp) { body.innerHTML = social.error ? `<div class="empty" style="color:var(--red)">${esc(social.error)}</div><button class="btn danger" id="sc-force">この端末の参加情報を消す</button>` : '<div class="empty"><span class="spinner"></span></div>'; $('#sc-force', body)?.addEventListener('click', () => leaveLocal('')); return; }
  const host = grp.host === me;
  const linked = store.data.trips.find((t) => t.groupId === grp.id);
  const unread = social.messages.length;
  body.innerHTML = `
    <div class="card"><div class="hstack"><span style="font-size:30px">👫</span><div style="flex:1"><b style="font-size:19px">${esc(grp.name)}</b><div class="small muted">${social.members.length}人${host ? '・あなたがホスト' : ''}</div></div></div></div>
    ${host ? `<div class="list">
      <div class="row"><div class="grow">参加受付<div class="sub">オンの間だけ共有コードが有効になります</div></div>${switchHTML('', !!grp.code, 'id="sc-rec"')}</div>
      ${grp.code ? `<div class="row" style="flex-direction:column;align-items:center;padding:16px"><div class="small muted">共有コード</div><div class="mono" style="font-size:44px;font-weight:700;letter-spacing:.15em">${grp.code}</div><div class="hstack"><button class="btn small secondary" id="sc-copy">${I.copy}コピー</button><button class="btn small secondary" id="sc-sharecode">${I.share}送る</button></div><div class="small muted" style="margin-top:6px">全員そろったら受付をオフにしてください（参加済みの人はそのままつながります）</div></div>` : ''}
    </div>` : ''}
    <div class="section-title">メンバー</div>
    <div class="list">${social.members.map((m) => `<div class="row"><span style="width:12px;height:12px;border-radius:6px;background:${m.color}"></span><div class="grow">${esc(m.name)}${m.id === me ? '（あなた）' : ''}${m.id === grp.host ? ' <span class="badge">ホスト</span>' : ''}<div class="sub">${m.sharing && m.loc ? `📍 位置を共有中・${ago(m.loc.at)}` : '位置は非公開'}</div></div>${host && m.id !== me ? `<button class="btn small danger" data-kick="${m.id}">追放</button>` : ''}</div>`).join('')}</div>
    <div class="stack" style="margin-top:14px">
      <button class="btn" id="sc-chat">💬 チャット${unread ? `（${unread}）` : ''}</button>
      <button class="btn secondary" id="sc-map">${I.map}みんなの居場所を地図で見る</button>
    </div>
    <div class="section-title">共有する</div>
    <div class="list">
      <div class="row"><div class="grow">自分の居場所を共有<div class="sub">アプリを開いている間、メンバーに見えます</div></div>${switchHTML('', s.share, 'id="sc-loc"')}</div>
      <div class="row"><div class="grow">共有する旅程<div class="sub">${linked ? `「${esc(linked.name)}」をみんなで編集中` : grp.trip ? 'グループの旅程があります' : 'まだ共有していません'}</div></div>
        <select id="sc-trip" style="max-width:150px"><option value="">選ぶ…</option>${store.data.trips.map((t) => `<option value="${t.id}" ${linked?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    </div>
    <div class="section-foot">共有した旅程は、誰かが変更するとみんなの端末に反映されます（スクショの画像は各端末にだけ残ります）。</div>
    <div class="stack" style="margin-top:20px">
      <button class="btn danger" id="sc-leave">グループから抜ける</button>
      ${host ? `<button class="btn danger" id="sc-disband">グループを解散する</button>` : ''}
    </div>`;
  $('#sc-rec', body)?.addEventListener('change', async (e) => { try { await setRecruit(e.target.checked); haptic(); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; } });
  $('#sc-copy', body)?.addEventListener('click', () => copyText(grp.code));
  $('#sc-sharecode', body)?.addEventListener('click', async () => { const t = `旅ナビの「${grp.name}」に参加してね！\n共有コード：${grp.code}\n${location.href.split('#')[0]}`; if (navigator.share) { try { await navigator.share({ text: t }); } catch {} } else copyText(t); });
  $$('[data-kick]', body).forEach((b) => b.onclick = async () => { const m = social.members.find((x) => x.id === b.dataset.kick); if (await confirmBox(`${m.name}さんを追放しますか？`, '追放した人は同じグループに再参加できません', '追放', { destructive: true })) kick(m.id); });
  $('#sc-chat', body).onclick = openChat;
  $('#sc-map', body).onclick = openFriendsMap;
  $('#sc-loc', body).onchange = (e) => setShare(e.target.checked);
  $('#sc-trip', body).onchange = (e) => { const t = store.data.trips.find((x) => x.id === e.target.value); if (t) { store.data.trips.forEach((x) => { if (x.groupId === grp.id && x !== t) delete x.groupId; }); linkTrip(t); toast('旅程を共有しました'); render(body); } };
  $('#sc-leave', body).onclick = async () => { if (await confirmBox('グループから抜けますか？', host ? 'ホストは次に参加した人に引き継がれます' : '', '抜ける', { destructive: true })) leaveGroup(); };
  $('#sc-disband', body)?.addEventListener('click', async () => { if (await confirmBox('グループを解散しますか？', '全員の共有が終わります', '解散', { destructive: true })) disband(); });
}

function openChat() {
  let off;
  page({
    title: social.group?.name || 'チャット',
    build(body) {
      body.style.paddingBottom = '0';
      body.innerHTML = `<div id="chat-list" style="padding-bottom:90px"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;padding:8px 10px calc(max(var(--sab), 14px) + 8px);background:var(--bar);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-top:.5px solid var(--sep);display:flex;gap:8px;align-items:center">
          <button class="icon-btn" id="ch-loc" title="いまの場所を送る">${I.locate}</button>
          <button class="icon-btn" id="ch-next" title="次の予定を送る">${I.clock}</button>
          <input type="text" id="ch-in" placeholder="メッセージ" enterkeyhint="send" style="flex:1;height:38px;border-radius:19px;border:.5px solid var(--sep);background:var(--bg2);padding:0 14px;font-size:16px">
          <button class="icon-btn" id="ch-send" style="background:var(--blue);color:#fff">↑</button></div>`;
      const list = $('#chat-list', body);
      const draw = () => {
        list.innerHTML = social.messages.map((m) => {
          const t = m.at?.toDate ? hm(m.at.toDate()) : '';
          if (m.kind === 'system') return `<div style="text-align:center;font-size:12px;color:var(--label2);margin:10px 0">${esc(m.text)}</div>`;
          const mine = m.uid === me;
          const col = social.members.find((x) => x.id === m.uid)?.color || 'var(--gray)';
          const bodyHtml = m.kind === 'loc' ? `📍 いまここ<br><a href="https://maps.apple.com/?q=${m.lat},${m.lon}" target="_blank" style="color:inherit;text-decoration:underline">地図で見る</a>` : esc(m.text).replace(/\n/g, '<br>');
          return `<div style="display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};margin:6px 0">${mine ? '' : `<div style="font-size:11.5px;color:${col};margin:0 10px 2px;font-weight:600">${esc(m.name)}</div>`}
            <div style="display:flex;align-items:flex-end;gap:4px;${mine ? 'flex-direction:row-reverse' : ''}"><div style="max-width:75vw;padding:8px 13px;border-radius:18px;background:${mine ? 'var(--blue)' : 'var(--bg2)'};color:${mine ? '#fff' : 'var(--label)'};box-shadow:var(--shadow);-webkit-user-select:text;user-select:text">${bodyHtml}</div><span style="font-size:10.5px;color:var(--label3)">${t}</span></div></div>`;
        }).join('') || '<div class="empty">最初のメッセージを送りましょう</div>';
        body.scrollTop = body.scrollHeight;
      };
      off = draw; social.listeners.add(draw); draw();
      const inp = $('#ch-in', body);
      const go = () => { const v = inp.value.trim(); if (!v) return; inp.value = ''; send(v).catch(() => toast('送れませんでした')); haptic(); };
      $('#ch-send', body).onclick = go;
      inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
      $('#ch-loc', body).onclick = () => navigator.geolocation.getCurrentPosition((p) => send('', { kind: 'loc', lat: p.coords.latitude, lon: p.coords.longitude }), () => toast('現在地を取得できませんでした'));
      $('#ch-next', body).onclick = async () => {
        const { nextEvent } = await import('./trip.js');
        const n = nextEvent();
        if (!n?.nx) { toast('次の予定がありません'); return; }
        const it = n.nx.it;
        send(`🗓 次の予定 ${hm(n.nx.at)}「${it.title || ''}」${it.from ? ` ${it.from}→${it.to || ''}` : ''}${it.platform ? ` ${it.platform}` : ''}`);
      };
    },
    onClose: () => social.listeners.delete(off),
  });
}

function openFriendsMap() {
  let off, map, layer;
  page({
    title: 'みんなの居場所',
    build(body) {
      body.innerHTML = `<div id="fmap" style="height:60vh;border-radius:16px;overflow:hidden;box-shadow:var(--shadow)"></div><div id="flist" style="margin-top:12px"></div>`;
      const draw = () => {
        if (!window.L) return;
        if (!map) {
          map = L.map($('#fmap', body), { zoomControl: false }).setView([35.68, 139.76], 12);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
          layer = L.layerGroup().addTo(map);
        }
        layer.clearLayers();
        const pts = [];
        const shown = social.members.filter((m) => m.sharing && m.loc);
        for (const m of shown) {
          const icon = L.divIcon({ className: '', html: `<div style="background:${m.color};color:#fff;font-weight:700;font-size:13px;padding:4px 8px;border-radius:12px;border:2px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.3);white-space:nowrap">${esc(m.name)}</div>`, iconSize: null });
          L.marker([m.loc.lat, m.loc.lon], { icon }).addTo(layer);
          pts.push([m.loc.lat, m.loc.lon]);
        }
        if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 }); else if (pts.length) map.setView(pts[0], 15);
        $('#flist', body).innerHTML = `<div class="list">${social.members.map((m) => `<div class="row"><span style="width:12px;height:12px;border-radius:6px;background:${m.color}"></span><div class="grow">${esc(m.name)}<div class="sub">${m.sharing && m.loc ? `${ago(m.loc.at)}・誤差 約${m.loc.acc}m` : '位置は非公開'}</div></div>${m.sharing && m.loc ? `<a class="btn small secondary" href="https://maps.apple.com/?daddr=${m.loc.lat},${m.loc.lon}" target="_blank">経路</a>` : ''}</div>`).join('')}</div>`;
      };
      off = draw; social.listeners.add(draw);
      setTimeout(draw, 450);
    },
    onClose: () => social.listeners.delete(off),
  });
}
