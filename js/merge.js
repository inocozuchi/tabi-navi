// 読み取り結果をまとめる
//  ・AI と端末の読み取りなど、複数の読み取り結果を「同じ予定どうし」で組にする
//  ・組になった予定の中身が食い違っていれば「どちらを使うか」を選べるようにする
//  ・旅程にすでにある予定と似ていれば、上書きするか選べるようにする
import { TRANSPORT, parseLocal } from './util.js';

export const FIELDS = [
  ['type', '種類'], ['title', '名前'], ['start', '開始・出発'], ['end', '終了・到着'], ['from', '出発地'], ['to', '到着地'],
  ['platform', '番線'], ['seat', '座席'], ['number', '便名'], ['confirmation', '予約番号'], ['cost', '料金'], ['address', '住所'],
];
const norm = (v) => String(v ?? '').normalize('NFKC').toLowerCase().replace(/[\s　・,，.。、()（）「」【】\-ー〜~→]/g, '').replace(/駅$/, '');
const bigrams = (s) => { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); if (s.length === 1) out.add(s); return out; };
export function textSim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const A = bigrams(a), B = bigrams(b);
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size || 1);
}
const cls = (t) => (TRANSPORT.has(t) ? 'move' : t === 'hotel' ? 'hotel' : 'spot');

// 2つの予定がどれくらい「同じ予定」らしいか（0〜1）
export function matchScore(a, b) {
  const sa = parseLocal(a.start), sb = parseLocal(b.start);
  let time = 0.5;
  if (sa && sb) {
    const d = Math.abs(sa - sb) / 60000;
    if (d > 120) return 0;
    time = d <= 1 ? 1 : Math.max(0, 1 - d / 120);
  } else if (sa || sb) time = 0.3;
  const title = textSim(a.title, b.title);
  const place = Math.max(textSim(a.from, b.from) * 0.5 + textSim(a.to, b.to) * 0.5, textSim(a.address, b.address), textSim(a.title, b.to), textSim(a.to, b.title));
  const type = a.type === b.type ? 1 : cls(a.type) === cls(b.type) ? 0.6 : 0;
  if (!type && title < 0.8) return 0;
  const sc = 0.4 * time + 0.3 * title + 0.2 * place + 0.1 * type;
  // 時刻がほぼ同じか、名前がよく似ている時だけ同じ予定とみなす
  return time >= 0.6 || title >= 0.7 ? sc : 0;
}
export const SAME = 0.55;

const same = (k, x, y) => (k === 'start' || k === 'end' ? String(x).slice(0, 16) === String(y).slice(0, 16) : k === 'type' ? x === y : norm(x) === norm(y) || textSim(x, y) >= 0.92);
// 食い違っている項目（両方に値があって違うもの）
export function diffs(a, b) {
  return FIELDS.filter(([k]) => a[k] && b[k] && !same(k, a[k], b[k])).map(([k, label]) => ({ k, label }));
}
// 空いている項目をもう一方で埋める
export function fill(base, other) {
  const out = { ...base };
  for (const [k] of FIELDS) if (!out[k] && other[k]) out[k] = other[k];
  for (const k of ['phone', 'operator', 'notes']) if (!out[k] && other[k]) out[k] = other[k];
  out.reserved = !!(base.reserved || other.reserved);
  out.imgs = [...new Set([...(base.imgs || []), ...(other.imgs || [])])];
  return out;
}

// readings: [{ src, label, items }]（先にあるものほど優先）
// 戻り値: 予定の一覧。複数の読み取りで見つかった予定には _vers（選べる候補）と _conf（食い違い）が付く
export function mergeReadings(readings) {
  const list = readings.filter((r) => r.items?.length);
  if (!list.length) return [];
  let out = list[0].items.map((it) => ({ ...it, _srcs: [list[0].src], _vers: [{ src: list[0].src, label: list[0].label, data: strip(it) }] }));
  for (const r of list.slice(1)) {
    // いちばん似ている組から順に結びつける
    const pairs = [];
    r.items.forEach((b, j) => out.forEach((a, i) => { const s = matchScore(a._vers[0].data, b); if (s >= SAME) pairs.push([s, i, j]); }));
    pairs.sort((x, y) => y[0] - x[0]);
    const usedA = new Set(), usedB = new Set();
    for (const [, i, j] of pairs) {
      if (usedA.has(i) || usedB.has(j)) continue;
      usedA.add(i); usedB.add(j);
      const a = out[i];
      a._srcs.push(r.src);
      a._vers.push({ src: r.src, label: r.label, data: strip(r.items[j]) });
    }
    r.items.forEach((b, j) => { if (!usedB.has(j)) out.push({ ...b, _srcs: [r.src], _vers: [{ src: r.src, label: r.label, data: strip(b) }] }); });
  }
  for (const it of out) {
    if (it._vers.length > 1) {
      it._conf = diffs(it._vers[0].data, it._vers[1].data);
      it._pick = 0;
      Object.assign(it, fill(it._vers[0].data, it._vers[1].data));
    }
    // 優先度の低い読み取りでしか見つからなかった予定は、初めはチェックを外しておく
    it._weak = list.length > 1 && it._vers.length === 1 && it._srcs[0] !== list[0].src;
  }
  return out;
}
const strip = (it) => { const r = {}; for (const [k, v] of Object.entries(it)) if (!k.startsWith('_') && k !== 'id') r[k] = v; r._alt = it._alt; r._group = it._group; return r; };

// 候補を選び直す（もう一方で空欄を埋める）
export function pickVersion(it, k) {
  const v = it._vers[k], o = it._vers[k ? 0 : 1];
  Object.assign(it, fill(v.data, o?.data || {}));
  it._pick = k;
}

// 旅程にすでにある予定のうち、いちばん似ているもの
export function findExisting(trip, it) {
  let best = null, sc = 0;
  for (const x of trip?.items || []) { const s = matchScore(x, it); if (s > sc) { sc = s; best = x; } }
  return sc >= SAME + 0.1 ? best : null;
}
// 上書き：新しい値で置き換え（新しい方が空の項目は今の値を残す）。予備ルート・画像・通知は残す
export function overwrite(old, it) {
  for (const [k] of FIELDS) if (it[k]) old[k] = it[k];
  for (const k of ['phone', 'operator', 'notes']) if (it[k]) old[k] = it[k];
  old.reserved = !!(old.reserved || it.reserved);
  old.imgs = [...new Set([...(old.imgs || []), ...(it.imgs || [])])];
  return old;
}
