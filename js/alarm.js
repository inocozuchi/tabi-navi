// アラームの心臓部：いつ鳴らすかの計算・待機・鳴らす・イヤホンの見張り
//
// 【イヤホンからだけ鳴らすしくみ】
// ・iPhone は、音を流している途中でイヤホンが外れる（電池切れ・接続が切れる）と、
//   その音を自動で「一時停止」する。スピーカーに切り替えて鳴らし続けることはしない。
//   このアプリは、自分で止めていない一時停止を「イヤホンが外れた」と受け取り、以後は鳴らさない。
// ・<audio> の音はマナーモード（消音スイッチ）に関係なく鳴る。
// ・待機の方法は2つ：
//   saver  … イヤホン節電：画面をつけたまま（暗く）待ち、鳴らす時だけ音を流す。イヤホンは待機中に音を受け取らないので電池が長持ち。
//   stream … 確実：無音をずっと流して待つ。画面を消しても動き、イヤホンが外れた瞬間に必ず気づける。
import { store, pad, toast } from './util.js';
import { render, silence } from './sounds.js';

const DAY = 86400000;
export const REPEAT_PRESETS = { 毎日: [0, 1, 2, 3, 4, 5, 6], 平日: [1, 2, 3, 4, 5], 週末: [0, 6] };

export function newAlarm() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return {
    id: Date.now().toString(36), label: '', time: `${pad(d.getHours())}:${pad(Math.floor(d.getMinutes() / 5) * 5)}`,
    enabled: true, days: [], onceDate: null,
    burst: { enabled: true, minutes: 15, interval: 1 },
    soundId: 'b:marimba', ringSec: 40, fade: 10, vol: 1,
    snooze: { enabled: true, minutes: 5, max: 3 },
    mission: false, skipUntil: 0,
  };
}

