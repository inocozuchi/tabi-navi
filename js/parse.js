// 文章（コピーした予約メール・乗換案内・メモなど）から旅程の予定を取り出す。
// AI を使わず、端末の中だけで動く。形式がバラバラでも、種類を自動で見分ける。
//   宿（予約サイトのメール）／飛行機／新幹線・電車（乗換案内のコピー）／高速バス／日時の書かれたメモ
// この部品は画面に依存しない（テストしやすいように）

const pad = (n) => String(n).padStart(2, '0');

// 全角→半角、記号のそろえ
export function normalize(text) {
  return String(text || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ：／．－（）＋＃＠]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[〜～∼]/g, '~').replace(/[ー−―‐]/g, (c, i, s) => (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? '-' : c))
    .replace(/\u3000/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r/g, '');
}

// 写真の文字読み取り（Tesseract）の結果を整える
//  ・日本語の文字の間に入る余計な空白を取る（「東 京 駅」→「東京駅」）
//  ・時刻の読み間違いを直す（「1O:3O」「12;30」「12 : 30」→「10:30」「12:30」）
//  ・よくある漢字の読み間違い（時刻のあとの「癸」→「発」、カタカナの間の「一」→「ー」など）
//  ・記号だけの行（アイコンのかけら）を消す
const CJK = '\\u3005\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60';
export function cleanOcrText(text) {
  let s = String(text || '').replace(/\r/g, '')
    .replace(/[０-９：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const between = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');
  s = s.replace(between, '$1').replace(between, '$1');
  // 数字と単位の間の空白（「10 月 27 日」「14 番線」）
  s = s.replace(/(\d)[ \t]+(?=(?:年|月|日|時|分|円|番線|号車|号|番|席|泊|名|便)(?![a-zA-Z]))/g, '$1')
    .replace(/(年|月)[ \t]+(?=\d)/g, '$1');
  // 時刻らしい所の O/o/l/I/| を数字に
  const fix = (t) => t.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  s = s.replace(/(^|[^\dA-Za-z])([0-2]?[\dOolI|])[ \t]*[:;：][ \t]*([0-5Oo][\dOolI|])(?![\dA-Za-z])/g, (m, a, h, mi) => `${a}${fix(h)}:${fix(mi)}`);
  // 時刻のあとの「発」「着」の読み間違い
  s = s.replace(/(\d:\d\d)[ \t]*癸/g, '$1発').replace(/(\d:\d\d)[ \t]*看/g, '$1着');
  // カタカナの間の「一」（漢数字のいち）は長音の「ー」
  s = s.replace(/([ァ-ヴ])[一―](?![一-龯])/g, '$1ー');
  // 円記号の読み間違い（「半1,200」「Y1,200」）
  s = s.replace(/(^|[^A-Za-z])[半Y](?=\d{1,3}(?:,\d{3})+)/gm, '$1¥');
  // 空の行は予約の区切りとして残す
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => !l || (/[\p{L}\p{N}]/u.test(l) && !/^[A-Za-z]$/.test(l) && !/^[^\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,2}$/u.test(l)))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const IATA = {
  HND: '羽田空港', NRT: '成田空港', KIX: '関西空港', ITM: '伊丹空港', NGO: '中部国際空港', UKB: '神戸空港', CTS: '新千歳空港', FUK: '福岡空港',
  OKA: '那覇空港', KOJ: '鹿児島空港', KMJ: '熊本空港', NGS: '長崎空港', OIT: '大分空港', KMI: '宮崎空港', HIJ: '広島空港', OKJ: '岡山空港',
  TAK: '高松空港', MYJ: '松山空港', KCZ: '高知空港', TKS: '徳島空港', SDJ: '仙台空港', AOJ: '青森空港', AKJ: '旭川空港', HKD: '函館空港',
  KMQ: '小松空港', TOY: '富山空港', KIJ: '新潟空港', ISG: '石垣空港', MMY: '宮古空港', SHI: '下地島空港', FSZ: '静岡空港', IBR: '茨城空港',
  ICN: '仁川空港', GMP: '金浦空港', PUS: '釜山空港', TPE: '桃園空港', TSA: '松山空港(台北)', HKG: '香港空港', BKK: 'スワンナプーム空港', DMK: 'ドンムアン空港',
  SIN: 'チャンギ空港', MNL: 'マニラ空港', CEB: 'セブ空港', SGN: 'タンソンニャット空港', HAN: 'ノイバイ空港', KUL: 'クアラルンプール空港', DPS: 'バリ空港',
  PVG: '上海浦東空港', PEK: '北京首都空港', HNL: 'ホノルル空港', GUM: 'グアム空港', LAX: 'ロサンゼルス空港', JFK: 'JFK空港', SFO: 'サンフランシスコ空港',
  LHR: 'ヒースロー空港', CDG: 'シャルル・ド・ゴール空港', FRA: 'フランクフルト空港', SYD: 'シドニー空港',
};
const AIRLINES = { NH: 'ANA', JL: 'JAL', BC: 'スカイマーク', MM: 'Peach', GK: 'ジェットスター', '7G': 'スターフライヤー', HD: 'AIRDO', '6J': 'ソラシドエア', IJ: 'スプリング', FW: 'IBEX', NU: 'JTA', JH: 'FDA', OC: 'ORC', KE: '大韓航空', OZ: 'アシアナ', CI: 'チャイナエアライン', BR: 'エバー航空', CX: 'キャセイ', SQ: 'シンガポール航空', TG: 'タイ国際航空', UA: 'ユナイテッド', DL: 'デルタ', AA: 'アメリカン' };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// 文の中の日付を探す（年が無ければ、今日以降でいちばん近い日）
export function findDate(s, today = new Date()) {
  let m, y = null, mo, d;
  if ((m = /(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s))) [mo, d] = [+m[1], +m[2]];
  else if ((m = /(?:^|[^\d:/])(\d{1,2})\/(\d{1,2})(?![\d:])/.exec(s))) [mo, d] = [+m[1], +m[2]];
  else if ((m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(20\d{2})?/i.exec(s))) [d, mo, y] = [+m[1], MONTHS[m[2].toLowerCase()], m[3] ? +m[3] : null];
  else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})?/i.exec(s))) [mo, d, y] = [MONTHS[m[1].toLowerCase()], +m[2], m[3] ? +m[3] : null];
  else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  if (!y) {
    y = today.getFullYear();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (new Date(y, mo - 1, d) < new Date(t0.getTime() - 30 * 864e5)) y++;
  }
  return { y, mo, d, index: m.index, len: m[0].length };
}
// 時刻（9:05 / 9時5分 / 9時 / 9:05 PM）
export function findTimes(s) {
  const out = [];
  const re = /(\d{1,2})\s*(?::|時(?!間))\s*(\d{2})?\s*分?\s*(am|pm|午前|午後)?/gi;
  let m;
  while ((m = re.exec(s))) {
    if (!m[2] && !/時/.test(m[0])) continue;
    if (/^\d/.test(s.slice(m.index + m[0].length)) ) continue;
    let h = +m[1];
    const mi = +(m[2] || 0);
    const ap = (m[3] || '').toLowerCase();
    // 「午前」「午後」は時刻の前に書かれることも多い
    const before = s.slice(Math.max(0, m.index - 3), m.index);
    if ((ap === 'pm' || ap === '午後' || /午後/.test(before)) && h < 12) h += 12;
    if ((ap === 'am' || ap === '午前' || /午前/.test(before)) && h === 12) h = 0;
    if (h > 29 || mi > 59) continue;
    out.push({ h, mi, index: m.index, len: m[0].length });
  }
  return out;
}
const iso = (dt, t) => (dt && t ? `${dt.y}-${pad(dt.mo)}-${pad(dt.d)}T${pad(t.h % 24)}:${pad(t.mi)}` : '');
const addDays = (dt, n) => { const x = new Date(dt.y, dt.mo - 1, dt.d + n); return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate() }; };
const base = () => ({ title: '', from: '', to: '', start: '', end: '', operator: '', number: '', platform: '', seat: '', confirmation: '', cost: '', address: '', notes: '', reserved: false });

