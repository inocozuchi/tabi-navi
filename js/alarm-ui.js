// アラームの画面：一覧・編集・おやすみ画面・鳴動画面
import { $, $$, esc, pad, store, sheet, toast, confirmBox, switchHTML, haptic, I, segment } from './util.js';
import { engine, newAlarm, burstOffsets, nextOccurrence, nextAny, repeatText, fixOnce, REPEAT_PRESETS } from './alarm.js';
import { BUILTIN, addFile, listFiles, removeFile, soundName } from './sounds.js';

const el = () => $('#view-alarm');

function untilText(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}時間${m % 60}分後` : `${m}分後`;
}

export function renderAlarm() {
  const s = store.data.settings;
  const alarms = [...store.data.alarms].sort((a, b) => a.time.localeCompare(b.time));
  const nx = nextAny();
  const earTxt = engine.ear === 'lost' ? '⚠︎ イヤホンが外れました' : engine.armed ? '🎧 イヤホンで鳴らします' : '';
  el().innerHTML = `
    <div class="large-title"><h1>アラーム</h1><div class="actions"><button class="icon-btn" data-act="add">${I.plus}</button></div></div>
    <div class="sleep-cta">
      <div class="moon">${engine.armed ? '🌙' : '😴'}</div>
      <div class="grow" style="flex:1">
        <b>${engine.armed ? '待機中' : 'おやすみモード'}</b>
        <div class="small">${nx ? `次: ${nx.alarm ? esc(nx.alarm.label || '') : ''} ${new Date(nx.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}（${untilText(nx.at - Date.now())}）` : 'オンのアラームがありません'}</div>
        ${earTxt ? `<div class="ear-state" style="margin-top:6px">${earTxt}</div>` : `<div class="small" style="margin-top:4px">寝る前にここを押すと、アラームが待機します</div>`}
      </div>
      <button class="btn small" style="background:#fff;color:#2a1f7a" data-act="sleep">${engine.armed ? '開く' : '開始'}</button>
    </div>
    ${alarms.length ? '' : `<div class="empty">${I.alarm}<div>アラームはまだありません</div><div class="small" style="margin-top:6px">右上の ＋ で追加できます</div></div>`}
    <div id="alarm-list">${alarms.map(itemHTML).join('')}</div>
    <div class="section-title">待機のしかた</div>
    <div class="list">
      <button class="row" data-act="mode"><div class="grow">待機モード</div><span class="val">${s.alarmMode === 'saver' ? 'イヤホン節電' : '確実（画面オフ可）'}</span><span class="chev">${I.chev}</span></button>
      <button class="row" data-act="log"><div class="grow">動作の記録</div><span class="chev">${I.chev}</span></button>
    </div>
    <div class="section-foot">音はイヤホンからだけ鳴ります（マナーモードでも鳴ります）。イヤホンが外れていると鳴りません。詳しくは「設定 → アラームのしくみ」をご覧ください。</div>
  `;
}

function itemHTML(a) {
  const offs = burstOffsets(a);
  const [h, m] = a.time.split(':');
  const o = nextOccurrence(a);
  const last = offs[offs.length - 1];
  const endT = (() => { const [hh, mm] = a.time.split(':').map(Number); const t = hh * 60 + mm + last; return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; })();
  return `<div class="alarm-item ${a.enabled ? '' : 'off'}" data-id="${a.id}">
    <div class="grow" data-act="edit" style="flex:1;min-width:0">
      <div class="big">${+h}:${m}${offs.length > 1 ? `<small>〜${endT}</small>` : ''}</div>
      <div class="info">${esc(a.label || 'アラーム')}・${repeatText(a)}${offs.length > 1 ? `・${offs.length}回（${a.burst.interval}分ごと）` : ''}${a.snooze?.enabled ? '・スヌーズ' : ''}${a.mission ? '・計算で停止' : ''}</div>
      ${a.enabled && o ? `<div class="info" style="color:var(--blue)">${untilText(o.at - Date.now())}に鳴ります</div>` : ''}
      ${offs.length > 1 ? `<div class="burst-bar">${offs.slice(0, 60).map(() => '<i></i>').join('')}</div>` : ''}
    </div>
    ${switchHTML('', a.enabled, `data-act="toggle"`)}
  </div>`;
}

export function bindAlarm() {
  el().addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const id = t.closest('[data-id]')?.dataset.id;
    const act = t.dataset.act;
    if (act === 'add') editAlarm(null);
    else if (act === 'edit') editAlarm(store.data.alarms.find((a) => a.id === id));
    else if (act === 'sleep') openSleep();
    else if (act === 'mode') chooseMode();
    else if (act === 'log') showLog();
  });
  el().addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const id = e.target.closest('[data-id]').dataset.id;
    const a = store.data.alarms.find((x) => x.id === id);
    a.enabled = e.target.checked;
    a.skipUntil = 0;
    if (a.enabled) { fixOnce(a); const o = nextOccurrence(a); if (o) toast(`${untilText(o.at - Date.now())}に鳴ります`); }
    haptic();
    store.save();
    renderAlarm();
  });
  engine.on((type) => {
    if (type === 'ring') showRing();
    if (type === 'state') { renderAlarm(); updateSleep(); }
    if (type === 'ringend') { closeRing(); renderAlarm(); }
    if (type === 'tick') updateSleep();
  });
}

// ===== 編集 =====
async function editAlarm(orig) {
  const a = structuredClone(orig || newAlarm());
  const files = await listFiles();
  let soundLabel = await soundName(a.soundId);
  const isNew = !orig;
  sheet({
    title: isNew ? 'アラームを追加' : 'アラームを編集', right: '保存',
    onRight: () => {
      fixOnce(a);
      a.enabled = true; a.skipUntil = 0;
      if (isNew) store.data.alarms.push(a);
      else Object.assign(orig, a);
      store.save(); renderAlarm(); engine.prerender();
      const o = nextOccurrence(a);
      if (o) toast(`${untilText(o.at - Date.now())}に鳴ります${engine.armed ? '' : '（寝る前におやすみモードを開始）'}`, 3000);
    },
    build(body, close) {
      const draw = () => {
        const offs = burstOffsets(a);
        const [hh, mm] = a.time.split(':').map(Number);
        const times = offs.map((o) => { const t = hh * 60 + mm + o; return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`; });
        body.innerHTML = `
          <div style="display:flex;justify-content:center;margin:6px 0 14px"><input type="time" id="al-time" value="${a.time}" style="font-size:52px;font-weight:300;border:0;background:var(--bg2);border-radius:16px;padding:6px 18px;text-align:center;box-shadow:var(--shadow)"></div>
          <div class="list">
            <div class="row"><div>ラベル</div><input type="text" id="al-label" value="${esc(a.label)}" placeholder="アラーム"></div>
            <button class="row" data-x="repeat"><div class="grow">繰り返し</div><span class="val">${repeatText(a)}</span><span class="chev">${I.chev}</span></button>
            <button class="row" data-x="sound"><div class="grow">サウンド</div><span class="val">${esc(soundLabel)}</span><span class="chev">${I.chev}</span></button>
          </div>
          <div class="section-title">連続アラーム（起きられない人向け）</div>
          <div class="list">
            <div class="row"><div class="grow">連続して鳴らす</div>${switchHTML('', a.burst.enabled, 'id="al-burst"')}</div>
            ${a.burst.enabled ? `
            <div class="row"><div class="grow">続ける時間</div><select id="al-bmin">${[3, 5, 10, 15, 20, 30, 45, 60].map((v) => `<option value="${v}" ${+a.burst.minutes === v ? 'selected' : ''}>${v}分間</option>`).join('')}</select></div>
            <div class="row"><div class="grow">間隔</div><select id="al-biv">${[1, 2, 3, 5, 10].map((v) => `<option value="${v}" ${+a.burst.interval === v ? 'selected' : ''}>${v}分ごと</option>`).join('')}</select></div>` : ''}
          </div>
          ${a.burst.enabled ? `<div class="section-foot">${times.length}回鳴ります：${times.join('、')}</div>` : ''}
          <div class="section-title">鳴り方</div>
          <div class="list">
            <div class="row"><div class="grow">1回の鳴る長さ</div><select id="al-ring">${[[15, '15秒'], [30, '30秒'], [40, '40秒'], [50, '50秒'], [60, '1分'], [120, '2分'], [300, '5分']].map(([v, t]) => `<option value="${v}" ${+a.ringSec === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="row"><div class="grow">だんだん大きく</div><select id="al-fade">${[[0, 'なし'], [5, '5秒'], [10, '10秒'], [20, '20秒'], [30, '30秒'], [60, '1分']].map(([v, t]) => `<option value="${v}" ${+a.fade === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
            <div class="row"><div class="grow">音量</div><input type="range" id="al-vol" min="0.1" max="1" step="0.05" value="${a.vol}" style="flex:1.3"></div>
            <div class="row"><div class="grow">試しに鳴らす（イヤホン）</div><button class="btn small secondary" id="al-test">${I.play}再生</button></div>
          </div>
          ${a.burst.enabled && a.ringSec >= a.burst.interval * 60 ? `<div class="section-foot" style="color:var(--orange)">鳴る長さが間隔以上なので、次の回が始まると前の回は切り替わります。</div>` : ''}
          <div class="section-title">止め方</div>
          <div class="list">
            <div class="row"><div class="grow">スヌーズ</div>${switchHTML('', a.snooze.enabled, 'id="al-snz"')}</div>
            ${a.snooze.enabled ? `
            <div class="row"><div class="grow">スヌーズの間隔</div><select id="al-snzm">${[1, 3, 5, 7, 9, 10, 15].map((v) => `<option value="${v}" ${+a.snooze.minutes === v ? 'selected' : ''}>${v}分</option>`).join('')}</select></div>
            <div class="row"><div class="grow">スヌーズの回数</div><select id="al-snzn">${[1, 2, 3, 5, 10].map((v) => `<option value="${v}" ${+a.snooze.max === v ? 'selected' : ''}>${v}回まで</option>`).join('')}</select></div>` : ''}
            <div class="row"><div class="grow">計算問題を解いて止める<div class="sub">「起きた」を押す時に問題が出ます</div></div>${switchHTML('', a.mission, 'id="al-mis"')}</div>
          </div>
          ${isNew ? '' : `<div style="margin-top:24px"><button class="btn danger" id="al-del">アラームを削除</button></div>`}
        `;
        const v = (id) => $('#' + id, body);
        v('al-time').onchange = (e) => { a.time = e.target.value || a.time; draw(); };
        v('al-label').oninput = (e) => { a.label = e.target.value; };
        v('al-burst').onchange = (e) => { a.burst.enabled = e.target.checked; if (a.burst.enabled && a.ringSec > 50) a.ringSec = 40; draw(); };
        v('al-bmin')?.addEventListener('change', (e) => { a.burst.minutes = +e.target.value; draw(); });
        v('al-biv')?.addEventListener('change', (e) => { a.burst.interval = +e.target.value; draw(); });
        v('al-ring').onchange = (e) => { a.ringSec = +e.target.value; draw(); };
        v('al-fade').onchange = (e) => { a.fade = +e.target.value; };
        v('al-vol').oninput = (e) => { a.vol = +e.target.value; };
        v('al-snz').onchange = (e) => { a.snooze.enabled = e.target.checked; draw(); };
        v('al-snzm')?.addEventListener('change', (e) => { a.snooze.minutes = +e.target.value; });
        v('al-snzn')?.addEventListener('change', (e) => { a.snooze.max = +e.target.value; });
        v('al-mis').onchange = (e) => { a.mission = e.target.checked; };
        let playing = false;
        v('al-test').onclick = async (e) => {
          const b = e.currentTarget;
          if (playing) { engine.stopTest(); playing = false; b.innerHTML = `${I.play}再生`; return; }
          try { await engine.test(a); playing = true; b.innerHTML = `${I.stop}停止`; setTimeout(() => { playing = false; b.innerHTML = `${I.play}再生`; }, 8000); }
          catch { toast('再生できませんでした'); }
        };
        v('al-del')?.addEventListener('click', async () => {
          if (!(await confirmBox('アラームを削除しますか？', '', '削除', { destructive: true }))) return;
          store.data.alarms = store.data.alarms.filter((x) => x.id !== a.id);
          store.save(); renderAlarm(); close();
        });
        $$('[data-x]', body).forEach((b) => b.onclick = () => {
          if (b.dataset.x === 'repeat') pickRepeat(a, draw);
          else pickSound(a, files, async () => { soundLabel = await soundName(a.soundId); draw(); });
        });
      };
      draw();
    },
    onClose: () => engine.stopTest(),
  });
}

