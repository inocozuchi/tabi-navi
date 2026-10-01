// ホーム：時刻と天気（いちばん上に常に表示）・旅の進捗・次の予定・次のアラーム・道具
import { $, $$, esc, store, toast, I, TYPES, TRANSPORT, pad, hm, mdw, WD, dur, countdown, sheet } from './util.js';
import { getWeather, wmo, searchCity, clearWeatherCache } from './weather.js';
import { nextEvent, currentTrip, events, nextText } from './trip.js';
import { nextAny } from './alarm.js';
import { openSleep } from './alarm-ui.js';
import { openImport } from './ai.js';
import { openMemos, openWishlist, openBudget, openPacking, openCurrency, tripCosts } from './tools.js';
import { openShiori } from './shiori.js';
import { openSocial, social, startLocation } from './social.js';
import { geocode, roughMove, distText, tripDelays } from './transit.js';

const el = () => $('#view-home');
let wx = null, pos = null;
window.addEventListener('tabi-pos', (e) => { pos = e.detail; });

export function renderHome() {
  const now = new Date();
  const d = store.data;
  const nx = nextAny();
  const t = currentTrip();
  const evs = t ? events(t).filter((e) => e.at) : [];
  const before = evs[0] && evs[0].at > now ? evs[0].at : null;
  const done = evs.filter((e) => (e.end || e.at) < now).length;
  const pinned = d.memos.filter((m) => m.pinned).slice(0, 3);
  const tiles = [
    ['import', '取り込み', I.sparkles, 'var(--indigo)'],
    ['wish', '行きたい', I.star, 'var(--pink)'],
    ['shiori', 'しおり', I.note, 'var(--teal)'],
    ['memo', 'メモ', I.edit, 'var(--orange)'],
    ['budget', '旅費', I.wallet, 'var(--green)'],
    ['pack', '持ち物', I.bag, 'var(--brown)'],
    ['fx', '通貨換算', I.yen, 'var(--cyan)'],
    ['social', '旅仲間', '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M15 14.5c3 0 6 1.8 6 5.5"/></svg>', 'var(--purple)'],
    ['route', '乗換案内', I.route, 'var(--blue)'],
    ['map', 'マップ', I.map, 'var(--mint)'],
    ['info', '運行情報', I.train, 'var(--red)'],
    ['sleep', 'おやすみ', I.moon, '#3b2a8f'],
  ];
  el().innerHTML = `
    <div class="hero" id="hero"><div class="glow"></div>
      <div class="date" id="h-date"></div>
      <div class="clock" id="h-clock"></div>
      <div class="wx" id="h-wx"><span class="spinner" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></span><span class="meta">天気を取得中…</span></div>
      <div class="hourly" id="h-hourly"></div>
    </div>
    ${t ? `<div class="card" id="h-trip" style="cursor:pointer"><h3>${I.route} ${esc(t.name)}</h3>
      ${before ? `<div class="countdown">出発まで ${dur(before - now)}</div><div class="small muted">${mdw(before)} ${hm(before)} から</div>` : `<div id="h-next">${nextText(nextEvent(now), now) || '<span class="muted">予定はありません</span>'}</div>`}
      ${evs.length ? `<div class="progress" style="margin-top:10px"><i style="width:${(done / evs.length) * 100}%;background:var(--green)"></i></div><div class="small muted" style="margin-top:4px">旅の進み具合 ${done}/${evs.length}</div>` : ''}
      <div id="h-prog"></div><div id="h-delay"></div>
    </div>` : `<div class="card" style="cursor:pointer" data-t="import"><h3>${I.route} 旅程</h3><b>スクショから旅程をつくる</b><div class="small muted">乗換案内・ホテル・飛行機の予約画面を貼るだけで、時系列に整理します</div></div>`}
    <div class="card" data-t="alarm" style="cursor:pointer"><h3>${I.alarm} アラーム</h3>
      ${nx ? `<div class="hstack"><div class="countdown">${hm(new Date(nx.at))}</div><div class="small muted" style="flex:1">${esc(nx.alarm?.label || '')}　あと${dur(nx.at - now)}</div></div>` : '<div class="muted small">オンのアラームはありません</div>'}
      <div class="small" style="margin-top:4px;color:${nx ? 'var(--blue)' : 'var(--label2)'}">${nx ? '寝る前に「おやすみ」を押して待機を始めてください' : ''}</div></div>
    ${pinned.length ? `<div class="card" data-t="memo" style="cursor:pointer"><h3>📌 メモ</h3>${pinned.map((m) => `<div style="margin-bottom:6px"><b>${esc(m.title)}</b><div class="small muted" style="white-space:pre-wrap;max-height:3em;overflow:hidden">${esc(m.text)}</div></div>`).join('')}</div>` : ''}
    <div class="grid">${tiles.map(([k, n, ic, c], i) => `<button class="tile" data-t="${k}" style="animation-delay:${i * 25}ms"><span class="ico" style="background:${c}">${ic}</span>${n}</button>`).join('')}</div>
    ${social.group ? `<div class="card" data-t="social" style="cursor:pointer"><h3>👫 ${esc(social.group.name)}</h3><div class="small">${social.members.map((m) => `<span style="color:${m.color}">●</span> ${esc(m.name)}`).join('　')}</div>${social.messages.length ? `<div class="small muted" style="margin-top:6px">💬 ${esc(social.messages[social.messages.length - 1].name)}：${esc((social.messages[social.messages.length - 1].text || '📍').slice(0, 40))}</div>` : ''}</div>` : ''}
  `;
  tickHome();
  drawWeather();
  if (t && !before) progress();
  if (t) tripDelays().then((l) => { const b = $('#h-delay'); if (b && l.length) b.innerHTML = `<div class="small" style="color:var(--orange);margin-top:8px">${I.warn} 遅延の発表：${l.map((x) => esc(x.name)).join('、')}</div>`; });
}