function money(s) {
  const m = /(?:合計|総額|料金|運賃|支払|お支払い|金額|Total|Price|価格|代金)[^\d¥￥]{0,12}[¥￥]?\s*([\d,]{3,})\s*円?/i.exec(s) || /[¥￥]\s*([\d,]{3,})/.exec(s) || /([\d,]{3,})\s*円/.exec(s);
  return m ? `¥${m[1].replace(/^,|,$/g, '')}` : '';
}
function confirmation(s) {
  const m = /(?:予約番号|予約ID|予約コード|お預かり番号|確認番号|確認コード|申込番号|お問い合わせ番号|予約記録番号|Booking\s*(?:number|ID|reference|No\.?)|Confirmation\s*(?:number|code|No\.?)|Reservation\s*(?:number|ID|No\.?)|PIN)\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(s);
  return m ? m[1] : '';
}
const isReserved = (s) => /予約(が)?(完了|確定|確認)|ご予約|予約番号|確認番号|購入(が)?完了|e-?チケット|搭乗券|Booking (confirmed|confirmation)|Reservation confirmed|Confirmation/i.test(s);

// ===== 宿 =====
function parseHotel(s, today) {
  if (!/チェックイン|check-?in|宿泊|ご宿泊|泊数|\d\s*泊|ホテル|旅館|ホステル|ゲストハウス|カプセル|hotel|hostel|inn\b|ryokan/i.test(s)) return null;
  if (!/チェックイン|check-?in|宿泊|泊/i.test(s)) return null;
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  let name = '';
  const lab = /(?:施設名|宿泊施設|ホテル名|宿名|宿泊先|Property|Hotel name|Accommodation)\s*[:：]?\s*(.*)/i;
  for (let i = 0; i < lines.length && !name; i++) {
    const m = lab.exec(lines[i]);
    if (m) name = m[1].trim() || lines[i + 1] || '';
  }
  if (!name) name = lines.find((l) => /ホテル|旅館|ホステル|ゲストハウス|カプセル|イン\b|ナインアワーズ|ドーミー|東横|アパ|ルートイン|Hotel|Hostel|Inn|Resort|リゾート/i.test(l) && l.length <= 40 && !/予約|チェック|ありがとう|ご利用|サイト|メール/.test(l)) || '';
  name = name.replace(/^[【\[「『]|[】\]」』]$/g, '').replace(/\s*(様|御中)$/, '').trim();
  // チェックイン・アウト
  const near = (kw) => {
    const i = s.search(kw);
    if (i < 0) return {};
    const seg = s.slice(i, i + 70);
    return { dt: findDate(seg, today), t: findTimes(seg)[0] };
  };
  const ci = near(/チェックイン|check-?in|到着日|宿泊日|ご宿泊日/i), co = near(/チェックアウト|check-?out|出発日/i);
  const dIn = ci.dt || findDate(s, today);
  let dOut = co.dt;
  const nights = /(\d{1,2})\s*泊|(\d{1,2})\s*nights?/i.exec(s);
  if (!dOut && dIn) dOut = addDays(dIn, nights ? +(nights[1] || nights[2]) : 1);
  if (dIn && dOut && new Date(dOut.y, dOut.mo - 1, dOut.d) <= new Date(dIn.y, dIn.mo - 1, dIn.d)) dOut = addDays(dIn, nights ? +(nights[1] || nights[2]) : 1);
  const addr = (/(?:住所|所在地|Address)\s*[:：]?\s*(.+)/i.exec(s) || [])[1] || (/(〒?\d{3}-\d{4}\s*.+)/.exec(s) || [])[1] || '';
  const tel = (/(?:電話|TEL|Tel|Phone)\s*[:：]?\s*([\d+\-() ]{9,})/.exec(s) || [])[1] || '';
  const room = (/(?:部屋タイプ|お部屋|客室|部屋|ルーム|Room(?: type)?|ベッド)\s*[:：]?\s*(.{2,30})/i.exec(s) || [])[1] || '';
  const guessed = !ci.t || !co.t;
  return [{
    ...base(), type: 'hotel', title: name || '宿',
    start: iso(dIn, ci.t || { h: 15, mi: 0 }), end: iso(dOut, co.t || { h: 10, mi: 0 }),
    address: addr.trim().slice(0, 80), phone: tel.trim(), confirmation: confirmation(s), cost: money(s), reserved: isReserved(s),
    notes: [room && `部屋: ${room.trim()}`, guessed && 'チェックイン・アウトの時刻は推定'].filter(Boolean).join('\n'),
  }];
}

