// 旅程表（時刻と内容が並ぶ文書）を読む。
//  ・文章（貼り付け・写真の文字のコピー）でも、PDFや写真の「文字の位置」から組み立て直した行でも、同じ読み方をする
//  ・表の1行＝「時刻（8:15 / 13:15–14:00 / 10:15 → 10:40 / 夜）」「内容」「補足の小さい字」「分類（移動・宿・食事・温泉・観光）」
//  ・Day見出し・日付の行で日付が切り替わる。ページの下の「2026.11.13〜11.15」のような範囲の行は日付にしない
//  ・メモ欄は近くの予定のメモに、「〜が運転しない場合」「予備」「代わりに」の欄は予備ルートに、
//    「帰り方（2パターン）」は1つ目を本命・2つ目以降を予備にする。チェックリストは予定にしない
// 画面に依存しない（node でテストできる）
import { findDate, findTimes } from './parse.js';

const pad = (n) => String(n).padStart(2, '0');
const iso = (d, t) => (d && t ? `${d.y}-${pad(d.mo)}-${pad(d.d)}T${pad(t.h % 24)}:${pad(t.mi)}` : '');
const addDays = (d, n) => { const x = new Date(d.y, d.mo - 1, d.d + n); return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate() }; };
const dk = (d) => `${d.y}-${pad(d.mo)}-${pad(d.d)}`;
const toDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };
const toISO = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
const plus = (s, min) => { const d = toDate(s); return d ? toISO(new Date(d.getTime() + min * 60000)) : ''; };
const base = () => ({ title: '', from: '', to: '', start: '', end: '', operator: '', number: '', platform: '', seat: '', confirmation: '', cost: '', address: '', notes: '', reserved: false });
const TRANSPORT = new Set(['shinkansen', 'train', 'subway', 'bus', 'flight', 'ferry', 'taxi', 'walk', 'ropeway']);
const AIRLINES = { NH: 'ANA', JL: 'JAL', BC: 'スカイマーク', MM: 'Peach', GK: 'ジェットスター', '7G': 'スターフライヤー', HD: 'AIRDO', '6J': 'ソラシドエア', IJ: 'スプリング', FW: 'IBEX', NU: 'JTA', JH: 'FDA', OC: 'ORC' };

// ===== 時刻の書き方 =====
const T = '(\\d{1,2})\\s*[:：時]\\s*(\\d{2})\\s*分?\\s*(頃|ごろ|前後)?';
const DASH = '(?:-|~|→|->|⇒|から)';
// 時刻だけの行（範囲・続き・「／」で2つも）
const TIME_ONLY = new RegExp(`^${T}(?:\\s*(${DASH})\\s*(?:${T})?)?\\s*$`);
const TIME_ALT = new RegExp(`^${T}\\s*[/／、,]\\s*${T}\\s*$`);
// 時刻で始まる行
const TIME_LEAD = new RegExp(`^${T}(?:\\s*${DASH}\\s*${T})?\\s+(.+)$`);
const WORD_TIME = { 早朝: [6, 0], 朝: [8, 0], 朝食: [7, 30], 午前: [10, 0], 午前中: [10, 0], 昼: [12, 0], 昼食: [12, 0], ランチ: [12, 0], 午後: [14, 0], 夕方: [17, 0], 夕食: [18, 30], ディナー: [18, 30], 夜: [20, 0], 夜間: [20, 0], 深夜: [23, 0] };
const WORD_ONLY = new RegExp(`^(${Object.keys(WORD_TIME).join('|')})$`);
const WORD_LEAD = new RegExp(`^(${Object.keys(WORD_TIME).join('|')})[\\s:：]+(.+)$`);
const TAGS = { 移動: 'move', 宿: 'stay', 宿泊: 'stay', 食事: 'meal', 温泉: 'onsen', 観光: 'sight', 見学: 'sight', 体験: 'sight', 買物: 'shop', 買い物: 'shop', 休憩: 'rest', 予定: 'other' };
const TAG_ONLY = new RegExp(`^[\\[［【(（]?(${Object.keys(TAGS).join('|')})[\\]］】)）]?$`);
const TAG_TAIL = new RegExp(`\\s+[\\[［【(（]?(${Object.keys(TAGS).join('|')})[\\]］】)）]?$`);
// 欄の見出し
const SEC_SKIP = /チェックリスト|持ち物リスト|やること|^期限$/;
const SEC_ALT = /運転しない|運休|遅れた|遅延|代わり|予備|別ルート|別案|代替|雨の(日|場合)|パターン|帰り方|行き方/;
const SEC_MEMO = /^(メモ|注意|備考|料金|費用|予算|参考|ポイント|補足|お知らせ|持ち物)/;
const DAY_HEAD = /^(day|ｄａｙ)\s*\d+|^\d+\s*日目/i;

const tm = (h, mi) => ({ h: +h, mi: +mi });

// 時刻の行を読む。{t1, t2, open, approx, alt} / null
function readTime(l) {
  let m;
  if ((m = TIME_ALT.exec(l))) return { t1: tm(m[1], m[2]), t2: null, alt: `${m[1]}:${m[2]}／${m[4]}:${m[5]}`, approx: !!(m[3] || m[6]) };
  if ((m = TIME_ONLY.exec(l))) return { t1: tm(m[1], m[2]), t2: m[5] ? tm(m[5], m[6]) : null, open: !!m[4] && !m[5], approx: !!(m[3] || m[7]) };
  if ((m = WORD_ONLY.exec(l))) { const w = WORD_TIME[m[1]]; return { t1: tm(w[0], w[1]), word: m[1], approx: true }; }
  return null;
}

