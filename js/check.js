// 旅程チェック：場所と時間の流れから、抜けや違和感を見つける
//  ・移動が抜けている（前の予定の場所と次の予定の場所が離れているのに、移動が無い）
//  ・宿が決まっていない夜がある
//  ・チェックインが、その宿の街に着くより前になっている
//  ・時間が重なっている／移動時間が短すぎる（読み間違いかも）
//  ・帰りの移動が無い
// 見つけたものには、ワンタップで直す方法（fix）を付ける
import { uid, TRANSPORT, parseLocal, toLocalISO, dayKey, hm, mdw } from './util.js';
import { events } from './trip.js';
import { locate, locateItem, km, estMinutes, suggestType, startPlace, endPlace, kmText, minText } from './geo.js';

const FAR = 2.5; // km：これより離れていたら「移動が要る」
const isEst = (it) => /推定|目安|仮/.test(it.notes || '');
const round5 = (d) => { const x = new Date(d); x.setMinutes(Math.ceil(x.getMinutes() / 5) * 5, 0, 0); return x; };
const evKey = (e) => `${e.it.id}:${e.kind}`;
const addMin = (d, m) => new Date(d.getTime() + m * 60000);

// その予定の「いる場所」（移動なら終わり／始まり）
function placeOf(e, which) {
  const it = e.it;
  if (TRANSPORT.has(it.type)) return { name: which === 'end' ? it.to : it.from, loc: locate(which === 'end' ? it.to : it.from) };
  return { name: it.address || it.title, loc: locateItem(it) };
}