// ===== 飛行機 =====
function parseFlights(s, today) {
  const re = /\b(NH|JL|BC|MM|GK|7G|HD|6J|IJ|FW|NU|JH|OC|KE|OZ|CI|BR|CX|SQ|TG|UA|DL|AA|[A-Z]{2})\s?(\d{1,4})\b\s*便?/g;
  const found = [];
  let m;
  while ((m = re.exec(s))) {
    const ctx = s.slice(Math.max(0, m.index - 30), m.index + 160);
    if (!/便|flight|搭乗|空港|airport|出発|到着|[A-Z]{3}\s*[→\->~]|\b[A-Z]{3}\b/i.test(ctx)) continue;
    if (!AIRLINES[m[1]] && !/便|flight|搭乗/i.test(ctx)) continue;
    found.push({ code: m[1], num: m[2], index: m.index });
  }
  if (!found.length) return null;
  const out = [];
  const seen = new Set();
  found.forEach((f, k) => {
    const key = f.code + f.num;
    if (seen.has(key)) return;
    seen.add(key);
    const lineStart = s.lastIndexOf('\n', f.index) + 1;
    const nextStart = found[k + 1] ? s.lastIndexOf('\n', found[k + 1].index) + 1 : 0;
    const seg = s.slice(lineStart, found[k + 1] && nextStart > f.index ? nextStart : found[k + 1] ? found[k + 1].index : f.index + 260);
    const dt = findDate(seg, today) || findDate(s.slice(0, f.index + 1).split('\n').slice(-6).join('\n'), today) || findDate(s, today);
    const times = findTimes(seg);
    const codes = [...seg.matchAll(/\b([A-Z]{3})\b/g)].map((x) => x[1]).filter((c) => IATA[c]);
    const named = [...seg.matchAll(/([^\s()（）:：→~\-]{1,10}(?:空港|Airport))/g)].map((x) => x[1]);
    let from = named[0] || (codes[0] ? IATA[codes[0]] : ''), to = named[1] || (codes[1] ? IATA[codes[1]] : '');
    const dep = /(?:出発|発|Dep(?:art)?)/i, arr = /(?:到着|着|Arr(?:ive)?)/i;
    let st = times[0], en = times[1];
    const lineDep = seg.split('\n').find((l) => dep.test(l) && findTimes(l).length), lineArr = seg.split('\n').find((l) => arr.test(l) && findTimes(l).length);
    if (lineDep) st = findTimes(lineDep)[0];
    if (lineArr) en = findTimes(lineArr)[lineDep === lineArr ? 1 : 0] || en;
    let endDt = dt;
    if (st && en && en.h * 60 + en.mi < st.h * 60 + st.mi) endDt = dt && addDays(dt, 1);
    const term = (/(第?\d|[A-Z])\s*ターミナル|Terminal\s*(\d|[A-Z])/i.exec(seg) || []);
    out.push({
      ...base(), type: 'flight', title: `${AIRLINES[f.code] || f.code} ${f.code}${f.num}便`, number: `${f.code} ${f.num}`, operator: AIRLINES[f.code] || '',
      from: from + (term[0] && from ? ` ${term[0]}` : ''), to, start: iso(dt, st), end: iso(endDt, en),
      seat: (/(?:座席|Seat)\s*[:：]?\s*(\d{1,2}[A-K])/i.exec(seg) || [])[1] || '', platform: (/(?:搭乗口|ゲート|Gate)\s*[:：]?\s*([A-Z]?\d{1,3}[A-Z]?)/i.exec(seg) || [])[1] ? `ゲート ${(/(?:搭乗口|ゲート|Gate)\s*[:：]?\s*([A-Z]?\d{1,3}[A-Z]?)/i.exec(seg))[1]}` : '',
      confirmation: confirmation(s), cost: found.length === 1 ? money(s) : '', reserved: isReserved(s),
    });
  });
  return out;
}