// 連続アラームの回数と時刻
export function burstOffsets(a) {
  if (!a.burst?.enabled) return [0];
  const iv = Math.max(1, +a.burst.interval || 1), mins = Math.max(iv, +a.burst.minutes || iv);
  const n = Math.floor(mins / iv);
  return Array.from({ length: n }, (_, k) => k * iv);
}
function baseOn(a, day) {
  const [h, m] = a.time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
}
// 1回だけのアラームは、次にくる日付を決めておく
export function fixOnce(a, now = Date.now()) {
  if (a.days?.length) { a.onceDate = null; return; }
  const today = new Date(now);
  let b = baseOn(a, today);
  if (b <= now) b = baseOn(a, new Date(now + DAY));
  const d = new Date(b);
  a.onceDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayAllowed(a, day) {
  if (a.days?.length) return a.days.includes(day.getDay());
  const k = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return k === a.onceDate;
}
// from より後、to まで（含む）の鳴る時刻
export function occurrences(a, from, to) {
  const out = [];
  if (!a.enabled) return out;
  const offs = burstOffsets(a);
  const span = offs[offs.length - 1] * 60000;
  for (let t = from - span - DAY; t <= to + DAY; t += DAY) {
    const day = new Date(t);
    if (!dayAllowed(a, day)) continue;
    const base = baseOn(a, day);
    offs.forEach((o, i) => {
      const at = base + o * 60000;
      if (at > from && at <= to && at > (a.skipUntil || 0)) out.push({ alarm: a, at, index: i, total: offs.length, base });
    });
  }
  return out.sort((x, y) => x.at - y.at);
}
export function nextOccurrence(a, now = Date.now()) {
  return occurrences(a, now, now + 8 * DAY)[0] || null;
}
export function nextAny(now = Date.now()) {
  let best = null;
  for (const a of store.data.alarms) {
    const o = nextOccurrence(a, now);
    if (o && (!best || o.at < best.at)) best = o;
  }
  for (const s of engine.snoozes) if (!best || s.at < best.at) best = { alarm: findAlarm(s.alarmId), at: s.at, snooze: true };
  return best;
}
const findAlarm = (id) => store.data.alarms.find((a) => a.id === id);

export function repeatText(a) {
  const d = [...(a.days || [])].sort();
  if (!d.length) return '1回のみ';
  for (const [k, v] of Object.entries(REPEAT_PRESETS)) if (v.join() === d.join()) return k;
  return d.map((x) => '日月火水木金土'[x]).join(' ');
}

// ===== 待機と鳴動 =====
export const engine = {
  armed: false,
  ear: 'unknown', // ok / lost / unknown
  micBaseline: null, // 待機開始時にマイク一覧でイヤホンが見えたか
  ringing: null,
  snoozes: [],
  log: [],
  listeners: new Set(),
  player: null,
  wakeLock: null,
  lastTick: 0,
  ourAction: 0,

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(type, data) { for (const fn of this.listeners) fn(type, data); },
  addLog(msg) {
    const d = new Date();
    this.log.unshift(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${msg}`);
    this.log.length = Math.min(this.log.length, 50);
    this.emit('log');
  },

  init() {
    const p = new Audio();
    p.preload = 'auto';
    p.setAttribute('playsinline', '');
    this.player = p;
    p.addEventListener('pause', () => {
      // 自分で止めた／最後まで鳴り終わった時は無視。それ以外は「イヤホンが外れた・他のアプリに取られた」
      if (Date.now() - this.ourAction < 1500 || p.ended || !this.armed) return;
      this.earLost('音が自動で止まりました（イヤホンが外れた可能性）');
    });
    p.addEventListener('ended', () => {
      if (this.ringing) this.endRing('timeout');
      else if (this.armed && store.data.settings.alarmMode === 'stream' && this.ear === 'ok') this.play(silence(), true).catch(() => {});
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.checkMic());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { if (this.armed && store.data.settings.alarmMode === 'saver') this.lockScreen(); this.tick(); }
    });
    setInterval(() => this.tick(), 1000);
    this.lastTick = Date.now();
  },

  setSession() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  },
  async play(url, loop) {
    const p = this.player;
    this.ourAction = Date.now();
    p.loop = loop;
    if (p.src !== url) p.src = url;
    try { p.currentTime = 0; } catch {}
    this.ourAction = Date.now();
    await p.play();
  },
  pause() { this.ourAction = Date.now(); this.player.pause(); },

  // ボタンを押した時（ユーザー操作の中）に呼ぶ：音を出せる状態にする
  async unlock() {
    this.setSession();
    await this.play(silence(), true);
    if (store.data.settings.alarmMode !== 'stream') { await new Promise((r) => setTimeout(r, 300)); this.pause(); }
  },

  async arm() {
    const s = store.data.settings;
    try { await this.unlock(); } catch (e) { toast('音の準備ができませんでした。もう一度押してください'); return false; }
    this.armed = true;
    this.ear = 'ok';
    this.lastTick = Date.now();
    if (s.earMic) {
      this.micBaseline = await this.micEar(true);
      if (this.micBaseline === false) toast('マイク一覧にイヤホンが見つかりません。このイヤホンでは一覧での確認は使いません', 4000);
    } else this.micBaseline = null;
    if (s.alarmMode === 'saver') await this.lockScreen();
    this.setMedia('待機中');
    this.addLog(`待機開始（${s.alarmMode === 'saver' ? 'イヤホン節電' : '確実'}モード）`);
    this.prerender();
    this.emit('state');
    return true;
  },
  disarm() {
    this.armed = false;
    if (this.ringing) this.endRing('stop');
    this.pause();
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
    this.addLog('待機終了');
    this.emit('state');
  },
  async reconnect() {
    try { await this.unlock(); this.ear = 'ok'; this.addLog('イヤホン再接続を確認'); this.emit('state'); return true; }
    catch { return false; }
  },
  async lockScreen() {
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { this.wakeLock = null; }
  },
  earLost(why) {
    if (this.ear === 'lost') return;
    this.ear = 'lost';
    this.addLog(why);
    if (this.ringing) this.endRing('earlost');
    this.emit('state');
  },
  // マイクの一覧（許可が要る）でイヤホンらしき機器を探す。true/false、分からない時は null
  async micEar(ask = false) {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return null;
      if (ask) {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
        st.getTracks().forEach((t) => t.stop());
        this.setSession();
      }
      const ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      if (!ins.some((d) => d.label)) return null;
      return ins.some((d) => d.label && !/iphone|ipad|built-?in|内蔵|internal|front|back|bottom|前面|背面|底面/i.test(d.label));
    } catch { return null; }
  },
  async checkMic() {
    if (!this.armed || !store.data.settings.earMic || this.micBaseline !== true) return;
    const r = await this.micEar(false);
    if (r === false) this.earLost('マイク一覧からイヤホンが消えました');
  },
  async earOK() {
    const s = store.data.settings;
    if (!s.requireEar) return true;
    if (this.ear === 'lost') return false;
    if (s.earMic && this.micBaseline === true) {
      const r = await this.micEar(false);
      if (r === false) { this.earLost('鳴らす直前の確認でイヤホンが見つかりません'); return false; }
    }
    return true;
  },

  async prerender() {
    for (const a of store.data.alarms.filter((x) => x.enabled)) {
      try { await render({ soundId: a.soundId, seconds: a.ringSec, fade: a.fade, vol: a.vol }); } catch {}
    }
  },

  setMedia(state) {
    try {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({ title: state === '鳴動中' ? 'アラーム' : '旅ナビ アラーム待機中', artist: '旅ナビ', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
      // ロック画面の一時停止＝このアラームを止める
      navigator.mediaSession.setActionHandler('pause', () => { this.ourAction = Date.now(); if (this.ringing) this.stopRing(); else this.player.pause(); });
      navigator.mediaSession.setActionHandler('play', () => { if (this.armed && store.data.settings.alarmMode === 'stream' && this.ear === 'ok') this.play(silence(), true).catch(() => {}); });
    } catch {}
  },

  tick() {
    const now = Date.now();
    let from = this.lastTick || now - 1000;
    if (now - from > 10 * 60000) from = now - 2 * 60000; // 長く止まっていた時は、直近2分の分だけ拾う
    this.lastTick = now;
    const due = [];
    for (const a of store.data.alarms) due.push(...occurrences(a, from, now));
    const sn = this.snoozes.filter((s) => s.at > from && s.at <= now);
    this.snoozes = this.snoozes.filter((s) => s.at > now);
    for (const s of sn) { const a = findAlarm(s.alarmId); if (a) due.push({ alarm: a, at: s.at, index: 0, total: 1, snooze: s.n }); }
    this.cleanupOnce(now);
    if (due.length) {
      due.sort((x, y) => x.at - y.at);
      this.ring(due[due.length - 1]);
    }
    this.emit('tick', now);
  },
  cleanupOnce(now) {
    let changed = false;
    for (const a of store.data.alarms) {
      if (!a.enabled || a.days?.length || !a.onceDate) continue;
      const [y, m, d] = a.onceDate.split('-').map(Number);
      const offs = burstOffsets(a);
      const end = baseOn(a, new Date(y, m - 1, d)) + offs[offs.length - 1] * 60000 + a.ringSec * 1000;
      if (now > end && !this.snoozes.some((s) => s.alarmId === a.id) && this.ringing?.alarm.id !== a.id) { a.enabled = false; changed = true; }
    }
    if (changed) store.save();
  },

  async ring(occ) {
    const a = occ.alarm;
    const tag = occ.snooze ? `スヌーズ${occ.snooze}回目` : occ.total > 1 ? `${occ.index + 1}/${occ.total}回目` : '';
    if (!this.armed) {
      this.addLog(`「${a.label || a.time}」${tag} … 待機していないため鳴らせませんでした`);
      this.emit('missed', occ);
      return;
    }
    const ok = await this.earOK();
    this.ringing = { ...occ, silent: !ok, started: Date.now() };
    this.emit('ring', this.ringing);
    if (!ok) {
      this.addLog(`「${a.label || a.time}」${tag} … イヤホン未接続のため無音`);
      clearTimeout(this.silentTimer);
      this.silentTimer = setTimeout(() => this.endRing('timeout'), a.ringSec * 1000);
      return;
    }
    try {
      const url = await render({ soundId: a.soundId, seconds: a.ringSec, fade: a.fade, vol: a.vol });
      this.setMedia('鳴動中');
      await this.play(url, false);
      this.addLog(`「${a.label || a.time}」${tag} 鳴動`);
    } catch (e) {
      this.addLog(`鳴らせませんでした: ${e.message || e}`);
      this.ringing.silent = true;
      this.emit('ring', this.ringing);
    }
  },
  async endRing(reason) {
    if (!this.ringing) return;
    clearTimeout(this.silentTimer);
    const r = this.ringing;
    this.ringing = null;
    if (reason !== 'earlost') {
      if (this.armed && store.data.settings.alarmMode === 'stream' && this.ear === 'ok') {
        try { await this.play(silence(), true); } catch {}
      } else this.pause();
    }
    this.setMedia('待機中');
    this.emit('ringend', { ...r, reason });
  },
  stopRing() { this.endRing('stop'); },
  snooze() {
    const r = this.ringing;
    if (!r) return;
    const a = r.alarm;
    const n = (r.snooze || 0) + 1;
    this.snoozes.push({ alarmId: a.id, at: Date.now() + a.snooze.minutes * 60000, n });
    this.addLog(`スヌーズ ${a.snooze.minutes}分後`);
    this.endRing('snooze');
  },
  canSnooze() {
    const r = this.ringing;
    return !!(r && r.alarm.snooze?.enabled && (r.snooze || 0) < (r.alarm.snooze.max || 0));
  },
  // 起きた：このアラームの今回分（連続の残り・スヌーズ）をすべて止める
  awake() {
    const r = this.ringing;
    const a = r?.alarm;
    if (a) {
      const offs = burstOffsets(a);
      a.skipUntil = (r.base || r.at) + offs[offs.length - 1] * 60000;
      this.snoozes = this.snoozes.filter((s) => s.alarmId !== a.id);
      store.save();
      this.addLog(`「${a.label || a.time}」今回分をすべて停止`);
    }
    this.endRing('awake');
  },
  // 試しに鳴らす（ボタンの中で呼ぶ）
  async test(a) {
    this.setSession();
    const url = await render({ soundId: a.soundId, seconds: Math.min(8, a.ringSec), fade: Math.min(a.fade, 4), vol: a.vol });
    await this.play(url, false);
  },
  stopTest() { this.pause(); },
};