export function checkTrip(trip) {
  const ignore = new Set(trip?.ignore || []);
  const issues = [], slots = new Map();
  if (!trip?.items?.length) return { issues, slots };
  const evs = events(trip).filter((e) => e.at);
  const add = (x) => { if (!ignore.has(x.key)) issues.push(x); };

  // --- 1. チェックインが到着より前 ---
  for (const h of trip.items.filter((i) => i.type === 'hotel')) {
    const s = parseLocal(h.start);
    if (!s) continue;
    const hl = locateItem(h);
    const sameDay = trip.items.filter((i) => TRANSPORT.has(i.type) && i.start && dayKey(parseLocal(i.start)) === dayKey(s));
    // チェックイン後に出発する移動のうち、宿の近くに着くもの（宿の場所が分からない時は、その日の最後の移動）
    const later = sameDay.filter((t) => parseLocal(t.start) >= s);
    if (!later.length) continue;
    let arrive = later.filter((t) => { const l = locate(t.to); return hl && l && km(hl, l) < 25; });
    if (!arrive.length && !hl) arrive = later;
    if (!arrive.length && hl) {
      // 宿の街から出ていく移動がチェックインより後にある＝順番がおかしい
      const leaves = later.filter((t) => { const l = locate(t.from); return l && km(hl, l) > 40; });
      if (!leaves.length) continue;
      arrive = sameDay.filter((t) => parseLocal(t.start) >= s);
    }
    const last = arrive.map((t) => parseLocal(t.end) || parseLocal(t.start)).sort((a, b) => b - a)[0];
    if (!last || last <= s) continue;
    const to = round5(addMin(last, 30));
    add({
      key: `in:${h.id}`, level: 'warn', icon: 'bed', ev: `${h.id}:in`,
      title: `チェックインが到着より前になっています`,
      detail: `${h.title || '宿'}のチェックインが ${hm(s)} ですが、その日の到着は ${hm(last)} です。${isEst(h) ? '（チェックインの時刻は推定でした）' : ''}`,
      auto: isEst(h),
      fix: { label: `${hm(to)} にする`, run: () => { h.start = toLocalISO(to); h.notes = (h.notes || '').replace(/チェックイン(・アウト)?の時刻は(推定|目安)\n?/g, '').replace(/時刻は推定\n?/g, '').trim(); } },
    });
  }

  // --- 1b. チェックアウトが、その街を出る移動より後 ---
  for (const h of trip.items.filter((i) => i.type === 'hotel')) {
    const e = parseLocal(h.end);
    if (!e) continue;
    const hl = locateItem(h);
    const leaving = trip.items.filter((t) => TRANSPORT.has(t.type) && t.start && dayKey(parseLocal(t.start)) === dayKey(e) && parseLocal(t.start) < e)
      .filter((t) => { if (!hl) return false; const l = locate(t.from); return l && km(hl, l) < 25; })
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!leaving.length) continue;
    const dep = parseLocal(leaving[0].start);
    const to = new Date(dep.getTime() - 30 * 60000); to.setMinutes(Math.floor(to.getMinutes() / 5) * 5, 0, 0);
    add({
      key: `out:${h.id}`, level: 'warn', icon: 'bed', ev: `${h.id}:out`,
      title: 'チェックアウトが出発より後になっています',
      detail: `${h.title || '宿'}のチェックアウトが ${hm(e)} ですが、${leaving[0].from}を ${hm(dep)} に出発します。${isEst(h) ? '（チェックアウトの時刻は推定でした）' : ''}`,
      auto: isEst(h),
      fix: { label: `${hm(to)} にする`, run: () => { h.end = toLocalISO(to); } },
    });
  }
  // 宿の時刻がおかしい時は、その前後の「移動が抜けている」は言わない（直すと消えるため）
  const badHotel = new Set(issues.filter((x) => /^(in|out):/.test(x.key)).map((x) => x.ev));

  // --- 2. 移動が抜けている ---
  for (let i = 0; i < evs.length - 1; i++) {
    const p = evs[i], n = evs[i + 1];
    if (p.it.id === n.it.id) continue;
    if (p.kind === 'in' && n.kind === 'out' && p.it.id === n.it.id) continue;
    if (badHotel.has(evKey(p)) || badHotel.has(evKey(n))) continue;
    const a = placeOf(p, 'end'), b = placeOf(n, 'start');
    if (!a.loc || !b.loc) continue;
    const d = km(a.loc, b.loc);
    if (d == null || d < FAR) continue;
    const type = suggestType(d, a.loc, b.loc);
    const est = estMinutes(d, type);
    const room = Math.round((n.at - (p.end || p.at)) / 60000);
    const key = `move:${p.it.id}:${n.it.id}`;
    if (ignore.has(key)) continue;
    const slot = { key, kind: 'move', after: evKey(p), from: a.name, to: b.name, dist: d, est, type, start: p.end || p.at, end: n.at, room };
    slots.set(evKey(p), [...(slots.get(evKey(p)) || []), slot]);
    add({
      key, level: room < est ? 'warn' : 'info', icon: 'route', ev: evKey(p),
      title: `移動が抜けているかもしれません`,
      detail: `${a.name} → ${b.name}（約${kmText(d)}・目安${minText(est)}）${room < est ? `。空き時間は ${minText(Math.max(0, room))} しかありません` : ''}`,
      slot,
    });
  }

  // --- 3. 宿が決まっていない夜 ---
  const days = [...new Set(evs.map((e) => dayKey(e.at)))].sort();
  const home = (() => { const f = evs.find((e) => TRANSPORT.has(e.it.type)); return f ? locate(f.it.from) : null; })();
  for (let i = 0; i < days.length - 1; i++) {
    const day = days[i], next = days[i + 1];
    const dS = parseLocal(day + 'T00:00'), nS = parseLocal(next + 'T00:00');
    if ((nS - dS) / 864e5 > 1.5) continue; // 日が飛んでいる時は数えない
    const covered = trip.items.some((it) => {
      const s = parseLocal(it.start), e = parseLocal(it.end);
      if (!s || !e) return false;
      if (it.type === 'hotel') return dayKey(s) <= day && dayKey(e) > day;
      return dayKey(s) === day && dayKey(e) > day; // 夜行バス・夜行列車・フェリー
    });
    if (covered) continue;
    const lastE = [...evs].reverse().find((e) => dayKey(e.at) === day);
    const endAt = placeOf(lastE, 'end');
    if (home && endAt.loc && km(home, endAt.loc) < 30) continue; // 家に帰っている
    const key = `night:${day}`;
    if (ignore.has(key)) continue;
    const arr = lastE.end || lastE.at;
    const slot = { key, kind: 'hotel', after: evKey(lastE), place: endAt.name || '', start: round5(addMin(arr, 30)), end: parseLocal(next + 'T10:00'), day };
    slots.set(evKey(lastE), [...(slots.get(evKey(lastE)) || []), slot]);
    add({ key, level: 'warn', icon: 'bed', ev: evKey(lastE), title: `${mdw(dS)}の夜の宿が決まっていません`, detail: endAt.name ? `最後にいる場所：${endAt.name}` : '宿か、夜行の移動を追加してください', slot });
  }

  // --- 4. 時間の重なり ---
  const moves = evs.filter((e) => e.kind === '');
  for (let i = 0; i < moves.length - 1; i++) {
    const p = moves[i], n = moves[i + 1];
    const over = Math.round(((p.end || p.at) - n.at) / 60000);
    if (over <= 1 || dayKey(p.at) !== dayKey(n.at)) continue;
    if (!TRANSPORT.has(p.it.type) && !TRANSPORT.has(n.it.type)) continue; // 観光どうしの重なりは、よくあるので言わない
    add({
      key: `over:${p.it.id}:${n.it.id}`, level: 'warn', icon: 'clock', ev: evKey(n),
      title: '時間が重なっています',
      detail: `${p.it.title || '予定'}（〜${hm(p.end)}）と ${n.it.title || '予定'}（${hm(n.at)}〜）が${over}分重なっています`,
      fix: { label: `後ろを${over}分ずらす`, run: () => shiftAfter(trip, n.it, over, true) },
    });
  }

  // --- 5. 移動時間が短すぎる（読み間違いかも） ---
  for (const e of moves) {
    const it = e.it;
    if (!TRANSPORT.has(it.type) || !it.end) continue;
    const a = locate(it.from), b = locate(it.to);
    const d = km(a, b);
    if (d == null || d < 30) continue;
    const dur = (e.end - e.at) / 60000;
    const est = estMinutes(d, it.type === 'flight' ? 'flight' : it.type === 'shinkansen' ? 'shinkansen' : 'shinkansen');
    if (dur > 0 && dur < est * 0.4) add({ key: `fast:${it.id}`, level: 'info', icon: 'warn', ev: evKey(e), title: '移動時間が短すぎるかもしれません', detail: `${it.from} → ${it.to}（約${kmText(d)}）が ${minText(Math.round(dur))} になっています。時刻の読み間違いがないか確かめてください。` });
    if (dur < 0) add({ key: `neg:${it.id}`, level: 'warn', icon: 'warn', ev: evKey(e), title: '到着が出発より前です', detail: `${it.title || it.from + '→' + it.to} の到着時刻を確かめてください。` });
  }

  // --- 6. 帰りの移動が無い ---
  if (days.length >= 2 && home) {
    const last = evs[evs.length - 1];
    const lp = placeOf(last, 'end');
    const lastDayMoves = evs.filter((e) => dayKey(e.at) === days[days.length - 1] && TRANSPORT.has(e.it.type));
    const backHome = lastDayMoves.some((e) => { const l = locate(e.it.to); return l && km(l, home) < 30; });
    if (lp.loc && km(lp.loc, home) > 50 && !backHome) {
      const out = outboundChain(trip);
      add({
        key: 'return', level: 'info', icon: 'route', ev: evKey(last),
        title: '帰りの移動がまだありません',
        detail: `最後は「${lp.name}」にいます。${out.length ? `行き（${out[0].from} → ${out[out.length - 1].to}）を逆にして、帰りをつくれます。` : ''}`,
        fix: out.length ? { label: '行きを逆にして帰りをつくる', run: () => makeReturn(trip, out, last.end || last.at) } : null,
      });
    }
  }

  // --- 7. 旅の日程の外にある予定 ---
  if (trip.start && trip.end) {
    const ts = trip.start, te = trip.end;
    for (const e of evs) {
      const d = dayKey(e.at);
      if (d < ts || d > te) { add({ key: `range:${e.it.id}`, level: 'info', icon: 'clock', ev: evKey(e), title: '旅の日程の外にある予定があります', detail: `${e.it.title || '予定'}（${mdw(e.at)}）。旅の日程は ${ts.slice(5).replace('-', '/')}〜${te.slice(5).replace('-', '/')} です。` }); break; }
    }
  }

  // --- 8. 日時が未定 ---
  const noTime = trip.items.filter((i) => !i.start).length;
  if (noTime) add({ key: 'notime', level: 'info', icon: 'clock', title: `日時が決まっていない予定が${noTime}件あります`, detail: 'タップして日時を入れると、時間順に並びます。' });

  const order = { warn: 0, info: 1 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { issues, slots };
}

