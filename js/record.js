// 車窓録画：カメラで直接録画し、録画中は画面を真っ黒にして電池を節約する。
// 止める時は、誤って止めないように「10回タップ」。
// ・iPhone は、ロックしたり他のアプリに切り替えると、カメラを自動で止める（Webでもアプリでも同じ）。
//   なので、画面は消さずに「真っ黒に見せる」だけにする（有機ELなら黒い画面はほとんど電気を使わない）。
// ・録画は 5秒ごとに端末の中へ保存しながら進めるので、途中で止まってもそこまでは残る。
import { $, esc, store, sheet, page, toast, confirmBox, haptic, I, blobs, download, pad, switchHTML } from './util.js';

const TAPS = 10;
const GAP = 4000; // この時間タップが無いと、数え直し
const OPTS = {
  quality: [['720', '標準（720p）・電池にやさしい'], ['1080', '高画質（1080p）'], ['2160', '最高画質（4K・電池をよく使う）']],
  fps: [['24', '24fps（電池にやさしい）'], ['30', '30fps'], ['60', '60fps（対応していない機種では30fps）']],
};
const DEFAULTS = { quality: '2160', fps: '60', audio: false, facing: 'environment' }; // 標準は最高画質・最高コマ数
const pick = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tabinavi.rec2') || '{}') }; } catch { return { ...DEFAULTS }; } };
const keep = (o) => { try { localStorage.setItem('tabinavi.rec2', JSON.stringify(o)); } catch {} };
const BITRATE = { 720: 2.5e6, 1080: 6e6, 2160: 20e6 }; // 画質ごとのビットレート
const rate = (q, fps) => (BITRATE[q] || 6e6) * (+fps >= 60 ? 1.6 : 1); // 60fps は1.6倍

const mime = () => ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
const ext = (t) => (/mp4/.test(t) ? 'mp4' : 'webm');
const fmtT = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const fmtB = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB');

let rec = null; // 録画中の状態

