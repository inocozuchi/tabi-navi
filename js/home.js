// 旅程画面の上の部分（時刻・天気・いまの状況）と、「道具」タブ
import { $, $$, esc, store, toast, I, TYPES, TRANSPORT, pad, hm, mdw, WD, dur, countdown, sheet, dayKey, parseLocal, toLocalISO } from './util.js';
import { getWeather, wmo, searchCity, clearWeatherCache, dailyFor } from './weather.js';
import { nextEvent, currentTrip, events, renderTrip } from './trip.js';
import { nextAny } from './alarm.js';
import { openSleep, alarmFor } from './alarm-ui.js';
import { openImport, openPaste } from './ai.js';
import { openMemos, openWishlist, openBudget, openPacking, openCurrency } from './tools.js';
import { openShiori } from './shiori.js';
import { openSocial, social, startLocation } from './social.js';
import { geocode, roughMove, distText, tripDelays, transitLinks, mapsSearchUrl } from './transit.js';

let pos = null;
window.addEventListener('tabi-pos', (e) => { pos = e.detail; });

// ===== いちばん上：時刻と天気（常に表示） =====
export function heroHTML() {
  return `<div class="hero" id="hero"><div class="glow"></div>
    <div class="hero-top"><div><div class="date" id="h-date"></div><div class="clock" id="h-clock"></div></div>
      <button class="hero-wx" id="h-wx"><span class="spinner" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></span></button></div>
    <div class="hourly" id="h-hourly"></div>
  </div>`;
}
export function tickHome() {
  const c = $('#h-clock');
  if (!c) return;
  const n = new Date();
  c.innerHTML = `${n.getHours()}:${pad(n.getMinutes())}${store.data.settings.showSeconds ? `<span class="sec">${pad(n.getSeconds())}</span>` : ''}`;
  $('#h-date').textContent = `${n.getMonth() + 1}月${n.getDate()}日 ${WD[n.getDay()]}曜日`;
}
export async function drawWeather(force) {
  tickHome();
  try {
    const wx = await getWeather(force);
    const c = wx.current;
    const night = !c.is_day;
    const [ic, label] = wmo(c.weather_code, night);
    const dd = wx.daily;
    const h = $('#hero');
    if (!h) return;
    h.className = 'hero ' + (night ? 'night' : [61, 63, 65, 80, 81, 82, 95, 96, 99, 51, 53, 55].includes(c.weather_code) ? 'rain' : c.weather_code >= 3 ? 'cloud' : '');
    $('#h-wx').innerHTML = `<div class="hstack" style="justify-content:flex-end;gap:6px"><span class="wicon">${ic}</span><span class="temp">${Math.round(c.temperature_2m)}°</span></div>
      <div class="wx-meta">${label}　${Math.round(dd.temperature_2m_max[0])}° / ${Math.round(dd.temperature_2m_min[0])}°<br>☔ ${dd.precipitation_probability_max[0] ?? '-'}%　${I.pin}${esc(wx.where.name)}</div>`;
    const idx = Math.max(0, wx.hourly.time.findIndex((t) => new Date(t) >= new Date(Date.now() - 3600e3)));
    $('#h-hourly').innerHTML = wx.hourly.time.slice(idx, idx + 24).map((t, i) => {
      const k = idx + i, hh = new Date(t).getHours();
      return `<div>${i === 0 ? '今' : hh + '時'}<b>${wmo(wx.hourly.weather_code[k], !wx.hourly.is_day[k])[0]}</b>${Math.round(wx.hourly.temperature_2m[k])}°${wx.hourly.precipitation_probability[k] >= 30 ? `<i>☔${wx.hourly.precipitation_probability[k]}%</i>` : ''}</div>`;
    }).join('');
  } catch {
    const w = $('#h-wx'); if (w) w.innerHTML = '<span class="wx-meta">天気：場所を選ぶ ›</span>';
  }
}