// 読み取った直後に、推定の時刻で明らかにおかしいものだけ自動で直す
export function autoFix(trip) {
  let n = 0;
  for (let k = 0; k < 3; k++) {
    const fx = checkTrip(trip).issues.filter((i) => i.auto && i.fix);
    if (!fx.length) break;
    for (const f of fx) { f.fix.run(); n++; }
  }
  return n;
}

// この予定と、同じ日のそれより後の予定を min 分ずらす
export function shiftAfter(trip, item, min, sameDayOnly = true) {
  const s0 = parseLocal(item.start);
  if (!s0) return 0;
  let n = 0;
  for (const it of trip.items) {
    const s = parseLocal(it.start);
    if (!s || s < s0 || (sameDayOnly && dayKey(s) !== dayKey(s0))) continue;
    it.start = toLocalISO(addMin(s, min));
    if (it.end) it.end = toLocalISO(addMin(parseLocal(it.end), min));
    n++;
  }
  return n;
}

// 行き：旅のはじめの、家から続く移動のつながり
export function outboundChain(trip) {
  const ms = trip.items.filter((i) => TRANSPORT.has(i.type) && i.start).sort((a, b) => a.start.localeCompare(b.start));
  if (!ms.length) return [];
  const day = dayKey(parseLocal(ms[0].start));
  const chain = [ms[0]];
  for (const m of ms.slice(1)) {
    if (dayKey(parseLocal(m.start)) !== day) break;
    const prev = chain[chain.length - 1];
    const gap = (parseLocal(m.start) - (parseLocal(prev.end) || parseLocal(prev.start))) / 60000;
    if (gap > 180) break;
    chain.push(m);
  }
  return chain;
}

// 1つの移動を逆向きにした複製（時刻は after から、所要時間はそのまま）
export function reverseLeg(it, at) {
  const s = parseLocal(it.start), e = parseLocal(it.end);
  const dur = s && e ? (e - s) / 60000 : 60;
  const st = at || s;
  return {
    id: uid(), type: it.type, title: it.type === 'walk' || it.type === 'taxi' ? it.title : '', operator: it.operator || '', number: '',
    from: it.to || '', to: it.from || '', start: st ? toLocalISO(st) : '', end: st ? toLocalISO(addMin(st, dur)) : '',
    platform: '', seat: '', confirmation: '', cost: it.cost || '', address: '', phone: '',
    notes: '時刻は仮（行きから作成）', reserved: false, imgs: [], remind: 30,
  };
}

// 行きのつながりを逆にして、after の後に並べる
export function makeReturn(trip, chain, after) {
  let at = round5(addMin(after, 60));
  const legs = [];
  for (const it of [...chain].reverse()) {
    const r = reverseLeg(it, at);
    legs.push(r);
    at = round5(addMin(parseLocal(r.end), 15));
  }
  trip.items.push(...legs);
  return legs;
}