// ===== 録画の一覧・設定の画面 =====
export function openRecord() {
  page({
    title: '車窓録画',
    build(body) { draw(body); },
  });
  async function draw(body) {
    const o = pick();
    const keys = (await blobs.keys()).filter((k) => String(k).startsWith('rec:') && String(k).endsWith(':meta'));
    const metas = (await Promise.all(keys.map((k) => blobs.get(k)))).filter(Boolean).sort((a, b) => b.at - a.at);
    const est = rate(o.quality, o.fps) / 1e6; // 録画の設定（Mbps）
    body.innerHTML = `
      <div class="card" style="text-align:center;padding:22px 16px">
        <div style="font-size:40px">🎥</div>
        <div class="card-title" style="font-size:19px;margin:4px 0">画面を真っ黒にして録画</div>
        <div class="small muted">録画中は画面が真っ黒になり、電池の減りを抑えます。<br>画面を<b>5回タップでメモ</b>、<b>${TAPS}回タップで停止</b>します。</div>
        <button class="btn" id="rc-start" style="margin-top:16px">${I.play}録画を始める</button>
      </div>
      <div class="section-title">設定</div>
      <div class="list">
        <div class="row"><div class="grow">画質</div><select id="rc-q">${OPTS.quality.map(([v, n]) => `<option value="${v}" ${o.quality === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="row"><div class="grow">コマ数</div><select id="rc-f">${OPTS.fps.map(([v, n]) => `<option value="${v}" ${o.fps === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="row"><div class="grow">カメラ</div><select id="rc-c"><option value="environment" ${o.facing === 'environment' ? 'selected' : ''}>背面（車窓向き）</option><option value="user" ${o.facing === 'user' ? 'selected' : ''}>前面</option></select></div>
        <div class="row"><div class="grow">音も録音<div class="sub">オフなら電池も容量も節約</div></div>${switchHTML('', o.audio, 'id="rc-a"')}</div>
      </div>
      <div class="section-foot">目安：1時間で約 ${fmtB((est * 1e6 / 8) * 3600)}。${o.quality === '2160' ? '4Kは容量も電池もよく使います。' : ''}容量と電池に気をつけてください。<b>充電しながら</b>、車のホルダーなどに固定して使うのがおすすめです。</div>
      <div class="section-title">撮った動画</div>
      <div class="list">${metas.length ? metas.map((m) => `<div class="row" data-id="${m.id}"><div class="grow">${new Date(m.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}<div class="sub">${fmtT(m.sec)}・${fmtB(m.size)}・${m.w}×${m.h}${m.fps ? '・' + m.fps + 'fps' : ''}${m.marks?.length ? '・メモ' + m.marks.length + '件' : ''}${m.partial ? '・途中で止まりました' : ''}</div></div><button class="btn small secondary" data-a="save">${I.share}保存</button><button data-a="del" style="color:var(--red)">${I.trash}</button></div>`).join('') : '<div class="row muted small">まだ動画はありません</div>'}</div>
      <div class="section-foot">「保存」→「ビデオを保存」で、写真アプリに入れられます。保存したら、ここから消して容量を空けてください。</div>
      <div class="section-title">できないこと（iPhoneの決まり）</div>
      <div class="section-foot">画面をロックしたり、他のアプリに切り替えると、カメラは自動で止まります（どのアプリも同じ）。録画中はアプリを開いたままにしてください。電話がかかってきた時も止まります。</div>`;
    $('#rc-q', body).onchange = (e) => { keep({ ...pick(), quality: e.target.value }); draw(body); };
    $('#rc-f', body).onchange = (e) => { keep({ ...pick(), fps: e.target.value }); draw(body); };
    $('#rc-c', body).onchange = (e) => keep({ ...pick(), facing: e.target.value });
    $('#rc-a', body).onchange = (e) => keep({ ...pick(), audio: e.target.checked });
    $('#rc-start', body).onclick = async () => {
      if (!(await confirmBox('録画を始めますか？', `画面が真っ黒になります。5回タップでメモ、${TAPS}回タップで停止です。`, '始める'))) return;
      start({ ...pick(), onEnd: () => draw(body) });
    };
    body.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      const id = r.dataset.id;
      if (a === 'save') await saveOut(id);
      if (a === 'del' && (await confirmBox('この動画を消しますか？', '消すと戻せません。先に「保存」したか確かめてください。', '消す', { destructive: true }))) { await removeRec(id); draw(body); }
    }));
  }
}

async function load(id) {
  const m = await blobs.get(`rec:${id}:meta`);
  const parts = [];
  for (let i = 0; i < m.n; i++) parts.push(await blobs.get(`rec:${id}:${i}`));
  return { m, blob: new Blob(parts.filter(Boolean), { type: m.type }) };
}
async function saveOut(id) {
  toast('準備しています…', 20000);
  const { m, blob } = await load(id);
  const name = `車窓_${new Date(m.at).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${ext(m.type)}`;
  const file = new File([blob], name, { type: m.type });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function removeRec(id) {
  const m = await blobs.get(`rec:${id}:meta`);
  for (let i = 0; i < (m?.n || 0); i++) await blobs.del(`rec:${id}:${i}`);
  await blobs.del(`rec:${id}:meta`);
}

// ===== 録画 =====
async function start(o) {
  const q = +o.quality;
  const dims = { 720: [1280, 720], 1080: [1920, 1080], 2160: [3840, 2160] }[q] || [1920, 1080];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: o.facing }, width: { ideal: dims[0] }, height: { ideal: dims[1] }, frameRate: { ideal: +o.fps } },
      audio: !!o.audio,
    });
  } catch (e) {
    toast(e?.name === 'NotAllowedError' ? 'カメラが許可されていません（設定 → Safari → カメラ で許可してください）' : 'カメラを使えませんでした', 5000);
    return;
  }
  const type = mime();
  if (!window.MediaRecorder) { stream.getTracks().forEach((t) => t.stop()); toast('この iPhone では録画できません（iOS 14.3 以降が必要です）', 5000); return; }
  const vt = stream.getVideoTracks()[0];
  const st = vt.getSettings();
  const id = Date.now().toString(36);
  const mr = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: rate(q, o.fps) });
  rec = { id, mr, stream, type: mr.mimeType || type, n: 0, size: 0, t0: Date.now(), taps: 0, lastTap: 0, w: st.width || dims[0], h: st.height || dims[1], fps: Math.round(st.frameRate || 0) || +o.fps, marks: [], memoId: null, pendingMemo: null, onEnd: o.onEnd, stopping: false, queue: Promise.resolve(), wake: null, bad: false };
  mr.ondataavailable = (e) => {
    if (!e.data?.size) return;
    const i = rec.n++;
    rec.size += e.data.size;
    rec.queue = rec.queue.then(() => blobs.put(`rec:${id}:${i}`, e.data)).catch(() => { rec.bad = true; });
  };
  mr.onstop = () => finish(false);
  mr.onerror = () => { toast('録画に失敗しました'); finish(true); };
  vt.addEventListener('ended', () => { if (rec && !rec.stopping) { rec.mr.state !== 'inactive' && rec.mr.stop(); } });
  try { rec.wake = await navigator.wakeLock?.request('screen'); } catch {}
  mr.start(5000);
  overlay();
  document.addEventListener('visibilitychange', onVis);
}
function onVis() {
  if (!rec) return;
  if (document.visibilityState === 'hidden') { rec.interrupted = true; }
  else if (rec.interrupted) {
    // 戻ってきた：iPhone がカメラを止めていたら、そこまでで終わりにする
    const ok = rec.stream.getVideoTracks().some((t) => t.readyState === 'live') && rec.mr.state === 'recording';
    if (!ok) { toast('ロックや画面の切り替えで録画が止まりました。ここまでを保存しました', 5000); stopNow(true); }
    else { rec.interrupted = false; try { navigator.wakeLock?.request('screen').then((w) => (rec.wake = w)); } catch {} }
  }
}
function stopNow(partial) { if (!rec || rec.stopping) return; rec.partial = partial; if (rec.mr.state !== 'inactive') rec.mr.stop(); else finish(partial); }
async function finish(partial) {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  document.removeEventListener('visibilitychange', onVis);
  r.stream.getTracks().forEach((t) => t.stop());
  try { r.wake?.release?.(); } catch {}
  await r.queue;
  const sec = Math.round((Date.now() - r.t0) / 1000);
  if (r.n > 0) await blobs.put(`rec:${r.id}:meta`, { id: r.id, at: r.t0, sec, size: r.size, n: r.n, type: r.type, w: r.w, h: r.h, fps: r.fps, marks: r.marks, partial: partial || r.partial || r.bad });
  document.getElementById('rec-screen')?.remove();
  document.getElementById('rec-memo')?.remove();
  rec = null;
  haptic();
  toast(r.n > 0 ? `録画を保存しました（${fmtT(sec)}）` : '録画できませんでした', 4000);
  r.onEnd?.();
}