export function tickHome() {
  const c = $('#h-clock');
  if (!c) return;
  const n = new Date();
  c.innerHTML = `${n.getHours()}:${pad(n.getMinutes())}${store.data.settings.showSeconds ? `<span class="sec">${pad(n.getSeconds())}</span>` : ''}`;
  $('#h-date').textContent = `${n.getMonth() + 1}月${n.getDate()}日 ${WD[n.getDay()]}曜日`;
  if (n.getSeconds() === 0) { const nx = $('#h-next'); if (nx) nx.innerHTML = nextText(nextEvent(n), n); }
}

async function drawWeather(force) {
  try {
    wx = await getWeather(force);
    const c = wx.current;
    const night = !c.is_day;
    const [ic, label] = wmo(c.weather_code, night);
    const dd = wx.daily;
    const h = $('#hero');
    if (!h) return;
    h.className = 'hero ' + (night ? 'night' : [61, 63, 65, 80, 81, 82, 95, 96, 99, 51, 53, 55].includes(c.weather_code) ? 'rain' : c.weather_code >= 3 ? 'cloud' : '');
    $('#h-wx').innerHTML = `<div class="wicon">${ic}</div><div class="temp">${Math.round(c.temperature_2m)}°</div>
      <div class="meta">${label}　最高 ${Math.round(dd.temperature_2m_max[0])}° / 最低 ${Math.round(dd.temperature_2m_min[0])}°<br>体感 ${Math.round(c.apparent_temperature)}°・降水 ${dd.precipitation_probability_max[0] ?? '-'}%・湿度 ${c.relative_humidity_2m}%
      <div class="place">${I.pin} ${esc(wx.where.name)}</div></div>`;
    const nowH = new Date().getHours();
    const idx = wx.hourly.time.findIndex((t) => new Date(t) >= new Date(Date.now() - 3600e3));
    $('#h-hourly').innerHTML = wx.hourly.time.slice(idx, idx + 24).map((t, i) => {
      const k = idx + i, hh = new Date(t).getHours();
      return `<div>${i === 0 ? '今' : hh + '時'}<b>${wmo(wx.hourly.weather_code[k], !wx.hourly.is_day[k])[0]}</b>${Math.round(wx.hourly.temperature_2m[k])}°${wx.hourly.precipitation_probability[k] >= 30 ? `<br><span style="font-size:11px">☔${wx.hourly.precipitation_probability[k]}%</span>` : ''}</div>`;
    }).join('');
    void nowH;
  } catch {
    const w = $('#h-wx'); if (w) w.innerHTML = '<span class="meta">天気を取得できませんでした（タップで再読み込み）</span>';
  }
}