// ===== 乗換案内・電車・新幹線 =====
const RIDE = /(新幹線|のぞみ|ひかり|こだま|はやぶさ|はやて|やまびこ|なすの|つばさ|こまち|とき|たにがわ|かがやき|はくたか|つるぎ|あさま|みずほ|さくら|つばめ|かもめ|特急|快速|急行|普通|各駅停車|線|ライン|ライナー|Line|Shinkansen|Express|メトロ|地下鉄|バス|モノレール|ゆりかもめ|電鉄|鉄道|号)/;
const STATION_NG = /^(\d|乗換|乗り換え|徒歩|運賃|料金|IC|きっぷ|片道|往復|合計|所要|時間|距離|発車|到着|出発|経由|次|前|後|検索|印刷|保存|共有|ルート|定期|通勤|通学|指定席|自由席|グリーン|乗車|降車|番線|\[|【)/;
function stationName(l) {
  const x = l.replace(/^[■□●○◆◇▼▽・\-–>→]+/, '').replace(/\s*(駅|から|まで)?\s*$/, '').trim();
  if (!x || x.length > 20 || STATION_NG.test(x) || RIDE.test(x) && !/駅$/.test(l.trim())) return '';
  if (/[0-9]{2,}/.test(x) && !/空港|ターミナル/.test(x)) return '';
  return x;
}
function parseRoute(s, today) {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const pts = []; // {t, kind, station, li}
  const rides = []; // {text, li}
  let lastStation = null;
  let explicit = false;
  let dt = findDate(s, today);
  lines.forEach((l, li) => {
    const ts = findTimes(l);
    if (ts.length) {
      const rest = l.replace(/(\d{1,2})\s*(?::|時)\s*(\d{2})?\s*分?\s*(am|pm|午前|午後)?/gi, ' ').replace(/[()（）\[\]]/g, ' ').trim();
      // 「06:00発 → 08:15着」のように1行に2つの時刻がある
      if (ts.length >= 2 && /発/.test(l) && /着/.test(l)) {
        const names = rest.split(/→|->|~|－|-|発|着/).map((x) => stationName(x)).filter(Boolean);
        if (!names.length) return; // 「06:00発→08:15着 2時間15分」のような、まとめの行
        pts.push({ t: ts[0], kind: 'd', station: names[0] || lastStation?.name || '', li });
        pts.push({ t: ts[1], kind: 'a', station: names[1] || '', li });
        return;
      }
      const kind = /着|arr/i.test(l) ? 'a' : /発|dep/i.test(l) ? 'd' : '';
      if (kind) explicit = true;
      let st = stationName(rest.replace(/発|着|dep(art)?|arr(ive)?/gi, ' ').trim());
      if (!st && lastStation && li - lastStation.li <= 2 && !lastStation.used) { st = lastStation.name; lastStation.used = true; }
      const plat = (/(\d{1,2})\s*番線/.exec(l) || [])[1];
      pts.push({ t: ts[0], kind, station: st, li, plat: plat ? `${plat}番線` : '' });
      return;
    }
    const plat = /(\d{1,2})\s*番線/.exec(l);
    if (plat) { if (pts.length && !pts[pts.length - 1].plat) pts[pts.length - 1].plat = `${plat[1]}番線`; return; }
    if (/\d+\s*号車/.test(l) && l.length < 20) return;
    if (RIDE.test(l) && !/乗換|乗り換え|運賃|料金|検索|定期/.test(l) && l.length <= 40) { rides.push({ text: l.replace(/^[■□●○◆◇▼▽・]+/, '').trim(), li }); return; }
    const st = stationName(l);
    if (st) {
      lastStation = { name: st, li, used: false };
      // 駅名が時刻の後に書かれる形式（「08:15着」の次の行が駅名）
      const p = pts[pts.length - 1];
      if (p && !p.station && li - p.li <= 2) { p.station = st; lastStation.used = true; }
    }
  });
  if (pts.length < 2 || (!explicit && !rides.length)) return null;
  // 「発」「着」が無い時は、交互に 発→着 とみなす
  let expect = 'd';
  for (const p of pts) { if (!p.kind) p.kind = expect; expect = p.kind === 'd' ? 'a' : 'd'; }
  // 乗り換え：着いた駅から次が出る
  pts.forEach((p, i) => { if (p.kind === 'd' && !p.station && pts[i - 1]?.kind === 'a') p.station = pts[i - 1].station; });
  const legs = [];
  let dayShift = 0, prevMin = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.kind !== 'd' || b.kind !== 'a') continue;
    const am = a.t.h * 60 + a.t.mi, bm = b.t.h * 60 + b.t.mi;
    if (prevMin >= 0 && am < prevMin - 120) dayShift++;
    const d1 = dt && addDays(dt, dayShift);
    const d2 = dt && addDays(dt, dayShift + (bm < am ? 1 : 0));
    if (bm < am) dayShift++;
    prevMin = bm;
    const ride = rides.filter((r) => r.li > a.li - 2 && r.li < b.li).map((r) => r.text)[0] || '';
    const type = /新幹線|のぞみ|ひかり|こだま|はやぶさ|はやて|やまびこ|なすの|つばさ|こまち|とき|たにがわ|かがやき|はくたか|つるぎ|あさま|みずほ|さくら|つばめ|Shinkansen/.test(ride) ? 'shinkansen'
      : /バス|bus/i.test(ride) ? 'bus' : /メトロ|地下鉄|都営|Metro|Subway/i.test(ride) ? 'subway' : /フェリー|船|ferry/i.test(ride) ? 'ferry' : 'train';
    legs.push({ ...base(), type, title: ride.replace(/\s*\(.*?\)\s*$/, ''), from: a.station, to: b.station, start: iso(d1, a.t), end: iso(d2, b.t), platform: a.plat || '', operator: (/(JR[^\s線]*|東京メトロ|都営|近鉄|阪急|阪神|京阪|南海|名鉄|小田急|京王|東急|西武|東武|京急|京成|相鉄)/.exec(ride) || [])[1] || '' });
  }
  if (!legs.length) return null;
  const c = money(s);
  if (c) legs[0].cost = c;
  const seat = /(\d{1,2})\s*号車\s*(\d{1,2})\s*番?\s*([A-E])/.exec(s);
  if (seat) { const l = legs.find((x) => x.type === 'shinkansen') || legs[0]; l.seat = `${seat[1]}号車 ${seat[2]}${seat[3]}`; }
  const res = isReserved(s) || /指定席|座席/.test(s) && /号車/.test(s);
  legs.forEach((l) => { l.reserved = res; });
  return legs;
}