// 行の種類を見分けやすく整える（全角→半角・ダッシュをそろえる）
function prep(line) {
  return String(line || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ：／．（）＋＃＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[〜～∼]/g, '~')
    .replace(/(\d)\s*[–—−－‐ー―]\s*(?=\d)/g, '$1-')
    .replace(/[–—]/g, '-')
    .replace(/　/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

// 行の中ほどに「11:00–12:00 水明館」のように次の予定がくっついていたら分ける（写真の文字コピーで起きる）
function splitGlued(l) {
  const m = new RegExp(`^(.*?\\S)\\s+(${T}\\s*${DASH}\\s*${T}\\s+\\S.*)$`).exec(l);
  if (!m || /[発着]\s*$/.test(m[1]) || /[~\-→]\s*$/.test(m[1]) || findTimes(m[1]).length) return [l];
  // 「別便 9:15発の場合」のような文の中の時刻は分けない
  if (/^[・※]/.test(l) || m[1].length < 6 || /発の|着の|まで|から$|場合/.test(m[2].slice(0, 12))) return [l];
  return [m[1], m[2]];
}

const isFooter = (l, today) => {
  if (/^\d+\s*\/\s*\d+$/.test(l) || /^(page|p\.)\s*\d+/i.test(l)) return true;
  // 日付が2つ以上（範囲）並ぶ行は、表紙やページの上下の飾り
  const ds = l.match(/(20\d{2}[./年-]\s*)?\d{1,2}\s*[./月]\s*\d{1,2}\s*日?/g) || [];
  return ds.length >= 2 && /[~〜\-–]/.test(l) && !findTimes(l).length;
};

// ===== 1) 行 → エントリー（時刻＋内容＋補足＋分類）と欄 =====
export function readSchedule(text, today = new Date()) {
  const raw = String(text || '').split('\n').map(prep);
  const lines = [];
  for (const l of raw) for (const p of splitGlued(l)) lines.push(p);
  const yearM = /(20\d{2})\s*[年/.\-]/.exec(lines.join('\n'));
  const docYear = yearM ? +yearM[1] : null;
  const dateOf = (l) => { const d = findDate(l, today); if (d && docYear && !/20\d{2}/.test(l)) d.y = docYear; return d; };
  let title = '';
  for (const l of lines) {
    if (!l) continue;
    if (!dateOf(l) && !readTime(l) && !findTimes(l).length && l.length <= 40 && !DAY_HEAD.test(l)) { title = l.replace(/\s*旅程表?$/, '').trim() || l; }
    break;
  }
  const out = { title, entries: [], sections: [], reservedNote: '', docYear };
  let ctx = null, pending = null, cur = null, sec = null;
  const startEntry = (e) => { cur = { date: ctx, title: '', subs: [], tag: '', notes: [], ...e }; out.entries.push(cur); sec = null; return cur; };
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (!l) continue;
    if (isFooter(l, today)) {
      const head = l.replace(/(20\d{2}[./年-]\s*)?\d{1,2}\s*[./月].*$/, '').replace(/\s*旅程表?\s*$/, '').trim();
      if (!out.title && head && !/^\d/.test(head)) out.title = head;
      continue;
    }
    // Day見出し・日付の行
    const dt = dateOf(l);
    const isHead = DAY_HEAD.test(l);
    if (isHead || (dt && !readTime(l) && !TIME_LEAD.test(l) && l.length <= 44 && !/^[・※]/.test(l) && !(sec && sec.kind !== 'skip' && findTimes(l).length))) {
      if (sec?.kind === 'skip' && !isHead && !/^(day|\d+日目)/i.test(l) && !(dt && l.length <= 14 && /[月日/]/.test(l) && /[(（][月火水木金土日][)）]/.test(l) === false)) {
        // チェックリストの中の日付（「9/28(月) 10:00〜」など）は予定にしない
        if (/予約済/.test(l)) out.reservedNote += l + (lines[i + 1] || '');
        continue;
      }
      if (dt) ctx = dt;
      pending = null; cur = null; sec = null;
      continue;
    }
    // 欄の見出し
    if (!readTime(l) && !TIME_LEAD.test(l) && l.length <= 32 && !/^[・※]/.test(l)) {
      const kind = SEC_SKIP.test(l) ? 'skip' : SEC_ALT.test(l) ? 'alt' : SEC_MEMO.test(l) && !pending ? 'memo' : null;
      if (kind) { sec = { kind, head: l, date: ctx, lines: [] }; out.sections.push(sec); pending = null; cur = null; continue; }
    }
    if (sec) {
      if (sec.kind === 'skip') { if (/予約済/.test(l)) out.reservedNote += l + (lines[i + 1] || ''); continue; }
      sec.lines.push(l.replace(/^[・※•]\s*/, ''));
      continue;
    }
    // 分類だけの行（「移動」「宿」）→ 直前の予定へ
    let m;
    if ((m = TAG_ONLY.exec(l))) {
      const tgt = cur && !cur.tag ? cur : null;
      if (tgt) tgt.tag = m[1];
      continue;
    }
    // 時刻だけの行
    const rt0 = readTime(l);
    // 時刻の次の「昼食」「朝食」は、時刻ではなく内容
    const rt = rt0 && rt0.word && (pending || (cur && !cur.title)) ? null : rt0;
    if (rt) {
      // 「10:15 →」の次に「10:40」が来たら、範囲にまとめる
      if (pending && pending.open && !pending.t2 && !rt.word) { pending.t2 = rt.t1; pending.open = false; continue; }
      if (cur && cur.open && !cur.t2 && !rt.word && !cur.title) { cur.t2 = rt.t1; cur.open = false; continue; }
      // 「10:15 →」のあとに内容、そのあとに「10:40」の順でも
      if (cur && cur.open && !cur.t2 && !rt.word && cur.title && i - cur.line <= 3) { cur.t2 = rt.t1; cur.open = false; continue; }
      pending = { ...rt, line: i };
      cur = null;
      continue;
    }
    if (pending) {
      const e = startEntry({ ...pending, line: i });
      pending = null;
      e.title = l.replace(TAG_TAIL, (x, g) => { e.tag = g; return ''; }).trim();
      continue;
    }
    if ((m = TIME_LEAD.exec(l))) {
      const e = startEntry({ t1: tm(m[1], m[2]), approx: !!(m[3] || m[6]), t2: m[4] ? tm(m[4], m[5]) : null, line: i });
      e.title = m[7].replace(TAG_TAIL, (x, g) => { e.tag = g; return ''; }).trim();
      continue;
    }
    if ((m = WORD_LEAD.exec(l))) {
      const w = WORD_TIME[m[1]];
      const e = startEntry({ t1: tm(w[0], w[1]), word: m[1], approx: true, line: i });
      e.title = m[2].replace(TAG_TAIL, (x, g) => { e.tag = g; return ''; }).trim();
      if (/食/.test(m[1]) && !/食/.test(e.title)) e.title = `${m[1]} ${e.title}`;
      continue;
    }
    // 内容の行の続き（補足の小さい字・※の注意）
    if (cur) {
      if (!cur.title) { cur.title = l.replace(TAG_TAIL, (x, g) => { cur.tag = g; return ''; }).trim(); continue; }
      if (/^[※]/.test(l)) cur.notes.push(l.replace(/^※\s*/, ''));
      else cur.subs.push(l.replace(/^[・•]\s*/, ''));
    }
  }
  return out;
}

// ===== 2) エントリー → 予定 =====
const VEHICLE = /(?:特急|快速|急行|普通|新快速|寝台)?[^\s→()（）、]{0,10}?\d+号|新幹線\S*|[^\s→()（）、]*バス|[^\s→()（）、]*ロープウェ[イー]|ケーブルカー|ゴンドラ|フェリー|高速船|[^\s→()（）、]*線(?:\s*(?:普通|快速|各駅停車))?|タクシー|レンタカー|飛行機|徒歩/;
const SHINKANSEN = /新幹線|のぞみ|ひかり|こだま|はやぶさ|はやて|やまびこ|なすの|つばさ|こまち|とき|たにがわ|かがやき|はくたか|つるぎ|あさま|みずほ|さくら|つばめ/;
// 「バスで〜」「特急で〜」のように、最初に書かれた乗り物を優先する
function leadType(s) {
  const m = /^(.{0,8}?)(バス|電車|特急|新幹線|タクシー|フェリー|ロープウェイ|ケーブルカー|徒歩|車)で/.exec(String(s || ''));
  return m ? typeOf(m[2]) || (m[2] === '車' ? 'taxi' : '') : '';
}
function typeOf(s) {
  if (/\b([A-Z0-9]{2})\s?\d{2,4}\b.*便|\d+\s*便|Peach|ピーチ|ANA|JAL|スカイマーク|ジェットスター|AIRDO|ソラシド|スターフライヤー|飛行機/.test(s)) return 'flight';
  if (SHINKANSEN.test(s)) return 'shinkansen';
  if (/ロープウェ[イー]|ケーブルカー|ゴンドラ/.test(s)) return 'ropeway';
  if (/バス|\d+\s*番(?!線)|BT\b|バスターミナル|バスセンター|バス停/.test(s)) return 'bus';
  if (/フェリー|高速船|航路/.test(s)) return 'ferry';
  if (/地下鉄|メトロ|都営/.test(s)) return 'subway';
  if (/タクシー|レンタカー|車で/.test(s)) return 'taxi';
  if (/特急|快速|急行|普通|各駅|線|号|列車|電車|JR|鉄道/.test(s)) return 'train';
  if (/徒歩|歩いて|歩く/.test(s)) return 'walk';
  return '';
}
const cleanPlace = (s) => String(s || '')
  .replace(/[(（][^)）]*[)）]/g, ' ')
  .replace(/^(?:下り|上り|バスで|電車で|徒歩で|タクシーで)\s*/, '')
  .replace(/\s*(発|着|到着|出発|まで|から|方面|行き?)\s*$/, '')
  .replace(/へ(移動|向かう|戻る)?$/, '')
  .replace(/\s+/g, ' ').trim();