// 位置情報と旅程を比べて、次の予定に間に合いそうかを出す
async function progress() {
  const box = $('#h-prog');
  if (!box) return;
  const n = nextEvent();
  const target = n?.nx;
  if (!target) return;
  const it = target.it;
  const place = TRANSPORT.has(it.type) ? it.from : (it.address || it.title);
  if (!place) return;
  if (!pos) {
    box.innerHTML = `<button class="link-btn small" id="h-loc">${I.locate} 現在地と比べて間に合うか確かめる</button>`;
    $('#h-loc').onclick = (e) => { e.stopPropagation(); startLocation(); toast('現在地を調べています…'); const f = () => { window.removeEventListener('tabi-pos', f); progress(); }; window.addEventListener('tabi-pos', f); };
    return;
  }
  const dest = (it.lat && { lat: it.lat, lon: it.lon }) || (await geocode(place));
  if (!dest || !$('#h-prog')) return;
  const mv = roughMove(pos, dest);
  const left = (target.at - Date.now()) / 60000;
  const need = mv.m < 1500 ? mv.walkMin : mv.rideMin;
  const near = mv.m < 250;
  const st = near ? ['var(--green)', '到着しています 👍'] : left - need > 20 ? ['var(--green)', '余裕あり'] : left - need > 0 ? ['var(--orange)', 'そろそろ出発'] : ['var(--red)', '急いで！間に合わないかも'];
  box.innerHTML = `<div class="hstack" style="margin-top:10px;padding:10px;border-radius:12px;background:var(--fill)">
    <span style="width:10px;height:10px;border-radius:5px;background:${st[0]};flex:none"></span>
    <div class="small" style="flex:1"><b style="color:${st[0]}">${st[1]}</b><br>${esc(place)}まで ${distText(mv.m)}・${mv.best}（目安）</div>
    <a class="btn small secondary" href="https://maps.apple.com/?daddr=${dest.lat},${dest.lon}&dirflg=${mv.m < 1500 ? 'w' : 'r'}" target="_blank" onclick="event.stopPropagation()">経路</a></div>`;
}

export function bindHome(go) {
  el().addEventListener('click', (e) => {
    if (e.target.closest('#h-wx')) { pickPlace(); return; }
    const t = e.target.closest('[data-t]')?.dataset.t || (e.target.closest('#h-trip') && !e.target.closest('a,button') ? 'trip' : null);
    if (!t) return;
    const map = {
      import: () => openImport({}), wish: openWishlist, shiori: openShiori, memo: openMemos, budget: openBudget, pack: openPacking, fx: openCurrency, social: openSocial,
      route: () => go('transit', 'route'), map: () => go('transit', 'map'), info: () => go('transit', 'info'), sleep: openSleep, alarm: () => go('alarm'), trip: () => go('trip'),
    };
    map[t]?.();
  });
}

// 天気の場所を選ぶ
export function pickPlace(done) {
  sheet({
    title: '天気の場所', left: '閉じる',
    build(body, close) {
      body.innerHTML = `<div class="list"><button class="row" id="pp-gps">${I.locate}<div class="grow">現在地</div>${!store.data.settings.place ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button></div>
        <div class="list" style="margin-top:12px"><div class="row">${I.search}<input type="text" id="pp-q" class="left" placeholder="都市を検索（例：札幌、Seoul）" enterkeyhint="search"></div></div><div id="pp-r" style="margin-top:12px"></div>`;
      const set = (p) => { store.data.settings.place = p; store.save(); clearWeatherCache(); close(); renderHome(); done?.(); };
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
export const refreshWeather = () => drawWeather(true);
