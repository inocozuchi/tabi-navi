// アラーム音：内蔵の音を作る／読み込んだファイルを使う。
// 鳴らす前に「だんだん大きく」と音量を焼き込んだ WAV を作っておく。
// （iPhone の Safari は audio.volume を変えられないため、音そのものに音量を入れておく）
import { blobs } from './util.js';

const SR = 22050;

export const BUILTIN = [
  { id: 'b:beep', name: '電子音（ピピピ）' },
  { id: 'b:bell', name: 'ベル' },
  { id: 'b:marimba', name: 'マリンバ' },
  { id: 'b:chime', name: 'やさしいチャイム' },
  { id: 'b:birds', name: '小鳥' },
  { id: 'b:rise', name: 'のぼり音' },
];

const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
function synth(id) {
  const len = id === 'b:birds' ? 3 : 2;
  const n = Math.floor(SR * len);
  const out = new Float32Array(n);
  const tone = (start, freq, dura, decay, harm = [1], vol = 0.5, attack = 0.005) => {
    const s0 = Math.floor(start * SR), s1 = Math.min(n, s0 + Math.floor(dura * SR));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SR;
      let v = 0;
      harm.forEach((h, k) => { v += Math.sin(2 * Math.PI * freq * (k + 1) * t) * h; });
      out[i] += v * env(t, attack, decay) * vol;
    }
  };
  switch (id) {
    case 'b:beep':
      for (let k = 0; k < 4; k++) tone(k * 0.16, 2093, 0.1, 1, [1], 0.45, 0.003);
      for (let k = 0; k < 4; k++) tone(1 + k * 0.16, 2093, 0.1, 1, [1], 0.45, 0.003);
      break;
    case 'b:bell':
      for (const st of [0, 0.5, 1, 1.5]) tone(st, 1318.5, 0.5, 0.25, [1, 0.5, 0.3, 0.15], 0.35);
      break;
    case 'b:marimba': {
      const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25, 783.99, 1046.5];
      notes.forEach((f, k) => tone(k * 0.25, f, 0.4, 0.12, [1, 0, 0.25], 0.55));
      break;
    }
    case 'b:chime': {
      const notes = [880, 698.46, 783.99, 523.25];
      notes.forEach((f, k) => tone(k * 0.45, f, 1.2, 0.5, [1, 0.3, 0.1], 0.4, 0.02));
      break;
    }
    case 'b:birds':
      for (const [st, f0] of [[0.1, 3200], [0.35, 3600], [0.6, 3000], [1.6, 3400], [1.8, 3800]]) {
        const s0 = Math.floor(st * SR), m = Math.floor(0.12 * SR);
        let ph = 0;
        for (let i = 0; i < m && s0 + i < n; i++) {
          const t = i / SR;
          const f = f0 + 1500 * Math.sin(Math.PI * t / 0.12);
          ph += 2 * Math.PI * f / SR;
          out[s0 + i] += Math.sin(ph) * Math.sin(Math.PI * t / 0.12) * 0.35;
        }
      }
      break;
    case 'b:rise': {
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR, seg = t % 0.5;
        const f = 600 + seg * 1600;
        ph += 2 * Math.PI * f / SR;
        out[i] = Math.sin(ph) * (seg < 0.42 ? 0.4 : 0) * Math.min(1, seg * 40);
      }
      break;
    }
  }
  return out;
}

async function decodeFile(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, SR, SR);
  const audio = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(buf, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  // モノラルにまとめる（decodeAudioData が SR に合わせてくれる）
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / audio.numberOfChannels;
  }
  return out;
}

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

let silentUrl;
// 無音（待機中に流し続ける用）
export function silence() {
  silentUrl ??= URL.createObjectURL(wav(new Float32Array(SR * 5)));
  return silentUrl;
}

const srcCache = new Map();
async function source(soundId) {
  if (srcCache.has(soundId)) return srcCache.get(soundId);
  let data;
  if (soundId?.startsWith('f:')) {
    const rec = await blobs.get('sound:' + soundId);
    if (rec?.blob) {
      try { data = await decodeFile(rec.blob); } catch { data = null; }
    }
  }
  if (!data) data = synth(BUILTIN.some((b) => b.id === soundId) ? soundId : 'b:beep');
  srcCache.set(soundId, data);
  return data;
}

const rendered = new Map();
// 鳴らす音を作る。seconds の長さで、fade 秒かけて小→大、vol は 0〜1
export async function render({ soundId, seconds = 60, fade = 0, vol = 1 }) {
  const key = `${soundId}|${seconds}|${fade}|${vol}`;
  if (rendered.has(key)) return rendered.get(key);
  const src = await source(soundId);
  // 曲の頭と終わりの無音を少し削ってから繰り返す
  let a = 0, b = src.length;
  while (a < b && Math.abs(src[a]) < 0.003) a++;
  while (b > a && Math.abs(src[b - 1]) < 0.003) b--;
  const loop = src.subarray(Math.max(0, a - 50), Math.min(src.length, b + SR * 0.3));
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < loop.length; i++) peak = Math.max(peak, Math.abs(loop[i]));
  const norm = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const g = fade > 0 ? Math.min(1, 0.08 + (0.92 * t) / fade) : 1;
    out[i] = loop.length ? loop[i % loop.length] * norm * g * vol : 0;
  }
  // 終わりを短く絞って「プツッ」を防ぐ
  for (let i = 0; i < Math.min(n, 400); i++) out[n - 1 - i] *= i / 400;
  const url = URL.createObjectURL(wav(out));
  rendered.set(key, url);
  return url;
}

export async function addFile(file) {
  const id = 'f:' + Date.now().toString(36);
  await blobs.put('sound:' + id, { name: file.name.replace(/\.[^.]+$/, ''), blob: file });
  // 読めるか確かめる
  try { await decodeFile(file); } catch { await blobs.del('sound:' + id); throw new Error('この音声ファイルは読み込めませんでした'); }
  return id;
}
export async function listFiles() {
  const keys = (await blobs.keys()).filter((k) => String(k).startsWith('sound:'));
  const out = [];
  for (const k of keys) { const r = await blobs.get(k); out.push({ id: k.slice(6), name: r?.name || '音声' }); }
  return out;
}
export async function removeFile(id) { await blobs.del('sound:' + id); srcCache.delete(id); }
export async function soundName(id) {
  const b = BUILTIN.find((x) => x.id === id);
  if (b) return b.name;
  if (id?.startsWith('f:')) { const r = await blobs.get('sound:' + id); return r?.name || '（削除された音）'; }
  return BUILTIN[0].name;
}