// 真っ黒な画面（5回タップでメモ・10回タップで停止）
//  5回目のタップのあと、少し待ってもう1回タップが無ければメモを開く。続けてタップすれば、そのまま10回で停止。
const MEMO_AT = 5, MEMO_WAIT = 1100;
function overlay() {
  const el = document.createElement('div');
  el.id = 'rec-screen';
  el.style.cssText = 'position:fixed;inset:0;z-index:2000;background:#000;color:#000;display:flex;align-items:center;justify-content:center;touch-action:manipulation;-webkit-user-select:none;user-select:none;cursor:none';
  el.innerHTML = '<div id="rec-n" style="font:600 64px -apple-system,sans-serif;color:#2a2a2a;opacity:0;transition:opacity .15s"></div>';
  document.body.append(el);
  const n = el.querySelector('#rec-n');
  let hide;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!rec || rec.memoOpen) return;
    const now = Date.now();
    if (now - rec.lastTap > GAP) rec.taps = 0;
    rec.lastTap = now;
    rec.taps++;
    clearTimeout(rec.pendingMemo);
    haptic();
    // とても暗い数字を一瞬だけ出す（あと何回で止まるか）
    n.textContent = rec.taps < MEMO_AT ? `${rec.taps}` : `${rec.taps}`;
    n.style.opacity = 1;
    clearTimeout(hide);
    hide = setTimeout(() => (n.style.opacity = 0), 450);
    if (rec.taps >= TAPS) { stopNow(false); return; }
    if (rec.taps === MEMO_AT) rec.pendingMemo = setTimeout(() => { rec.taps = 0; openMemo(); }, MEMO_WAIT);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ===== 録画中のメモ（暗い画面のまま書く） =====