function pickRepeat(a, done) {
  sheet({
    title: '繰り返し', left: '戻る', right: '完了', onRight: () => done(),
    build(body) {
      const draw = () => {
        body.innerHTML = `<div class="chips">${['1回のみ', ...Object.keys(REPEAT_PRESETS)].map((k) => `<button class="chip" data-p="${k}">${k}</button>`).join('')}</div>
          <div class="list">${'日月火水木金土'.split('').map((d, i) => `<button class="row" data-d="${i}"><div class="grow">毎週${d}曜日</div>${a.days.includes(i) ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button>`).join('')}</div>`;
        $$('[data-d]', body).forEach((b) => b.onclick = () => { const i = +b.dataset.d; a.days = a.days.includes(i) ? a.days.filter((x) => x !== i) : [...a.days, i]; haptic(); draw(); });
        $$('[data-p]', body).forEach((b) => b.onclick = () => { a.days = [...(REPEAT_PRESETS[b.dataset.p] || [])]; haptic(); draw(); });
      };
      draw();
    },
  });
}

function pickSound(a, files, done) {
  sheet({
    title: 'サウンド', left: '戻る', right: '完了', onRight: () => { engine.stopTest(); done(); },
    build(body) {
      const draw = (list) => {
        body.innerHTML = `
          <div class="section-title">内蔵の音</div>
          <div class="list">${BUILTIN.map((b) => `<button class="row" data-s="${b.id}"><div class="grow">${esc(b.name)}</div>${a.soundId === b.id ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button>`).join('')}</div>
          <div class="section-title">ファイルから読み込んだ音</div>
          <div class="list">
            ${list.map((f) => `<div class="row"><button class="grow" style="text-align:left" data-s="${f.id}">${I.music} ${esc(f.name)}</button>${a.soundId === f.id ? `<span style="color:var(--blue)">${I.check}</span>` : ''}<button data-rm="${f.id}" style="color:var(--red)">${I.trash}</button></div>`).join('')}
            <label class="row" style="color:var(--blue)">${I.plus}<div class="grow">ファイルから追加…</div><input type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.caf" hidden id="snd-file"></label>
          </div>
          <div class="section-foot">「ファイル」アプリに保存した mp3・m4a・wav などを選べます。選ぶと試しに鳴ります（イヤホンから）。</div>`;
        $$('[data-s]', body).forEach((b) => b.onclick = async () => {
          a.soundId = b.dataset.s; haptic(); draw(list);
          try { await engine.test({ ...a, ringSec: 5, fade: 0 }); } catch {}
        });
        $$('[data-rm]', body).forEach((b) => b.onclick = async () => {
          if (!(await confirmBox('この音を削除しますか？', '', '削除', { destructive: true }))) return;
          await removeFile(b.dataset.rm);
          if (a.soundId === b.dataset.rm) a.soundId = 'b:marimba';
          draw(await listFiles());
        });
        $('#snd-file', body).onchange = async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try { toast('読み込み中…'); const id = await addFile(f); a.soundId = id; draw(await listFiles()); toast('追加しました'); }
          catch (err) { toast(err.message); }
        };
      };
      draw(files);
    },
  });
}

function chooseMode() {
  const s = store.data.settings;
  sheet({
    title: '待機モード', left: '閉じる',
    build(body) {
      const draw = () => {
        body.innerHTML = `
          <div class="list">
            <button class="row" data-m="saver"><div class="grow"><b>イヤホン節電モード</b>（おすすめ）<div class="sub">画面を暗くつけたまま待機し、鳴らす時だけイヤホンに音を送ります。待機中のイヤホンの電池をほとんど使いません。iPhoneは充電しながら、アプリを開いたまま置いてください。</div></div>${s.alarmMode === 'saver' ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button>
            <button class="row" data-m="stream"><div class="grow"><b>確実モード</b><div class="sub">無音をずっと流して待機します。画面を消しても・ロックしても鳴り、イヤホンが外れた瞬間に必ず気づいて無音にします。そのぶんイヤホンの電池を使います（長時間の睡眠では電池切れに注意）。</div></div>${s.alarmMode === 'stream' ? `<span style="color:var(--blue)">${I.check}</span>` : ''}</button>
          </div>
          <div class="section-title">イヤホンの確認</div>
          <div class="list">
            <div class="row"><div class="grow">イヤホンが無い時は鳴らさない<div class="sub">オフにするとスピーカーから鳴ることがあります</div></div>${switchHTML('', s.requireEar, 'id="m-req"')}</div>
            <div class="row"><div class="grow">マイクの一覧でも確かめる（試験的）<div class="sub">マイク付きイヤホン（AirPods など）なら、外れたことを節電モードでも検出できます。開始時にマイクの許可を求めます（録音はしません）。</div></div>${switchHTML('', s.earMic, 'id="m-mic"')}</div>
          </div>
          <div class="section-foot">節電モードでマイク確認を使わない場合、寝ている間にイヤホンの電池が切れると、鳴らす時にイヤホンが無いことに気づけません（その場合はスピーカーから鳴る可能性があります）。心配な時はマイク確認をオンにするか、確実モードを使ってください。</div>`;
        $$('[data-m]', body).forEach((b) => b.onclick = () => { s.alarmMode = b.dataset.m; store.save(); haptic(); draw(); renderAlarm(); if (engine.armed) toast('次に待機を始めた時から切り替わります'); });
        $('#m-req', body).onchange = (e) => { s.requireEar = e.target.checked; store.save(); };
        $('#m-mic', body).onchange = (e) => { s.earMic = e.target.checked; store.save(); };
      };
      draw();
    },
  });
}

function showLog() {
  sheet({
    title: '動作の記録', left: '閉じる',
    build(body) { body.innerHTML = `<div class="list">${engine.log.length ? engine.log.map((l) => `<div class="row small">${esc(l)}</div>`).join('') : '<div class="row muted">まだ記録はありません</div>'}</div>`; },
  });
}

// ===== おやすみ画面 =====
let sleepEl = null;
export async function openSleep() {
  if (!store.data.alarms.some((a) => a.enabled)) { toast('オンのアラームがありません'); return; }
  if (!engine.armed) {
    const s = store.data.settings;
    if (s.requireEar && !(await confirmBox('イヤホンをつけていますか？', 'イヤホンをつないでから開始してください。開始すると、音はイヤホンからだけ鳴ります。', '開始'))) return;
    const ok = await engine.arm();
    if (!ok) return;
  }
  if (sleepEl) return;
  sleepEl = document.createElement('div');
  sleepEl.className = 'sleep-screen';
  sleepEl.innerHTML = `<div class="dimmer" style="opacity:0"></div>
    <div class="clock" id="sl-clock"></div>
    <div class="info" id="sl-info"></div>
    <div class="bottom">
      <button class="hold" id="sl-ear" style="display:none;background:#3a1d1d;color:#ff8a80"><span>イヤホンをつないだらタップ</span></button>
      <button class="hold" id="sl-exit"><i></i><span>長押しで待機をやめる</span></button>
      <div style="font-size:12px;color:#48484a">画面を軽くたたくと少し明るくなります</div>
    </div>`;
  $('#layers').append(sleepEl);
  let dimT;
  const dim = $('.dimmer', sleepEl);
  const wake = () => { dim.style.opacity = 0; clearTimeout(dimT); dimT = setTimeout(() => { dim.style.opacity = 0.65; }, 8000); };
  sleepEl.addEventListener('click', wake);
  wake();
  $('#sl-ear', sleepEl).onclick = async (e) => { e.stopPropagation(); if (await engine.reconnect()) toast('イヤホンでの待機に戻りました'); };
  // 長押しで解除（寝ぼけて押しても解除されないように）
  const ex = $('#sl-exit', sleepEl), bar = $('i', ex);
  let ht;
  const start = (e) => { e.preventDefault(); bar.style.transition = 'width 1.2s linear'; bar.style.width = '100%'; ht = setTimeout(() => { engine.disarm(); closeSleep(); toast('待機をやめました'); }, 1200); };
  const cancel = () => { clearTimeout(ht); bar.style.transition = 'width .2s'; bar.style.width = '0'; };
  ex.addEventListener('touchstart', start); ex.addEventListener('mousedown', start);
  ex.addEventListener('touchend', cancel); ex.addEventListener('mouseup', cancel); ex.addEventListener('mouseleave', cancel);
  updateSleep();
}
function closeSleep() { sleepEl?.remove(); sleepEl = null; }
function updateSleep() {
  if (!sleepEl) return;
  if (!engine.armed) { closeSleep(); return; }
  const now = new Date();
  $('#sl-clock', sleepEl).textContent = `${now.getHours()}:${pad(now.getMinutes())}`;
  const nx = nextAny();
  const s = store.data.settings;
  $('#sl-info', sleepEl).innerHTML = `${nx ? `⏰ ${new Date(nx.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}　${esc(nx.alarm?.label || '')}（${untilText(nx.at - Date.now())}）` : '予定のアラームはありません'}<br>
    ${engine.ear === 'lost' ? '<span style="color:#ff6b60">⚠︎ イヤホンが外れたため、鳴らしません</span>' : '🎧 イヤホンだけで鳴らします'}<br>
    <span style="font-size:13px;color:#48484a">${s.alarmMode === 'saver' ? 'イヤホン節電モード：このまま画面を閉じずに置いてください' : '確実モード：画面を消しても大丈夫です'}</span>`;
  $('#sl-ear', sleepEl).style.display = engine.ear === 'lost' ? '' : 'none';
}

// ===== 鳴動画面 =====
let ringEl = null;
function showRing() {
  const r = engine.ringing;
  if (!r) return;
  closeRing();
  const a = r.alarm;
  ringEl = document.createElement('div');
  ringEl.className = 'ring-screen';
  const now = new Date();
  const burst = r.total > 1;
  ringEl.innerHTML = `<div class="ripple"></div>
    <div style="text-align:center">
      <div class="bell">⏰</div>
      <div class="clock">${now.getHours()}:${pad(now.getMinutes())}</div>
      <div class="label">${esc(a.label || 'アラーム')}${burst ? `<br><span style="font-size:15px;opacity:.85">連続 ${r.index + 1} / ${r.total} 回目</span>` : ''}${r.snooze ? `<br><span style="font-size:15px;opacity:.85">スヌーズ ${r.snooze} 回目</span>` : ''}</div>
      ${r.silent ? `<div class="ear-state" style="margin-top:12px">🔇 イヤホンが無いため音は鳴らしていません</div>` : ''}
    </div>
    <div class="btns" id="ring-btns">
      ${engine.canSnooze() ? `<button class="btn snooze" data-r="snooze">スヌーズ（${a.snooze.minutes}分）</button>` : ''}
      ${burst ? `<button class="btn stop" data-r="stop">この回だけ止める</button><button class="btn awake" data-r="awake">起きた！（残り${r.total - r.index - 1}回も止める）</button>` : `<button class="btn awake" data-r="awake">停止</button>`}
    </div>`;
  $('#layers').append(ringEl);
  $$('[data-r]', ringEl).forEach((b) => b.onclick = () => {
    haptic();
    const k = b.dataset.r;
    if (k === 'snooze') engine.snooze();
    else if (k === 'stop') engine.stopRing();
    else if (a.mission) mission(() => engine.awake());
    else engine.awake();
  });
}
function mission(done) {
  const x = 12 + Math.floor(Math.random() * 80), y = 12 + Math.floor(Math.random() * 80);
  const box = $('#ring-btns', ringEl);
  box.innerHTML = `<div class="mission"><div>計算して止める</div><div class="q">${x} + ${y} = ?</div><input type="number" inputmode="numeric" id="ms-in"><button class="btn snooze" style="margin-top:10px" id="ms-ok">答える</button></div>`;
  const inp = $('#ms-in', box);
  inp.focus();
  $('#ms-ok', box).onclick = () => {
    if (+inp.value === x + y) done();
    else { inp.value = ''; inp.style.background = '#ffd0cc'; setTimeout(() => (inp.style.background = ''), 400); toast('ちがいます'); }
  };
}
function closeRing() { ringEl?.remove(); ringEl = null; }