// 「東京(9:00)→新大阪(11:27)」「東京 9:00 → 新大阪 11:27」のように1行で書かれた区間
function parseArrow(s, today) {
  const re = /([^\s()（）→>~:：]{1,15}?)\s*[(（]?\s*(\d{1,2}:\d{2})\s*[)）]?\s*発?\s*(?:→|->|⇒|~|－)\s*([^\s()（）→>~:：]{1,15}?)\s*[(（]?\s*(\d{1,2}:\d{2})\s*[)）]?\s*着?/g;
  const out = [];
  let m;
  const lines = s.split('\n');
  while ((m = re.exec(s))) {
    const from = stationName(m[1]), to = stationName(m[3]);
    if (!from || !to || /^[\d発着]/.test(from + to) || /空港/.test(from + to)) continue; // 飛行機は別で読む
    const before = s.slice(0, m.index);
    const dt = findDate(before.split('\n').slice(-6).join('\n') + '\n' + s.slice(m.index, m.index + m[0].length), today) || findDate(s, today);
    const t1 = findTimes(m[2])[0], t2 = findTimes(m[4])[0];
    const li = before.split('\n').length - 1;
    const ride = (lines.slice(Math.max(0, li - 4), li + 1).reverse().find((l) => RIDE.test(l) && !/[→]/.test(l)) || '').replace(/^.*?(?:列車名|便名|路線)\s*[:：]\s*/, '').trim();
    const type = /新幹線|のぞみ|ひかり|こだま|はやぶさ|はやて|やまびこ|つばさ|こまち|とき|かがやき|はくたか|みずほ|さくら|つばめ/.test(ride + s) ? 'shinkansen' : /バス/.test(ride) ? 'bus' : 'train';
    const d2 = dt && t2.h * 60 + t2.mi < t1.h * 60 + t1.mi ? addDays(dt, 1) : dt;
    out.push({ ...base(), type, title: ride, from, to, start: iso(dt, t1), end: iso(d2, t2) });
  }
  if (!out.length) return null;
  const seat = /(\d{1,2})\s*号車\s*(\d{1,2})\s*番?\s*([A-E])/.exec(s);
  if (seat) out[0].seat = `${seat[1]}号車 ${seat[2]}${seat[3]}`;
  out[0].cost = money(s);
  out.forEach((l) => { l.reserved = isReserved(s); l.confirmation = confirmation(s); });
  return out;
}

// ===== 高速バス =====
function parseBus(s, today) {
  if (!/バス/.test(s) || !/乗車|降車|乗り場|発車/.test(s)) return null;
  const on = /(?:乗車(?!日)|乗り場|出発地)\s*(?:場所|地)?\s*[:：]?\s*([^\n]+)/.exec(s), off = /(?:降車(?!日)|到着地)\s*(?:場所|地)?\s*[:：]?\s*([^\n]+)/.exec(s);
  if (!on || !off) return null;
  const dt = findDate(s, today);
  const t1 = findTimes(on[0])[0] || findTimes(s)[0], t2 = findTimes(off[0])[0] || findTimes(s)[1];
  const clean = (x) => x.replace(/(\d{1,2})\s*(?::|時)\s*(\d{2})?\s*分?/g, '').replace(/[()（）]|発|着/g, ' ').trim().slice(0, 30);
  const d2 = dt && t1 && t2 && t2.h * 60 + t2.mi < t1.h * 60 + t1.mi ? addDays(dt, 1) : dt;
  const name = (/([^\n]{0,20}(?:号|バス|ライナー|エクスプレス|ドリーム|WILLER|ウィラー)[^\n]{0,10})/.exec(s) || [])[1] || '高速バス';
  return [{ ...base(), type: 'bus', title: name.trim(), from: clean(on[1]), to: clean(off[1]), start: iso(dt, t1), end: iso(d2, t2), seat: (/(?:座席|席番)\s*[:：]?\s*(\d{1,2}[A-D]?)/.exec(s) || [])[1] || '', confirmation: confirmation(s), cost: money(s), reserved: isReserved(s) }];
}