const money = (s) => { const m = /(?:大人|往復|片道|料金|入館|入浴|運賃|指定席|自由席|あなた[:：]?\s*(?:指定席)?\s*約?)?\s*[¥￥]?\s*([\d,]{3,})\s*円/.exec(s); return m ? `¥${m[1]}` : ''; };
const paren = (s) => ((/[(（]([^)）]*)[)）]/.exec(s) || [])[1] || '');
const noParen = (s) => String(s || '').replace(/[(（][^)）]*[)）]/g, '').trim();
const near = (a, b) => !!(a && b && (a.includes(b) || b.includes(a)));

// 「A → B」「A発 → B着」「A 発（〇〇号）」などから、出発・到着・乗り物を取り出す
function route(text) {
  const t = String(text || '');
  if (!/→|->|⇒/.test(t)) return null;
  const parts = t.split(/\s*(?:→|->|⇒)\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let first = parts[0], vehicle = '';
  const v = VEHICLE.exec(first);
  if (v && v[0].length >= 2) { vehicle = v[0]; first = first.replace(v[0], ' '); }
  const platform = (/(\d+\s*番(?:線|のりば|乗り場)?)/.exec(paren(parts[0])) || [])[1] || '';
  // 「→ 駅前ターミナル 8:32着／8:42着。宿へ戻る」：到着の時刻が同じ行にある
  let last = parts[parts.length - 1], arr = null, rest = '';
  const am = /^(.*?)\s*(\d{1,2}):(\d{2})\s*着(.*)$/.exec(last);
  if (am) { last = am[1]; arr = tm(am[2], am[3]); rest = am[4].replace(/^[／/\d:着。、\s]+/, '').trim(); }
  return { from: cleanPlace(first), to: cleanPlace(noParen(last)), via: parts.slice(1, -1).map(cleanPlace), vehicle: vehicle.trim(), platform, arr, rest };
}

export function buildSchedule(doc, today = new Date()) {
  const items = [];
  const E = doc.entries.filter((e) => e.date && e.t1 && e.title);
  let lastLeg = null, openHotel = null, place = '';
  const pushLeg = (it) => { items.push(it); lastLeg = it; if (it.to) place = it.to; return it; };
  const endOf = (e, nextE) => {
    if (e.t2) {
      const end = e.t2.h * 60 + e.t2.mi < e.t1.h * 60 + e.t1.mi ? addDays(e.date, 1) : e.date;
      return iso(end, e.t2);
    }
    return '';
  };
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    const tag = TAGS[e.tag] || '';
    const all = [e.title, ...e.subs].join(' ');
    const start = iso(e.date, e.t1);
    const end = endOf(e);
    const notes = [...e.subs, ...e.notes, e.alt && `時刻 ${e.alt}`, e.approx && (e.word ? `時刻は目安（${e.word}）` : '時刻は目安（頃）')].filter(Boolean);
    // --- 宿：チェックイン／到着
    const isCheckout = /チェックアウト/.test(e.title);
    if (isCheckout) {
      const h = openHotel || [...items].reverse().find((x) => x.type === 'hotel');
      if (h) { h.end = start; h._co = true; const rest = e.title.replace(/チェックアウト[・、\s]*/, '').trim(); if (rest) h.notes = [h.notes, `チェックアウト後：${rest}`].filter(Boolean).join('\n'); }
      else items.push({ ...base(), type: 'hotel', title: '宿（チェックアウト）', start: '', end: start, notes: notes.join('\n') });
      openHotel = null;
      continue;
    }
    const checkin = /チェックイン|宿泊[:：]|^宿泊|泊まる/.test(e.title) || (tag === 'stay' && /到着|着$|着\s/.test(all) && !/荷物/.test(e.title));
    if (checkin) {
      // 「下呂駅から徒歩約15分」＋補足「大江戸温泉物語 下呂別館 到着」→ 歩く予定＋宿
      const nameLine = /チェックイン|宿泊|泊まる/.test(e.title) ? e.title : (e.subs.find((s) => /到着|着/.test(s)) || e.title);
      const name = noParen(nameLine).replace(/^.*?(宿泊|泊まる)\s*[:：]?\s*/, '').replace(/\s*(チェックイン|到着|着)\s*$/, '').replace(/^(.*?)\s*チェックイン.*$/, '$1').trim() || '宿';
      let ci = start;
      if (e.t2 && /徒歩|歩|バス|タクシー|移動|から/.test(e.title) && !/チェックイン/.test(e.title)) {
        pushLeg({ ...base(), type: typeOf(e.title) || 'walk', title: noParen(e.title), from: place || (/(.+?)から/.exec(e.title) || [])[1] || '', to: name, start, end });
        ci = end;
      }
      const h = { ...base(), type: 'hotel', title: name, start: ci, end: '', address: '', notes: notes.filter((n) => !n.includes(name)).join('\n'), _date: e.date, _approx: !!e.word };
      items.push(h);
      openHotel = h;
      place = name;
      continue;
    }
    // --- 移動
    const rt = route(e.title) || (tag === 'move' || /で|へ/.test(e.title) ? e.subs.map(route).find(Boolean) : null);
    const dep = /^(.*?)\s*発(?=\s|[(（→]|$)/.exec(e.title), arr = /^(.*?)\s*着(?=\s|[(（→]|$)/.exec(e.title);
    const vehicleWord = typeOf(e.title);
    const isMove = rt || tag === 'move' || (dep && !rt) || (arr && !rt) || (/^(バス|電車|特急|新幹線|徒歩|タクシー)で|へ(移動|戻る)$/.test(e.title));
    if (isMove && !(tag === 'meal' || tag === 'onsen')) {
      if (rt) {
        // 乗り物の名前が無い時は、直前の区間（行きの便）を引き継ぐ
        const back = lastLeg && lastLeg.type !== 'walk' && (near(lastLeg.to, rt.from) || /下り|上り|戻/.test(e.title)) ? lastLeg : null;
        const type = leadType(e.title) || typeOf(`${rt.vehicle} ${e.title.replace(/[^\s→]*(?:バスターミナル|バスセンター|BT)\b/g, '')}`) || typeOf(rt.vehicle + e.title) || (back ? back.type : '') || (tag === 'move' ? 'walk' : 'activity');
        let title = rt.vehicle || noParen(e.title.split(/→|->/)[0]).replace(/^(バスで|電車で)/, '').trim();
        if (!rt.vehicle && /下り|上り|戻/.test(e.title) && lastLeg?.type === type) title = `${lastLeg.title} ${/上り/.test(e.title) ? '上り' : '下り'}`;
        if (!rt.vehicle && !/下り|上り/.test(e.title)) title = back && back.type === type && !typeOf(e.title) ? back.title : /^[^→]*(発)?\s*→/.test(e.title) && !leadType(e.title) ? ({ bus: 'バス', train: '電車', walk: '徒歩', taxi: 'タクシー', ropeway: 'ロープウェイ' }[type] || noParen(e.title)) : noParen(e.title.split(/\s\d{1,2}:\d{2}/)[0]);
        const fl = /\b([A-Z0-9]{2})\s?(\d{2,4})\b/.exec(e.title);
        const end2 = end || (rt.arr ? iso(e.date, rt.arr) : '');
        const it = pushLeg({ ...base(), type: type === 'activity' ? 'walk' : type, title, from: rt.from || place, to: rt.to, start, end: end2, platform: rt.platform, number: type === 'flight' && fl ? `${fl[1]} ${fl[2]}` : '', notes: [rt.via.length ? `経由：${rt.via.join(' → ')}` : '', rt.rest, ...notes].filter(Boolean).join('\n') });
        if (!end2) it._needsEnd = true;
        continue;
      }
      if (dep && !/→/.test(e.title)) {
        // 「A 発（〇〇）」＋次の「B 着」を1つの区間に
        const ride = paren(e.title);
        const nx = E[i + 1];
        const ar = nx && /^(.*?)\s*着(?=\s|[(（→]|$)/.exec(nx.title) && !/発(?=\s|[(（→]|$)/.test(nx.title) ? nx : null;
        const type = typeOf(ride) || typeOf(e.title) || (lastLeg && !ride ? lastLeg.type : '') || 'train';
        const fl = /\b([A-Z0-9]{2})\s?(\d{2,4})\b/.exec(ride);
        let title = ride.split(/[／/]/)[0].trim();
        if (type === 'flight' && fl) title = `${AIRLINES[fl[1]] || (/Peach/i.test(ride) ? 'Peach' : fl[1])} ${fl[1]}${fl[2]}便`;
        if (!title && lastLeg && type === lastLeg.type) title = lastLeg.title;
        let aEnd = end;
        let to = '';
        if (ar) {
          let d2 = ar.date;
          if (dk(d2) === dk(e.date) && ar.t1.h * 60 + ar.t1.mi < e.t1.h * 60 + e.t1.mi) d2 = addDays(d2, 1);
          aEnd = iso(d2, ar.t1);
          to = cleanPlace(/^(.*?)\s*着/.exec(ar.title)[1]);
        }
        const arStay = ar ? (/着[^→]*→\s*(.+)$/.exec(ar.title) || [])[1] || '' : '';
        const arNotes = ar ? [...ar.subs, ...ar.notes, arStay && !/散策|観光|滞在|見学|食|買|休憩|巡|参拝|入浴|温泉|約\s*\d/.test(arStay) ? arStay : '', paren(ar.title.split('→')[0]), ar.approx && '到着時刻は目安'].filter(Boolean) : [];
        pushLeg({ ...base(), type, title: title || (type === 'bus' ? 'バス' : ''), number: fl ? `${fl[1]} ${fl[2]}` : '', operator: fl ? AIRLINES[fl[1]] || '' : '', from: cleanPlace(dep[1]), to, start, end: aEnd, notes: [ride.split(/[／/]/).slice(1).join('／'), ...notes, ...arNotes].filter(Boolean).join('\n') });
        if (ar) {
          i++;
          // 着いた所で過ごす（「→ 約1時間滞在」）
          const stay = (/着[^→]*→\s*(.+)$/.exec(ar.title) || [])[1];
          if (stay && /散策|観光|滞在|見学|食|買|休憩|巡|参拝|入浴|温泉|約\s*\d/.test(stay)) {
            const nd = E.slice(i + 1).find((x) => /発/.test(x.title));
            let en = nd && nd.date ? iso(nd.date, nd.t1) : '';
            const hrs = /約?\s*(\d+(?:\.\d)?)\s*時間/.exec(stay);
            if (!en || toDate(en) - toDate(aEnd) > 6 * 3600e3 || toDate(en) <= toDate(aEnd)) en = plus(aEnd, hrs ? +hrs[1] * 60 : 60);
            items.push({ ...base(), type: 'activity', title: `${to} ${noParen(stay).replace(/^約?\s*\d+(\.\d)?\s*(時間|分)\s*/, '').replace(/^現地で/, '')}`.trim(), address: to, start: aEnd, end: en, notes: stay });
          }
        }
        continue;
      }
      if (arr && !dep) {
        pushLeg({ ...base(), type: lastLeg?.type === 'walk' ? 'walk' : 'walk', title: `${cleanPlace(arr[1])}へ`, from: place, to: cleanPlace(arr[1]), start, end, notes: notes.join('\n') });
        continue;
      }
      // 「バスで平湯へ」「平湯バスターミナルへ」「荷物を受け取り、水明館へ移動」
      const dest = (/([^\s、。]+?)へ(?:移動|向かう|戻る)?$/.exec(noParen(e.title)) || [])[1] || '';
      const type = leadType(e.title) || (/戻/.test(e.title) && lastLeg && lastLeg.type !== 'walk' && typeOf(e.title) ? lastLeg.type : '') || 'walk';
      const it = pushLeg({ ...base(), type, title: noParen(e.title), from: place, to: cleanPlace(dest), start, end, notes: notes.join('\n') });
      if (!end) it._needsEnd = true;
      continue;
    }
    // --- 食事・観光・温泉など
    const type = tag === 'meal' || /食/.test(e.word || '') || /^(朝食|昼食|夕食|ランチ|ディナー|食事)|ごはん|レストラン|れすとらん|食堂/.test(e.title) ? 'meal' : 'activity';
    const t = noParen(e.title).replace(/^「(.+)」/, '$1');
    items.push({ ...base(), type, title: t || e.title, address: type === 'activity' && !/購入|預け|受け取|散策|確認/.test(t) ? t.replace(/\s*(見学|散策|観光|日帰り入浴|露天風呂)$/, '') : '', start, end, cost: type !== 'meal' ? money(e.subs.join(' ')) : '', notes: [paren(e.title), ...notes].filter(Boolean).join('\n'), _onsen: tag === 'onsen' });
  }
  // 終わりの時刻が無い移動は、次の予定の始まりまで（最大2時間）
  const sorted = items.filter((x) => x.start).sort((a, b) => a.start.localeCompare(b.start));
  for (const it of items) {
    if (!it._needsEnd) continue;
    delete it._needsEnd;
    const nx = sorted.find((x) => x.start > it.start);
    if (nx && toDate(nx.start) - toDate(it.start) <= 120 * 60000) it.end = nx.start;
  }
  // 宿のチェックアウト（書かれていなければ、翌日の最初の予定に合わせる）
  for (const h of items.filter((x) => x.type === 'hotel' && x._date)) {
    const d = h._date;
    if (!h.start) h.start = iso(d, { h: 15, mi: 0 });
    if (h._approx) {
      // 「夜 宿泊：〇〇」のように時刻が言葉の時は、その日の最後の予定のあと
      const same = items.filter((x) => x !== h && x.type !== 'hotel' && x.start.startsWith(dk(d)));
      const last = same.map((x) => x.end || plus(x.start, 60)).sort().pop();
      const ci = last ? new Date(Math.ceil((toDate(last).getTime() + 30 * 60000) / 1800000) * 1800000) : new Date(d.y, d.mo - 1, d.d, 15, 0);
      const fifteen = new Date(d.y, d.mo - 1, d.d, 15, 0);
      h.start = toISO(ci < fifteen ? fifteen : ci);
    }
    if (!h._co) {
      const nd = addDays(d, 1);
      const next = items.filter((x) => x.start.startsWith(dk(nd)) && x.type !== 'hotel').sort((a, b) => a.start.localeCompare(b.start));
      let co = new Date(nd.y, nd.mo - 1, nd.d, 10, 0);
      const back = next.find((x) => /宿へ戻|ホテルへ戻|宿に戻|荷物をまとめ/.test(x.notes + x.title));
      const firstMove = next.find((x) => TRANSPORT.has(x.type));
      if (!back && firstMove) { const c = new Date(toDate(firstMove.start).getTime() - 30 * 60000); if (c < co) co = c; }
      if (back) { const dep = next.find((x) => x.start > back.start && TRANSPORT.has(x.type) && toDate(x.start) - toDate(back.start) > 30 * 60000); if (dep) { const c = new Date(toDate(dep.start).getTime() - 20 * 60000); if (c < co) co = c; } }
      if (next.length || items.some((x) => x.start > h.start && x !== h)) h.end = toISO(co);
      h.notes = ['チェックアウトの時刻は目安', h.notes].filter(Boolean).join('\n');
    }
    if (h._approx) h.notes = ['チェックインの時刻は目安', h.notes].filter(Boolean).join('\n');
    delete h._date; delete h._approx; delete h._co;
  }
  for (const it of items) delete it._onsen;

  // ===== 欄（メモ・予備ルート・パターン） =====
  const findTarget = (sec) => {
    const day = sec.date ? dk(sec.date) : '';
    const words = noParen(sec.head).replace(/の(代わりに|場合|予備).*$/, '').replace(/が.*$/, '').replace(/[:：].*$/, '').trim();
    const cand = items.filter((x) => !day || (x.start || x.end || '').startsWith(day));
    if (words) {
      // 名前がいちばんよく合う予定（名前で始まる・移動ではない予定を優先）
      const score = (x) => (x.title.startsWith(words) ? 3 : near(x.title, words) ? 2 : words.length >= 2 && x.title.includes(words.slice(0, 3)) ? 1 : 0) + (score0(x) && !TRANSPORT.has(x.type) ? 0.5 : 0);
      const score0 = (x) => x.title.includes(words.slice(0, 2));
      const best = cand.map((x) => [score(x), x]).filter(([v]) => v >= 1).sort((a, b) => b[0] - a[0])[0];
      if (best) return best[1];
    }
    return cand[cand.length - 1] || items[items.length - 1];
  };
  for (const sec of doc.sections) {
    if (sec.kind === 'skip' || !sec.lines.length) continue;
    if (sec.kind === 'alt') {
      const legs = altLegs(sec, today, doc.docYear);
      const isPattern = /パターン|帰り方|行き方/.test(sec.head);
      if (legs.length) {
        if (isPattern) {
          // 1つ目の案は本命として旅程に、2つ目からは予備
          legs.forEach((l, k) => { if (k) { l.is_alternate = true; l.route_group = `P${k}`; } items.push(l); });
        } else {
          legs.forEach((l, k) => { l.is_alternate = true; l.route_group = `${sec.head}-${k}`; items.push(l); });
        }
        continue;
      }
    }
    const tgt = findTarget(sec);
    if (tgt) tgt.notes = [tgt.notes, `【${sec.head}】\n${sec.lines.join('\n')}`].filter(Boolean).join('\n');
  }
  // 「予約済み」の書き込み
  const rn = doc.reservedNote;
  if (rn) for (const it of items) {
    if (it.type === 'flight' && /航空券|飛行機|フライト|便/.test(rn)) it.reserved = true;
    if (it.type === 'hotel' && /宿|ホテル|宿泊/.test(rn)) it.reserved = true;
    if (['train', 'shinkansen'].includes(it.type) && /指定席|特急|新幹線|切符|きっぷ/.test(rn)) it.reserved = true;
    if (it.type === 'bus' && /バス/.test(rn)) it.reserved = true;
  }
  items.title = doc.title;
  return items;
}

// 予備ルート・帰り方の欄から区間を作る（「ひだ20号 18:48 高山発 → 下呂 19:29着」「名古屋 15:25 ひかり654号」）
function altLegs(sec, today, docYear) {
  // 「A ひかり（早く帰る）」「B こだま」のような案ごとに分ける
  const groups = [];
  let g = null;
  for (const l of sec.lines) {
    if (/^[A-DＡ-Ｄ①-④](?=[\s　.．:：)）]|[ぁ-んァ-ヶ一-龯])/.test(l) || /^案\s*\d/.test(l)) { g = { head: l, lines: [] }; groups.push(g); continue; }
    if (!g) { g = { head: '', lines: [] }; groups.push(g); }
    g.lines.push(l);
  }
  const date = sec.date;
  const legs = [];
  for (const gr of groups) {
    const lines = gr.head ? [[gr.head.replace(/^[A-DＡ-Ｄ①-④]\s*[^(（]*[(（][^)）]*[)）]\s*/, ''), ...gr.lines].join(' ')] : gr.lines.flatMap((l) => (l.match(/\d+号/g) || []).length > 1 ? l.split(/\s*[／/]\s*(?=\S*\d+号)/) : [l]);
    for (const text of lines) {
      const pts = [];
      const re = /(\d{1,2}):(\d{2})\s*(頃)?/g;
      let m;
      while ((m = re.exec(text))) {
        const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
        if (/(期限は?|受付|最終|毎時|まで|~|〜|-|–)\s*$/.test(before) || /^\s*(のため|まで|~|〜|-|–)/.test(after) || /^\s*-\s*\d/.test(after)) continue;
        let st = '';
        const a1 = /^\s*([^\s\d()（）→／/、:：・]{1,10}?)\s*(発|着)/.exec(after);
        const b1 = /([^\s\d()（）→／/、:：・]{1,10})\s*[(（]?\s*$/.exec(before);
        if (a1 && !/^(発|着)$/.test(a1[1])) st = a1[1];
        else if (b1 && !/号$|^(日曜|土曜|平日|受付|最終|毎時|約|あなた)/.test(b1[1])) st = b1[1];
        else if (a1) st = '';
        if (!st) { const a2 = /^\s*([^\s\d()（）→／/、:：・]{2,10})/.exec(after); if (a2 && !/号|^(発|着)/.test(a2[1])) st = a2[1]; }
        st = cleanPlace(st.replace(/^.*?号/, ''));
        if (st && !/[\p{L}]/u.test(st)) st = '';
        pts.push({ st, t: tm(m[1], m[2]), approx: !!m[3] });
      }
      const veh = (/([^\s()（）]*?\d+号)/.exec(text) || /([^\s()（）]*?\d+号)/.exec(gr.head) || /(こだま|ひかり|のぞみ|ひだ|しなの)/.exec(`${gr.head} ${text}`) || [])[1] || '';
      if (!pts.length || !date || !pts[0].st || (pts.length > 1 && !pts[pts.length - 1].st)) continue;
      if (pts.length < 2 && !veh) continue;
      // 乗り物の手がかりが無い行（「昼食 → 入浴 の順に変更」など）は区間にしない
      if (!veh && !/発|着/.test(text) && !typeOf(text)) continue;
      const a = pts[0], b = pts.length > 1 ? pts[pts.length - 1] : null;
      let d2 = date;
      if (b && b.t.h * 60 + b.t.mi < a.t.h * 60 + a.t.mi) d2 = addDays(date, 1);
      legs.push({
        ...base(), type: typeOf(`${veh} ${text}`) || 'train', title: veh, from: a.st, to: b ? b.st : '',
        start: iso(date, a.t), end: b ? iso(d2, b.t) : '', cost: money(gr.lines.join(' ')),
        notes: [gr.head, pts.length > 2 ? `途中：${pts.slice(1, -1).map((p) => `${p.st} ${p.t.h}:${pad(p.t.mi)}`).join('／')}` : '', paren(text) && !findTimes(paren(text)).length ? paren(text) : '', ...(gr.head ? gr.lines.filter((l) => !findTimes(l).length) : []), (a.approx || b?.approx) && '時刻は目安'].filter(Boolean).join('\n'),
      });
      if (gr.head) break;
    }
  }
  return legs;
}

// 旅程表らしい文章か（時刻の行がいくつもある・Day見出しがある・分類の言葉が並ぶ）
export function looksLikeSchedule(text) {
  const lines = String(text || '').split('\n').map(prep);
  let n = 0, heads = 0, tags = 0;
  for (const l of lines) {
    if (readTime(l)) n++;
    else if (TIME_LEAD.test(l) && /発|着|宿泊|散策|観光|集合|食|→|移動|温泉|チェック/.test(l)) n++;
    if (DAY_HEAD.test(l)) heads++;
    if (TAG_ONLY.test(l)) tags++;
  }
  return n >= 3 || (heads >= 1 && n >= 2) || tags >= 3;
}

export function parseScheduleText(text, today = new Date()) {
  const doc = readSchedule(text, today);
  if (!doc.entries.length) return null;
  return buildSchedule(doc, today);
}

// ===== PDF・写真の「文字の位置」から、読む順の行を組み立てる =====
//  pages: [{ w, h, items: [{ s, x, y, w, h }] }]（y は上から）
//  表の行は「時刻の列」を手がかりに、同じ高さの内容・補足・分類をまとめて、
//  「時刻」「内容」「補足…」「分類」の順の行にする。2段組みの欄は左→右の順にする
export function layoutLines(pages) {
  const out = [];
  for (const pg of pages) {
    const W = pg.w || Math.max(...pg.items.map((i) => i.x + i.w), 1);
    const its = pg.items.filter((i) => i.s && i.s.trim()).map((i) => ({ ...i, s: prep(i.s), cy: i.y + i.h / 2 }));
    if (!its.length) continue;
    const hMed = median(its.map((i) => i.h)) || 10;
    // 同じ高さのかたまりを1行に（左から）
    const rows = groupRows(its, hMed);
    // 行の中を、間があいた所で「ます」に分ける
    for (const r of rows) r.cells = splitCells(r.items, hMed);
    // 時刻の列：左の方にある、時刻だけ（または言葉の時刻）のます
    // 数字の時刻が並ぶ列を見つけて、その列にあるものだけを時刻とする（内容の列の「昼食」を時刻と間違えない）
    const isNum = (t) => /^\d{1,2}\s*[:：]\s*\d{2}/.test(t);
    const numX = rows.map((r) => r.cells[0]).filter((c) => c && c.x < W * 0.3 && isNum(c.s) && c.s.length <= 22).map((c) => c.x);
    const colX = numX.length >= 2 ? median(numX) : W * 0.12;
    const timeCells = [];
    for (const r of rows) {
      const c = r.cells[0];
      if (!c || c.s.length > 22 || c.x > colX + W * 0.06 || c.x < colX - W * 0.08) continue;
      if ((isNum(c.s) && (readTime(c.s) || /^\d{1,2}\s*[:：]\s*\d{2}\s*(?:[-~→]\s*)?$/.test(c.s))) || (WORD_ONLY.test(c.s) && r.cells.length > 1 && r.cells[1].x - (c.x + c.w) > W * 0.02)) timeCells.push({ s: c.s, y: r.y, cy: r.cy, h: r.h, row: r });
    }
    // 2行に分かれた時刻（「10:15 →」「10:40」）をまとめる
    const tcells = [];
    for (const c of timeCells) {
      const p = tcells[tcells.length - 1];
      if (p && /[-~→]\s*$/.test(p.s) && c.cy - p.cy < hMed * 2.2 && readTime(c.s) && !readTime(c.s).t2) { p.s = `${p.s} ${c.s}`; p.cy = (p.cy + c.cy) / 2; p.rows.push(c.row); continue; }
      tcells.push({ ...c, rows: [c.row] });
    }
    const used = new Set();
    for (const c of tcells) for (const r of c.rows) { used.add(r); r.cells.shift(); }
    // 表の範囲：時刻のますが続いている所
    const tableRows = new Map(); // 時刻のます → 内容の行
    if (tcells.length) {
      const gaps = tcells.slice(1).map((c, k) => c.cy - tcells[k].cy);
      const rowH = Math.min(median(gaps) || hMed * 3, hMed * 4);
      for (let k = 0; k < tcells.length; k++) {
        const c = tcells[k];
        const top = k ? Math.max((tcells[k - 1].cy + c.cy) / 2, c.cy - rowH * 0.9) : c.cy - rowH * 0.6;
        const bot = k < tcells.length - 1 ? Math.min((tcells[k + 1].cy + c.cy) / 2, c.cy + rowH * 0.9) : c.cy + rowH * 0.6;
        tableRows.set(c, rows.filter((r) => r.cy >= top && r.cy < bot && (r.cells.length || used.has(r)) && !tcells.some((x) => x !== c && x.rows.includes(r))));
      }
    }
    const inTable = new Set();
    for (const rs of tableRows.values()) for (const r of rs) inTable.add(r);
    // 読む順に並べる
    const blocks = [];
    for (const c of tcells) blocks.push({ y: c.cy, kind: 'entry', c });
    let two = null;
    for (const r of rows) {
      if (inTable.has(r) || (used.has(r) && !r.cells.length)) continue;
      // 2段組み（左右の欄が同じ高さに並ぶ）
      const left = r.cells.filter((x) => x.x < W * 0.48), right = r.cells.filter((x) => x.x >= W * 0.48);
      const isTwo = left.length && right.length && right[0].x - (left[left.length - 1].x + left[left.length - 1].w) > W * 0.04 && left[0].x < W * 0.2;
      if (isTwo) {
        if (!two || r.cy - two.last > hMed * 2.6) { two = { y: r.cy, kind: 'two', L: [], R: [], last: r.cy }; blocks.push(two); }
        two.L.push(left.map((x) => x.s).join(' ')); two.R.push(right.map((x) => x.s).join(' ')); two.last = r.cy;
        continue;
      }
      if (two && r.cy - two.last < hMed * 2.6 && (r.cells[0].x >= W * 0.48 || r.cells[r.cells.length - 1].x + r.cells[r.cells.length - 1].w <= W * 0.52)) {
        (r.cells[0].x >= W * 0.48 ? two.R : two.L).push(r.cells.map((x) => x.s).join(' ')); two.last = r.cy; continue;
      }
      two = null;
      blocks.push({ y: r.cy, kind: 'line', s: r.cells.map((x) => x.s).join(' ') });
    }
    blocks.sort((a, b) => a.y - b.y);
    for (const b of blocks) {
      if (b.kind === 'line') out.push(b.s);
      else if (b.kind === 'two') out.push(...b.L, ...b.R);
      else {
        const rs = tableRows.get(b.c) || [];
        const texts = [];
        let tag = '';
        for (const r of rs) for (const x of r.cells) {
          if (TAG_ONLY.test(x.s) && x.x > W * 0.6) { tag = x.s; continue; }
          texts.push({ s: x.s, h: x.h, y: r.cy, x: x.x });
        }
        texts.sort((a, b2) => a.y - b2.y || a.x - b2.x);
        out.push(b.c.s);
        // いちばん大きい字（最初の行）が内容、残りは補足
        const titleH = Math.max(...texts.map((t) => t.h), 0);
        const ti = texts.findIndex((t) => t.h >= titleH * 0.92);
        if (ti >= 0) {
          out.push(texts[ti].s);
          texts.forEach((t, k) => { if (k !== ti) out.push(t.s); });
        }
        if (tag) out.push(tag);
      }
    }
    out.push('');
  }
  return out.join('\n');
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }
function groupRows(its, hMed) {
  const sorted = [...its].sort((a, b) => a.cy - b.cy || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const r = rows.find((x) => Math.abs(x.cy - it.cy) < Math.max(hMed, it.h) * 0.5);
    if (r) { r.items.push(it); r.cy = (r.cy * (r.items.length - 1) + it.cy) / r.items.length; r.h = Math.max(r.h, it.h); }
    else rows.push({ items: [it], cy: it.cy, y: it.y, h: it.h });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows;
}
function splitCells(items, hMed) {
  const s = [...items].sort((a, b) => a.x - b.x);
  const cells = [];
  for (const it of s) {
    const c = cells[cells.length - 1];
    const gap = c ? it.x - (c.x + c.w) : Infinity;
    if (c && gap < Math.max(hMed, it.h) * 1.4) { c.s += (gap > it.h * 0.25 && /[A-Za-z0-9]$/.test(c.s) ? ' ' : gap > it.h * 0.6 ? ' ' : '') + it.s; c.w = it.x + it.w - c.x; c.h = Math.max(c.h, it.h); }
    else cells.push({ s: it.s, x: it.x, w: it.w, h: it.h });
  }
  return cells;
}