// ===== いまの状況（次の予定・カウントダウン・間に合うか・次のアラーム） =====
export function statusHTML() {
  const t = currentTrip();
  const now = new Date();
  const nx = nextAny();
  const alarmLine = nx
    ? `<button class="status-alarm" data-act="goalarm">${I.alarm}<span>${new Date(nx.at).getDate() !== now.getDate() ? '明日 ' : ''}${hm(new Date(nx.at))} ${esc(nx.alarm?.label || 'アラーム')}</span><span class="muted">あと${dur(nx.at - now)}</span><span class="chev">${I.chev}</span></button>`
    : `<button class="status-alarm" data-act="alarmfor">${I.alarm}<span>アラームなし</span><span class="link">自動で設定</span><span class="chev">${I.chev}</span></button>`;
  if (!t) return '';
  const evs = events(t).filter((e) => e.at);
  if (!evs.length) return `<div class="card status">${alarmLine}</div>`;
  const first = evs[0].at;
  const n = nextEvent(now);
  const done = evs.filter((e) => (e.end || e.at) < now).length;
  let main = '';
  if (first > now) {
    main = `<div class="status-label">出発まで</div><div class="status-big">${dur(first - now)}</div><div class="status-sub">${mdw(first)} ${hm(first)}　${esc(titleOf(evs[0]))}</div>`;
  } else if (n?.cur) {
    const it = n.cur.it;
    main = `<div class="status-label">移動中 ・ 到着まで</div><div class="status-big mono" id="st-count" data-to="${n.cur.end.getTime()}">${countdown(n.cur.end - now)}</div><div class="status-sub">${esc(titleOf(n.cur))}　${esc(it.from || '')} → ${esc(it.to || '')}（${hm(n.cur.end)} 着）</div>`;
  } else if (n?.nx) {
    const it = n.nx.it;
    main = `<div class="status-label">次の予定まで</div><div class="status-big mono" id="st-count" data-to="${n.nx.at.getTime()}">${countdown(n.nx.at - now)}</div>
      <div class="status-sub"><b>${hm(n.nx.at)}</b> ${esc(titleOf(n.nx))}${TRANSPORT.has(it.type) && it.from ? `　${esc(it.from)} → ${esc(it.to || '')}` : ''}${it.platform ? `　${esc(it.platform)}` : ''}</div>
      <div class="hstack" style="margin-top:10px;flex-wrap:wrap">
        ${TRANSPORT.has(it.type) && it.from && it.to ? `<button class="btn small secondary" data-act="st-route" data-id="${it.id}">${I.route}乗換案内</button>` : ''}
        <a class="btn small secondary" href="${mapsSearchUrl(TRANSPORT.has(it.type) ? it.from : it.address || it.title)}" target="_blank">${I.pin}地図</a>
        <button class="btn small secondary" data-act="shift">${I.clock}遅れた…</button>
      </div>`;
  } else main = `<div class="status-label">旅の予定はすべて終わりました</div><div class="status-big">おつかれさま！</div>`;
  return `<div class="card status">
    ${main}
    <div class="progress" style="margin-top:12px"><i style="width:${(done / evs.length) * 100}%;background:var(--green)"></i></div>
    <div class="small muted" style="margin-top:4px">進み具合 ${done}/${evs.length}</div>
    <div id="h-prog"></div><div id="h-delay"></div>
    ${alarmLine}
  </div>`;
}
const titleOf = (e) => (e.it.type === 'hotel' ? `${e.kind === 'out' ? 'チェックアウト' : 'チェックイン'} ${e.it.title || ''}` : e.it.title || TYPES[e.it.type]?.name || '予定');

export function tickStatus() {
  const c = $('#st-count');
  if (!c) return;
  const ms = +c.dataset.to - Date.now();
  if (ms <= 0) { renderTrip(); return; }
  c.textContent = countdown(ms);
}
export function afterStatus() {
  progress();
  tripDelays().then((l) => { const b = $('#h-delay'); if (b && l.length) b.innerHTML = `<div class="small" style="color:var(--orange);margin-top:8px">${I.warn} 遅延の発表：${l.map((x) => esc(x.name)).join('、')}</div>`; });
}

// 位置情報と旅程を比べて、次の予定に間に合いそうかを出す
async function progress() {
  const box = $('#h-prog');
  if (!box) return;
  const n = nextEvent();
  const target = n?.nx;
  if (!target || target.at - Date.now() > 12 * 3600e3) return;
  const it = target.it;
  const place = TRANSPORT.has(it.type) ? it.from : (it.address || it.title);
  if (!place) return;
  if (!pos) {
    box.innerHTML = `<button class="link-btn small" id="h-loc">${I.locate} 現在地から間に合うか確かめる</button>`;
    $('#h-loc').onclick = () => { startLocation(); toast('現在地を調べています…'); const f = () => { window.removeEventListener('tabi-pos', f); progress(); }; window.addEventListener('tabi-pos', f); };
    return;
  }
  const dest = (it.lat && { lat: it.lat, lon: it.lon }) || (await geocode(place));
  if (!dest || !$('#h-prog')) return;
  const mv = roughMove(pos, dest);
  const left = (target.at - Date.now()) / 60000;
  const need = mv.m < 1500 ? mv.walkMin : mv.rideMin;
  const st = mv.m < 250 ? ['var(--green)', '着いています 👍'] : left - need > 20 ? ['var(--green)', '余裕あり'] : left - need > 0 ? ['var(--orange)', 'そろそろ出発'] : ['var(--red)', '急いで！間に合わないかも'];
  box.innerHTML = `<div class="hstack" style="margin-top:10px;padding:10px;border-radius:12px;background:var(--fill)">
    <span style="width:10px;height:10px;border-radius:5px;background:${st[0]};flex:none"></span>
    <div class="small" style="flex:1"><b style="color:${st[0]}">${st[1]}</b><br>${esc(place)}まで ${distText(mv.m)}・${mv.best}（目安）</div>
    <a class="btn small secondary" href="https://maps.apple.com/?daddr=${dest.lat},${dest.lon}&dirflg=${mv.m < 1500 ? 'w' : 'r'}" target="_blank">経路</a></div>`;
}