// ===== 日時の書いてあるメモ（観光・集合など） =====
function parseEvents(s, today) {
  const out = [];
  let ctxDate = null;
  for (const raw of s.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const dt = findDate(l, today);
    if (dt) ctxDate = dt;
    const ts = findTimes(l);
    if (!ts.length || !ctxDate) continue;
    let title = l;
    for (const t of [...ts].reverse()) title = title.slice(0, t.index) + ' ' + title.slice(t.index + t.len);
    if (dt) title = title.slice(0, dt.index) + ' ' + title.slice(dt.index + dt.len);
    title = title.replace(/\([月火水木金土日]\)|（[月火水木金土日]）|[~\-→]|^\s*[・■●\-]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const type = /食|ランチ|ディナー|朝食|夕食|レストラン|カフェ|居酒屋|寿司|ラーメン/.test(title) ? 'meal' : 'activity';
    out.push({ ...base(), type, title: title.slice(0, 40), start: iso(ctxDate, ts[0]), end: ts[1] ? iso(ctxDate, ts[1]) : '', notes: l.length > 40 ? l : '' });
  }
  return out;
}


// ===== 旅程表（時刻の行＋内容の行が並ぶ文書） =====
// 例:
//   Day 1｜10月27日（火）
//   18:10
//   成田空港 発（Peach MM579）
//   20:00
//   新千歳空港 着 → 快速エアポートで札幌へ
//   夜
//   宿泊：○○ホテル
// 「7:30 札幌 発（特急宗谷）」のように1行に書かれていても読める。
const WORD_TIME = { 早朝: [6, 0], 朝: [8, 0], 朝食: [7, 30], 午前: [10, 0], 昼: [12, 0], 昼食: [12, 0], ランチ: [12, 0], 午後: [14, 0], 夕方: [17, 0], 夕食: [18, 30], ディナー: [18, 30], 夜: [20, 0], 深夜: [23, 0] };
const WORD_RE = new RegExp(`^(${Object.keys(WORD_TIME).join('|')})$`);
const WORD_LEAD = new RegExp(`^(${Object.keys(WORD_TIME).join('|')})[\\s　:：]+(.+)$`);
const TIME_ONLY = /^(\d{1,2})[:時](\d{2})分?\s*(頃|ごろ|前後)?(?:\s*[/／、,~]\s*(\d{1,2})[:時](\d{2}))?\s*(頃|ごろ)?$/;
const TIME_LEAD = /^(\d{1,2})[:時](\d{2})分?\s*(頃|ごろ)?(?:\s*[~\-]\s*(\d{1,2}):(\d{2}))?\s+(.+)$/;
const SKIP_HEAD = /^(予約)?(チェックリスト|状況)|^(メモ|注意|備考|持ち物|費用|予算|参考|リンク)/;
const AIR = /\d+\s*便|Peach|ピーチ|ANA|JAL|スカイマーク|ジェットスター|AIRDO|ソラシド|スターフライヤー|\b(?:NH|JL|BC|MM|GK|7G|HD|6J|IJ|FW|NU|JH|OC|[A-Z]{2})\s?\d{2,4}\b/;
const HOTEL_WORD = /宿泊|泊まる|チェックイン|ホテル|旅館|ゲストハウス|ホステル|カプセル|民宿|ペンション|イン\b/;

export function looksLikeSchedule(s) {
  const lines = s.split('\n').map((l) => l.trim());
  let n = 0, heads = 0;
  for (const l of lines) {
    if (TIME_ONLY.test(l) || WORD_RE.test(l)) n++;
    else if (TIME_LEAD.test(l) && /発|着|宿泊|散策|観光|集合|食/.test(l)) n++;
    if (/^(Day|DAY|day)\s*\d|^\d+\s*日目/.test(l)) heads++;
  }
  return n >= 3 || (heads >= 1 && n >= 2);
}

function stationOf(t) {
  return t.replace(/\(.*?\)/g, '').replace(/[発着]/g, '').replace(/^[\s→>]+|[\s→>。、]+$/g, '').replace(/\s+/g, ' ').trim();
}

export function parseSchedule(src, today = new Date()) {
  const lines = src.split('\n').map((l) => l.trim());
  const yearM = /(20\d{2})\s*[年/.\-]/.exec(src);
  const docYear = yearM ? +yearM[1] : null;
  const dateOf = (l) => { const d = findDate(l, today); if (d && docYear && !/20\d{2}/.test(l)) d.y = docYear; return d; };
  let title = '';
  for (const l of lines) { if (!l) continue; if (!findDate(l, today) && !findTimes(l).length && l.length <= 40) title = l; break; }

  // 1) 時刻と内容の組（エントリー）を集める
  let ctx = null, skip = false, pending = null;
  const entries = [];
  let reservedNote = '';
  const push = (e) => { entries.push(e); return e; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const isHead = /^(Day|DAY|day)\s*\d|^\d+\s*日目/.test(l);
    const dt = dateOf(l);
    if (isHead || (dt && !TIME_ONLY.test(l) && !TIME_LEAD.test(l) && !/[~〜]\s*$/.test(l) && l.length <= 40 && !skip)) {
      if (dt) ctx = dt;
      skip = false; pending = null;
      continue;
    }
    if (SKIP_HEAD.test(l) && l.length <= 14) { skip = true; pending = null; continue; }
    if (skip) {
      if (/予約済/.test(l)) reservedNote = (lines[i + 1] || '') + l;
      continue;
    }
    if (/^[※＊*・•]/.test(l)) { const last = entries[entries.length - 1]; if (last) last.notes.push(l.replace(/^[※＊*・•]\s*/, '')); continue; }
    let m;
    if ((m = TIME_ONLY.exec(l))) {
      pending = { date: ctx, t: { h: +m[1], mi: +m[2] }, approx: !!(m[3] || m[6]), alt: m[4] ? `${m[1]}:${m[2]}／${m[4]}:${m[5]}` : '', text: '', notes: [] };
      continue;
    }
    if ((m = WORD_RE.exec(l))) { const w = WORD_TIME[m[1]]; pending = { date: ctx, t: { h: w[0], mi: w[1] }, word: m[1], approx: true, text: '', notes: [] }; continue; }
    if (pending) { pending.text = l; push(pending); pending = null; continue; }
    if ((m = TIME_LEAD.exec(l))) { push({ date: ctx, t: { h: +m[1], mi: +m[2] }, approx: !!m[3], end: m[4] ? { h: +m[4], mi: +m[5] } : null, text: m[6], notes: [] }); continue; }
    if ((m = WORD_LEAD.exec(l))) { const w = WORD_TIME[m[1]]; push({ date: ctx, t: { h: w[0], mi: w[1] }, word: m[1], approx: true, text: m[2], notes: [] }); continue; }
    const last = entries[entries.length - 1];
    if (last && entries.length) last.notes.push(l);
  }
  if (!entries.length) return null;

  // 2) エントリーを「発」「着」「宿」「予定」に分ける
  for (const e of entries) {
    const t = e.text;
    const head = t.split('→')[0];
    const paren = (/\(([^)]*)\)/.exec(head) || [])[1] || '';
    const afterArrow = (/→\s*(.+)$/.exec(t) || [])[1] || '';
    if (/宿泊|泊まる|チェックイン/.test(t) || (HOTEL_WORD.test(t) && !/[発着]/.test(t))) {
      e.kind = 'hotel';
      e.name = t.replace(/^.*?(宿泊|泊まる|チェックイン)\s*[:：]?\s*/, '').replace(/\(.*?\)/g, '').trim() || t;
      continue;
    }
    const dep = /^(.*?)\s*発(?![a-z])/.exec(t), arr = /^(.*?)\s*着(?![a-z])/.exec(t);
    if (dep && (!arr || dep[1].length <= arr[1].length)) {
      e.kind = 'dep';
      e.station = stationOf(dep[1]);
      e.ride = paren;
      // 「A 発 → B 8:32着」：同じ行に着く駅と時刻がある
      const inl = /→\s*([^\d→]+?)\s*(\d{1,2}):(\d{2})\s*着/.exec(t);
      if (inl) { e.inlineArr = { station: stationOf(inl[1]), t: { h: +inl[2], mi: +inl[3] } }; e.notes.push(t.slice(inl.index + inl[0].length).replace(/^[／/\d:着。、\s]+/, '')); }
      continue;
    }
    if (arr) {
      e.kind = 'arr';
      e.station = stationOf(arr[1]);
      e.info = paren;
      e.stay = afterArrow.replace(/^[\s→]+/, '').trim();
      continue;
    }
    e.kind = /食|ランチ|ディナー|レストラン|れすとらん|食堂|カフェ|居酒屋|寿司|ラーメン/.test(t + (e.word || '')) ? 'meal' : 'activity';
  }

  // 3) 予定を組み立てる
  const items = [];
  const at = (e, t = e.t) => iso(e.date, t);
  const typeOf = (ride, a, b) => {
    const all = `${ride} ${a} ${b}`;
    if (AIR.test(ride) || (/空港/.test(a) && /空港/.test(b))) return 'flight';
    if (/新幹線|のぞみ|ひかり|こだま|はやぶさ|はやて|やまびこ|なすの|つばさ|こまち|とき|たにがわ|かがやき|はくたか|つるぎ|あさま|みずほ|さくら|つばめ/.test(ride)) return 'shinkansen';
    if (/バス|\d+\s*番(?!線)/.test(ride) || (/ターミナル|バス停/.test(all) && !/線\b|特急|快速|普通/.test(ride))) return 'bus';
    if (/フェリー|船|航路/.test(all)) return 'ferry';
    if (/地下鉄|メトロ|都営/.test(ride)) return 'subway';
    if (/徒歩|歩いて/.test(ride)) return 'walk';
    return 'train';
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'dep') {
      let a = e.inlineArr ? { station: e.inlineArr.station, t: e.inlineArr.t, date: e.date, info: '', stay: '', notes: [] } : null;
      if (!a && entries[i + 1]?.kind === 'arr') a = entries[i + 1];
      const type = typeOf(e.ride, e.station, a?.station || '');
      const rideMain = e.ride.split(/[／/]/)[0].trim();
      const rideRest = e.ride.split(/[／/]/).slice(1).join('／').trim();
      const fl = /\b([A-Z0-9]{2})\s?(\d{2,4})\b/.exec(e.ride);
      let endDate = a?.date || e.date;
      if (a && endDate && dayKeyOf(endDate) === dayKeyOf(e.date) && a.t.h * 60 + a.t.mi < e.t.h * 60 + e.t.mi) endDate = addDays(endDate, 1);
      const it = {
        ...base(), type,
        title: type === 'flight' && fl ? `${AIRLINES[fl[1]] || (/Peach/i.test(e.ride) ? 'Peach' : fl[1])} ${fl[1]}${fl[2]}便` : rideMain || (type === 'bus' ? 'バス' : ''),
        number: fl ? `${fl[1]} ${fl[2]}` : '', operator: fl ? AIRLINES[fl[1]] || '' : '',
        from: e.station, to: a?.station || '', start: at(e), end: a ? iso(endDate, a.t) : '',
        notes: [rideRest, e.alt && `出発 ${e.alt}`, (e.approx || a?.approx) && '時刻は目安（頃）', a?.info, a && a.stay && !isStay(a.stay) && a.stay, ...e.notes, ...(a?.notes || [])].filter(Boolean).join('\n'),
      };
      if (!rideMain) {
        const near = (x, y) => x && y && (x.includes(y) || y.includes(x));
        const prev = [...items].reverse().find((p) => TRANSPORT_TYPES.has(p.type) && ((near(p.from, it.to) && near(p.to, it.from)) || near(p.to, it.from) || near(p.from, it.to)));
        if (prev && prev.title && prev.type === it.type) it.title = prev.title;
      }
      items.push(it);
      if (a && a.stay && isStay(a.stay)) {
        // 着いた所で過ごす時間（次にそこを出るまで）
        const nx = entries.slice(i + 2).find((x) => x.kind === 'dep');
        const st = new Date(...ymdhm(endDate, a.t));
        let en = nx && nx.date ? new Date(...ymdhm(nx.date, nx.t)) : null;
        const hrs = /約?\s*(\d+(?:\.\d)?)\s*時間/.exec(a.stay), mins = /約?\s*(\d+)\s*分/.exec(a.stay);
        if (!en || en - st > 6 * 3600e3 || en <= st) en = new Date(st.getTime() + (hrs ? +hrs[1] * 3600e3 : mins ? +mins[1] * 60000 : 3600e3));
        items.push({ ...base(), type: /食|ラーメン|ランチ|ディナー/.test(a.stay) && !/散策|観光/.test(a.stay) ? 'meal' : 'activity', title: `${a.station} ${a.stay.replace(/\(.*?\)|（.*?）/g, '').replace(/^約?\s*\d+(\.\d)?\s*(時間|分)\s*/, '').replace(/^現地で/, '')}`.trim(), address: a.station, start: iso(endDate, a.t), end: toISO(en), notes: a.stay });
      }
      if (a === entries[i + 1]) i++;
      continue;
    }
    if (e.kind === 'arr') {
      // 発の無い「着」（移動の続き・メモ）
      items.push({ ...base(), type: 'activity', title: `${e.station} 着`, address: e.station, start: at(e), notes: [e.info, e.stay, ...e.notes].filter(Boolean).join('\n') });
      continue;
    }
    if (e.kind === 'hotel') { items.push({ ...base(), type: 'hotel', title: e.name, start: at(e), end: '', notes: e.notes.join('\n'), _date: e.date, _word: !!e.word || e.approx }); continue; }
    const name = e.text.replace(/\(.*?\)/g, '').trim();
    items.push({ ...base(), type: e.kind, title: name.slice(0, 40), start: at(e), end: e.end ? at(e, e.end) : '', notes: [(/\(([^)]*)\)/.exec(e.text) || [])[1], e.approx && e.word && `時刻は目安（${e.word}）`, ...e.notes].filter(Boolean).join('\n') });
  }

  // 4) 宿のチェックイン・アウトを、その日の最後の移動と翌日の最初の予定から決める
  for (const h of items.filter((x) => x.type === 'hotel' && x._date)) {
    const d = h._date, dk = dayKeyOf(d);
    const sameDay = items.filter((x) => x !== h && x.start.startsWith(dk) && x.type !== 'hotel');
    const lastEnd = sameDay.map((x) => x.end || toISO(new Date(parseIso(x.start).getTime() + 60 * 60000))).sort().pop();
    let ci = h._word ? null : parseIso(h.start);
    if (!ci) {
      const le = lastEnd ? parseIso(lastEnd) : null;
      ci = le ? new Date(Math.ceil((le.getTime() + 30 * 60000) / 1800000) * 1800000) : new Date(d.y, d.mo - 1, d.d, 15, 0);
      const fifteen = new Date(d.y, d.mo - 1, d.d, 15, 0);
      if (ci < fifteen) ci = fifteen;
    }
    const nd = addDays(d, 1), nk = dayKeyOf(nd);
    const next = items.filter((x) => x.start.startsWith(nk) && x.type !== 'hotel').sort((a, b) => a.start.localeCompare(b.start));
    let co = new Date(nd.y, nd.mo - 1, nd.d, 10, 0);
    const back = next.find((x) => /宿へ戻|ホテルへ戻|宿に戻|荷物/.test(x.notes + x.title));
    if (!back && next[0]) { const f = parseIso(next[0].start); const c = new Date(f.getTime() - 30 * 60000); if (c < co) co = c; }
    if (back) { const dep = next.find((x) => x.start > back.start && TRANSPORT_TYPES.has(x.type) && x !== back && parseIso(x.start) - parseIso(back.start) > 30 * 60000); if (dep) { const c = new Date(parseIso(dep.start).getTime() - 20 * 60000); if (c < co) co = c; } }
    h.start = toISO(ci); h.end = toISO(co);
    h.notes = ['チェックイン・アウトの時刻は目安', h.notes].filter(Boolean).join('\n');
    delete h._date; delete h._word;
  }
  // 5) 「予約済み」の書き込みを反映
  if (reservedNote) {
    for (const it of items) {
      if (it.type === 'flight' && /航空券|飛行機|フライト|便/.test(reservedNote)) it.reserved = true;
      if (it.type === 'hotel' && /宿|ホテル|宿泊/.test(reservedNote)) it.reserved = true;
      if (['train', 'shinkansen'].includes(it.type) && /指定席|特急|新幹線|切符|きっぷ/.test(reservedNote)) it.reserved = true;
      if (it.type === 'bus' && /バス/.test(reservedNote)) it.reserved = true;
    }
  }
  items.title = title;
  return items;
}
const TRANSPORT_TYPES = new Set(['shinkansen', 'train', 'subway', 'bus', 'flight', 'ferry', 'taxi', 'walk']);
const isStay = (s) => /散策|観光|滞在|見学|ラーメン|食|買物|買い物|休憩|過ごす|巡り|参拝|入浴|温泉|約\s*\d+\s*(時間|分)/.test(s);
const dayKeyOf = (d) => `${d.y}-${pad(d.mo)}-${pad(d.d)}`;
const ymdhm = (d, t) => [d.y, d.mo - 1, d.d, t.h, t.mi];
const toISO = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
const parseIso = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null; };