function openMemo() {
  if (!rec || rec.memoOpen) return;
  rec.memoOpen = true;
  try { navigator.vibrate?.([30, 60, 30]); } catch {}
  const at = Math.round((Date.now() - rec.t0) / 1000);
  const box = document.createElement('div');
  box.id = 'rec-memo';
  box.style.cssText = 'position:fixed;inset:0;z-index:2100;background:#000;color:#8e8e93;display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top,0px) + 16px) 16px calc(env(safe-area-inset-bottom,0px) + 16px);gap:12px;font-family:-apple-system,sans-serif';
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:15px"><span>録画中 ${fmtT(at)} のメモ</span><span style="font-size:12px">録画は続いています</span></div>
    <textarea id="rm-t" placeholder="タップして入力（音声入力もできます）" style="flex:1;background:#0c0c0c;border:1px solid #2a2a2a;border-radius:14px;color:#c7c7cc;font-size:18px;line-height:1.5;padding:14px;outline:none;resize:none;-webkit-user-select:text;user-select:text"></textarea>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${['絶景', 'トンネル', '駅', '橋', '海', '山'].map((t) => `<button data-q="${t}" style="background:#161616;color:#8e8e93;border:0;border-radius:16px;height:34px;padding:0 14px;font-size:15px">${t}</button>`).join('')}
    </div>
    <div style="display:flex;gap:10px">
      <button id="rm-x" style="flex:1;height:50px;border-radius:14px;border:0;background:#161616;color:#8e8e93;font-size:17px">メモしない</button>
      <button id="rm-ok" style="flex:1.4;height:50px;border-radius:14px;border:0;background:#1c2a44;color:#7fb2ff;font-size:17px;font-weight:600">保存して録画へ戻る</button>
    </div>`;
  document.body.append(box);
  const ta = box.querySelector('#rm-t');
  box.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => { ta.value += (ta.value && !/\s$/.test(ta.value) ? ' ' : '') + b.dataset.q; }));
  const close = () => { box.remove(); if (rec) { rec.memoOpen = false; rec.taps = 0; rec.lastTap = Date.now(); } };
  box.querySelector('#rm-x').onclick = close;
  box.querySelector('#rm-ok').onclick = () => {
    const text = ta.value.trim();
    // 録画の印（何秒の所か）だけでも残す。文字があれば、1つのメモにまとめる
    rec.marks.push({ sec: at, text });
    const line = `【録画 ${fmtT(at)}（${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}）】${text || '（しるし）'}`;
    let m = rec.memoId && store.data.memos.find((x) => x.id === rec.memoId);
    if (!m) {
      m = { id: 'rec' + rec.id, title: `車窓メモ ${new Date(rec.t0).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${new Date(rec.t0).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}〜`, text: '', updated: Date.now() };
      store.data.memos.push(m); rec.memoId = m.id;
    }
    m.text = [m.text, line].filter(Boolean).join('\n');
    m.updated = Date.now();
    store.save();
    try { navigator.vibrate?.(40); } catch {}
    close();
  };
}