export function bindStatus(go) {
  $('#view-trip').addEventListener('click', (e) => {
    if (e.target.closest('#h-wx')) { pickPlace(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'goalarm') go('alarm');
    if (a === 'alarmfor') alarmFromTrip();
    if (a === 'shift') shiftLater();
    if (a === 'st-route') { const it = currentTrip()?.items.find((x) => x.id === e.target.closest('[data-id]').dataset.id); if (it) transitLinks({ from: it.from, to: it.to, when: parseLocal(it.start) }); }
  });
}

// 次の出発に合わせたアラーム（出発の90分前を提案）
export function alarmFromTrip() {
  const t = currentTrip();
  const now = new Date();
  const nx = t && events(t).find((e) => e.at && e.at > new Date(now.getTime() + 60 * 60000) && e.kind !== 'out');
  if (!nx) { alarmFor(null); return; }
  const at = new Date(nx.at.getTime() - 90 * 60000);
  alarmFor({ time: `${pad(at.getHours())}:${pad(Math.floor(at.getMinutes() / 5) * 5)}`, label: `${hm(nx.at)} ${titleOf(nx)}`.slice(0, 24) });
}

// 遅れた時：これからの予定をまとめて後ろへずらす
function shiftLater() {
  sheet({
    title: '予定をずらす', left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="section-foot" style="margin:0 4px 10px">これからの予定を、まとめて後ろにずらします。乗り遅れた時などに。</div>
        <div class="grid" style="grid-template-columns:repeat(3,1fr)">${[5, 10, 15, 20, 30, 60].map((m) => `<button class="tile" data-m="${m}" style="font-size:16px;font-weight:600">+${m}分</button>`).join('')}</div>
        <div class="list"><div class="row"><div class="grow">今日の分だけ</div><label class="switch"><input type="checkbox" id="sh-today" checked><span></span></label></div></div>`;
      $$('[data-m]', body).forEach((b) => b.onclick = () => {
        const m = +b.dataset.m, now = new Date(), today = dayKey(now), onlyToday = $('#sh-today', body).checked;
        let n = 0;
        for (const it of currentTrip()?.items || []) {
          const s = parseLocal(it.start);
          if (!s || s < now || (onlyToday && dayKey(s) !== today) || it.type === 'hotel') continue;
          it.start = toLocalISO(new Date(s.getTime() + m * 60000));
          const e = parseLocal(it.end); if (e) it.end = toLocalISO(new Date(e.getTime() + m * 60000));
          n++;
        }
        store.save(); renderTrip(); close(); toast(`${n}件を${m}分後ろにずらしました`);
      });
    },
  });
}

// ===== 旅程の日ごとの天気（行き先の予報） =====
const wxCache = new Map();
export async function dayWeather(trip) {
  const now = new Date();
  const byDay = {};
  for (const e of events(trip)) {
    if (!e.at || e.at < new Date(now.getTime() - 864e5) || e.at > new Date(now.getTime() + 13 * 864e5)) continue;
    const it = e.it;
    const place = it.type === 'hotel' ? it.address || it.title : TRANSPORT.has(it.type) ? it.to : it.address || it.title;
    const k = dayKey(e.at);
    if (place && !byDay[k]) byDay[k] = { place, lat: it.lat, lon: it.lon };
  }
  for (const [k, p] of Object.entries(byDay)) {
    if (!document.querySelector(`.day-wx[data-day="${k}"]`)) continue;
    try {
      const g = p.lat ? { lat: p.lat, lon: p.lon } : await geocode(p.place);
      if (!g) continue;
      const ck = `${g.lat.toFixed(2)},${g.lon.toFixed(2)}`;
      if (!wxCache.has(ck)) wxCache.set(ck, dailyFor(g.lat, g.lon));
      const w = await wxCache.get(ck);
      const i = w.daily.time.indexOf(k);
      if (i < 0) continue;
      const b = document.querySelector(`.day-wx[data-day="${k}"]`);
      if (b) b.innerHTML = `${wmo(w.daily.weather_code[i])[0]} ${Math.round(w.daily.temperature_2m_max[i])}°/${Math.round(w.daily.temperature_2m_min[i])}°${w.daily.precipitation_probability_max[i] >= 30 ? ` ☔${w.daily.precipitation_probability_max[i]}%` : ''}`;
    } catch {}
  }
}

// ===== 道具タブ =====
const TILES = [
  ['paste', '文字から取り込む', I.copy, 'var(--blue)', '予約メール・乗換結果・メモ'],
  ['import', 'スクショから取り込む', I.photo, 'var(--indigo)', '予約画面・乗換案内'],
  ['wish', '行きたいリスト', I.star, 'var(--pink)', 'スポットをためて旅程に'],
  ['shiori', '旅のしおり', I.note, 'var(--teal)', '印刷・PDFで保存'],
  ['memo', 'メモ', I.edit, 'var(--orange)', '部屋番号・集合時間など'],
  ['budget', '旅費', I.wallet, 'var(--green)', '自動で合計・割り勘'],
  ['pack', '持ち物', I.bag, 'var(--brown)', 'チェックリスト'],
  ['fx', '通貨換算', I.yen, 'var(--cyan)', '外貨 ⇄ 円'],
  ['social', '旅仲間', '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M15 14.5c3 0 6 1.8 6 5.5"/></svg>', 'var(--purple)', '共有コードで同期・チャット'],
  ['sleep', 'おやすみモード', I.moon, '#3b2a8f', 'アラームの待機を始める'],
];
export function renderTools() {
  const d = store.data;
  const pinned = d.memos.filter((m) => m.pinned).slice(0, 3);
  $('#view-tools').innerHTML = `
    <div class="large-title"><h1>道具</h1></div>
    ${pinned.length ? `<div class="section-title">📌 ピン留めのメモ</div><div class="list">${pinned.map((m) => `<button class="row" data-t="memo"><div class="grow"><b>${esc(m.title)}</b><div class="sub" style="white-space:pre-wrap;max-height:2.8em;overflow:hidden">${esc(m.text)}</div></div><span class="chev">${I.chev}</span></button>`).join('')}</div>` : ''}
    ${social.group ? `<div class="section-title">👫 ${esc(social.group.name)}</div><div class="list"><button class="row" data-t="social"><div class="grow">${social.members.map((m) => `<span style="color:${m.color}">●</span> ${esc(m.name)}`).join('　')}${social.messages.length ? `<div class="sub">💬 ${esc(social.messages[social.messages.length - 1].name)}：${esc((social.messages[social.messages.length - 1].text || '📍').slice(0, 40))}</div>` : ''}</div><span class="chev">${I.chev}</span></button></div>` : ''}
    <div class="section-title">旅程づくり</div>
    <div class="list">${TILES.slice(0, 4).map(rowTile).join('')}</div>
    <div class="section-title">旅の途中で</div>
    <div class="list">${TILES.slice(4).map(rowTile).join('')}</div>`;
}
const rowTile = ([k, n, ic, c, sub]) => `<button class="row icon-row" data-t="${k}"><span class="ico" style="background:${c}">${ic}</span><div class="grow">${n}<div class="sub">${sub}</div></div><span class="chev">${I.chev}</span></button>`;
export function bindTools() {
  $('#view-tools').addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]')?.dataset.t;
    const map = { paste: () => openPaste({}), import: () => openImport({}), wish: openWishlist, shiori: openShiori, memo: openMemos, budget: openBudget, pack: openPacking, fx: openCurrency, social: openSocial, sleep: openSleep };
    map[t]?.();
  });
}

// 天気の場所を選ぶ
export function pickPlace(done) {
  sheet({
    title: '天気の場所', left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="list"><button class="row" id="pp-gps">${I.locate}<div class="grow">現在地</div>${!store.data.settings.place ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button></div>
        <div class="field-label">都市を検索</div><input type="text" id="pp-q" class="field" placeholder="例：札幌、Seoul" enterkeyhint="search"><div id="pp-r" style="margin-top:12px"></div>`;
      const set = (p) => { store.data.settings.place = p; store.save(); clearWeatherCache(); close(); drawWeather(true); done?.(); };
      $('#pp-gps', body).onclick = () => set(null);
      $('#pp-q', body).onkeydown = async (e) => {
        if (e.key !== 'Enter') return;
        e.target.blur();
        const r = await searchCity(e.target.value).catch(() => []);
        $('#pp-r', body).innerHTML = r.length ? `<div class="list">${r.map((x, i) => `<button class="row" data-i="${i}">${I.pin}<div class="grow">${esc(x.name)}<div class="sub">${esc(x.sub)}</div></div></button>`).join('')}</div>` : '<div class="empty">見つかりませんでした</div>';
        $$('[data-i]', body).forEach((b) => b.onclick = () => { const x = r[+b.dataset.i]; set({ name: x.name, lat: x.lat, lon: x.lon }); });
      };
    },
  });
}