// 文章をまとまり（予約1件ずつ）に分ける
function sections(s) {
  const parts = s.split(/\n\s*(?:[-=─━_*]{3,}|【[^】]*(?:予約|便|宿泊|ホテル|フライト|行程|往路|復路|旅程)[^】]*】)\s*\n|\n{3,}/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 3);
}

export function parseAny(text, today = new Date()) {
  const s = normalize(text);
  // 旅程表の形（時刻の行が並ぶ・Day見出し）なら、まとめて時系列として読む
  if (looksLikeSchedule(s)) {
    const sc = parseSchedule(s, today);
    if (sc && sc.length) return sc;
  }
  const out = [];
  const tryAll = (part) => {
    // 宿と飛行機は、メール全体を1件として読むことが多い
    const fl = parseFlights(part, today);
    const ho = parseHotel(part, today);
    if (fl && ho) return [...fl, ...ho];
    if (fl) return fl;
    if (ho) return ho;
    const bus = parseBus(part, today);
    if (bus) return bus;
    const ar = parseArrow(part, today);
    if (ar) return ar;
    const rt = parseRoute(part, today);
    if (rt && rt.length) return rt;
    return parseEvents(part, today);
  };
  const secs = sections(s);
  for (const p of secs.length ? secs : [s]) out.push(...tryAll(p));
  // 分けても見つからない時は全体で
  if (!out.length && secs.length > 1) out.push(...tryAll(s));
  // 同じものは1つに
  const seen = new Set();
  return out.filter((i) => { const k = `${i.type}|${i.start}|${i.from}|${i.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
