// スクリーンショットから旅程をつくる
//  ・Claude API キーがある時：画像を Claude に読ませて、予定を構造化して返してもらう（高精度）
//  ・キーが無い時：端末の中で文字を読み取り（Tesseract.js）、簡単な規則で予定に分ける（精度は控えめ）
import { $, $$, esc, uid, store, sheet, toast, haptic, I, TYPES, TRANSPORT, parseLocal, hm, mdw, shrinkImage, blobToBase64, blobs, pad, toLocalISO, segment } from './util.js';
import { currentTrip, ensureTrip, renderTrip, editItem, events } from './trip.js';

const TYPE_KEYS = Object.keys(TYPES);
const str = { type: 'string' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trip_name', 'items'],
  properties: {
    trip_name: { type: 'string', description: '旅の名前の案（例：大阪・京都 2泊3日）' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'notes', 'reserved', 'is_alternate', 'route_group', 'source_image'],
        properties: {
          type: { type: 'string', enum: TYPE_KEYS },
          title: str, from: str, to: str,
          start: { type: 'string', description: 'YYYY-MM-DDTHH:MM（現地時刻）。不明なら空文字' },
          end: { type: 'string', description: 'YYYY-MM-DDTHH:MM。不明なら空文字' },
          operator: str, number: str, platform: str, seat: str, confirmation: str, cost: str, address: str, notes: str,
          reserved: { type: 'boolean' },
          is_alternate: { type: 'boolean' },
          route_group: { type: 'string', description: '同じ経路の候補に属する区間に同じ値（例 "A"）' },
          source_image: { type: 'integer', description: '元になった画像の番号（1から）' },
        },
      },
    },
  },
};

const SYSTEM = `あなたは旅行の予定表をつくるアシスタントです。ユーザーが送るスクリーンショット（乗換案内の検索結果、ホテル・航空券・高速バス・新幹線などの予約確認画面、予約メールなど）を読み取り、旅程の「予定」の一覧にして返します。

ルール:
- 乗換案内の結果は、乗り物に乗る区間ごとに1件の予定にする（徒歩の乗り換えは、10分以上の時だけ type=walk の予定にする）。title には列車名・路線名（例「のぞみ 21号」「JR山手線 外回り」）、operator に会社名、platform に「14番線発」のような番線、cost に運賃・特急料金を入れる。
- 新幹線・特急は type=shinkansen（新幹線）または train。地下鉄は subway、路線バス・高速バスは bus、飛行機は flight、フェリーは ferry、タクシーやレンタカーは taxi。
- ホテル・旅館・ゲストハウス・カプセルホテルは type=hotel の1件にまとめ、start=チェックイン日時、end=チェックアウト日時。時刻が書かれていなければ チェックイン 15:00、チェックアウト 10:00 とし、notes に「時刻は推定」と書く。部屋タイプやベッドは notes に入れる。
- 飛行機は number に便名（例「NH 21」）、from/to に空港名（ターミナルがあれば含める）、seat、confirmation（予約番号・確認番号）を入れる。
- 日時は必ず「YYYY-MM-DDTHH:MM」。年が書かれていなければ、今日以降でいちばん近い日付にする。分からない項目は空文字。
- 予約完了・予約確認・eチケット・予約番号のある画面は reserved=true。検索結果だけの画面は reserved=false。
- 同じ区間について別の候補（予備ルート）として送られた画像の予定は is_alternate=true にする。1つの経路候補に属する区間には同じ route_group を付ける（主のルートは "main"）。
- 画像に関係のない広告やおすすめは無視する。重複する予定は1件にまとめる。`;

let sdkPromise;
async function sdk() {
  sdkPromise ??= import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm').catch(() => import('https://esm.sh/@anthropic-ai/sdk'));
  return (await sdkPromise).default;
}

// Claude に画像や文章を渡し、schema の形の JSON で答えてもらう（共通）
export async function callClaude({ system, content, schema, effort = 'medium' }) {
  const s = store.data.settings;
  const Anthropic = await sdk();
  const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: s.aiModel || 'claude-opus-5-5',
    max_tokens: 16000,
    system,
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  let res;
  try {
    // 安全確認で断られた時に、別のモデルで続けてもらう設定
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e?.status === 400) res = await client.messages.create(params);
    else throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('読み取れませんでした（AIが処理を断りました）');
  if (res.stop_reason === 'max_tokens') throw new Error('内容が多すぎて途中で切れました。分けて送ってください');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}
export const todayText = () => { const n = new Date(); return `今日は ${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日（${'日月火水木金土'[n.getDay()]}）です。`; };
export async function imageContent(blobsList) {
  const content = [];
  for (let i = 0; i < blobsList.length; i++) {
    content.push({ type: 'text', text: `画像${i + 1}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(blobsList[i]) } });
  }
  return content;
}
export function friendlyError(e) {
  let msg = e?.message || String(e);
  if (e?.status === 401) msg = 'API キーが正しくありません（設定を確認してください）';
  else if (e?.status === 429 || e?.status === 529) msg = '混み合っています。少し待ってからもう一度お試しください';
  else if (/fetch|network|load failed/i.test(msg)) msg = '通信できませんでした。電波を確認してください';
  return msg;
}

async function askClaude(images, hint, alternate) {
  const content = await imageContent(images);
  content.push({ type: 'text', text: `${todayText()}${alternate ? 'これらの画像は「予備ルート」です。すべて is_alternate=true にしてください。' : ''}${hint ? `\n補足: ${hint}` : ''}\n画像から旅程の予定を取り出してください。` });
  return callClaude({ system: SYSTEM, content, schema: SCHEMA });
}

// ===== キーが無い時：端末内の文字読み取り＋規則 =====
let tessP;
function tesseract() {
  tessP ??= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract);
    s.onerror = () => rej(new Error('文字読み取りの部品を読み込めませんでした（通信を確認してください）'));
    document.head.append(s);
  });
  return tessP;
}
export async function ocr(blob, onProg) {
  const T = await tesseract();
  const r = await T.recognize(blob, 'jpn+eng', { logger: (m) => m.status === 'recognizing text' && onProg?.(m.progress) });
  return r.data.text;
}
export function parseText(text, imgNo = 1) {
  const z2h = (s) => s.replace(/[０-９Ａ-Ｚａ-ｚ：／．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const t = z2h(text).replace(/[ \t]+/g, ' ');
  const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const now = new Date();
  let y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
  const dm = /(\d{4})[年/.-]\s?(\d{1,2})[月/.-]\s?(\d{1,2})/.exec(t) || /(\d{1,2})月\s?(\d{1,2})日/.exec(t) || /(\d{1,2})\/(\d{1,2})\s?\(/.exec(t);
  if (dm) {
    if (dm.length === 4) [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
    else { mo = +dm[1]; d = +dm[2]; if (new Date(y, mo - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++; }
  }
  const at = (h, m) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(m)}`;
  const base = { from: '', to: '', start: '', end: '', operator: '', number: '', platform: '', seat: '', confirmation: '', cost: '', address: '', notes: '', reserved: /予約(完了|確認|番号)|確認番号|e-?チケット|Confirmation/i.test(t), is_alternate: false, route_group: 'main', source_image: imgNo };
  const conf = /(予約番号|確認番号|予約ID|Confirmation(?: No\.?| number)?)[:：\s]*([A-Z0-9-]{4,})/i.exec(t);
  if (conf) base.confirmation = conf[2];
  const price = /([0-9,]{3,})\s?円|¥\s?([0-9,]{3,})/.exec(t);
  // ホテル
  if (/チェックイン|宿泊|ホテル|旅館|ゲストハウス|ホステル|カプセル|Check-?in/i.test(t)) {
    const name = lines.find((l) => /ホテル|旅館|ゲストハウス|ホステル|イン|カプセル|Hotel|Hostel|Inn/i.test(l) && l.length < 40) || '宿';
    const ci = /チェックイン[^0-9]{0,8}(\d{1,2}):(\d{2})/.exec(t), co = /チェックアウト[^0-9]{0,8}(\d{1,2}):(\d{2})/.exec(t);
    const dates = [...t.matchAll(/(\d{1,2})月\s?(\d{1,2})日/g)];
    let endD = dates[1] ? { mo: +dates[1][1], d: +dates[1][2] } : { mo, d: d + 1 };
    const e = new Date(y, endD.mo - 1, endD.d);
    return [{ ...base, type: 'hotel', title: name, start: at(ci ? +ci[1] : 15, ci ? +ci[2] : 0), end: `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${co ? pad(co[1]) + ':' + co[2] : '10:00'}`, cost: price ? (price[1] || price[2]) + '円' : '', notes: ci && co ? '' : '時刻は推定' }];
  }
  // 飛行機
  const fl = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/.exec(t);
  if (fl && /便|搭乗|出発|フライト|Flight|空港/i.test(t)) {
    const times = [...t.matchAll(/(\d{1,2}):(\d{2})/g)];
    const airports = lines.filter((l) => /空港|Airport|\([A-Z]{3}\)/.test(l)).map((l) => l.replace(/\d{1,2}:\d{2}/g, '').trim());
    return [{ ...base, type: 'flight', title: `${fl[1]} ${fl[2]}`, number: `${fl[1]} ${fl[2]}`, from: airports[0] || '', to: airports[1] || '', start: times[0] ? at(+times[0][1], +times[0][2]) : '', end: times[1] ? at(+times[1][1], +times[1][2]) : '' }];
  }
  // 乗換案内：時刻のある行を「時刻＋駅」として拾い、隣どうしを区間にする
  const pts = [];
  const lineNames = [];
  for (const l of lines) {
    const m = /^(\d{1,2}):(\d{2})\s*(発|着)?\s*(.*)$/.exec(l) || /^(.*?)\s*(\d{1,2}):(\d{2})\s*(発|着)?$/.exec(l);
    if (m && l.length < 40) {
      const first = /^\d/.test(l);
      const h = +(first ? m[1] : m[2]), mi = +(first ? m[2] : m[3]);
      const name = (first ? m[4] : m[1]).replace(/[発着]$/, '').replace(/\d+番線.*/, '').trim();
      pts.push({ h, mi, name, plat: (/(\d+番線)/.exec(l) || [])[1] || '' });
    } else if (/^\d+番線/.test(l)) { if (pts.length) pts[pts.length - 1].plat = (/(\d+番線)/.exec(l) || [])[1]; }
    else if (/線|新幹線|のぞみ|ひかり|こだま|はやぶさ|特急|快速|普通|バス|メトロ|地下鉄|ライン/.test(l) && l.length < 30) lineNames.push(l);
  }
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const a = pts[i], b = pts[i + 1];
    const ln = lineNames[out.length] || '';
    out.push({ ...base, type: /新幹線|のぞみ|ひかり|こだま|はやぶさ|みずほ|さくら|かがやき/.test(ln) ? 'shinkansen' : /バス/.test(ln) ? 'bus' : /メトロ|地下鉄/.test(ln) ? 'subway' : 'train', title: ln, from: a.name, to: b.name, platform: a.plat, start: at(a.h, a.mi), end: at(b.h, b.mi) });
  }
  if (out.length && price) out[0].cost = (price[1] || price[2]) + '円';
  return out;
}

// ===== 取り込み画面 =====
export function openImport({ alternate = false, targetId = null }) {
  const s = store.data.settings;
  const files = [];
  let mode = alternate ? 'alt' : 'main';
  let target = targetId;
  sheet({
    title: alternate ? '予備ルートを取り込む' : 'スクショから取り込む', left: 'キャンセル',
    build(body, close) {
      const draw = () => {
        const trip = currentTrip();
        const moves = trip ? events(trip).filter((e) => e.kind !== 'out') : [];
        body.innerHTML = `
          <label class="drop" id="imp-drop">${I.photo}<div style="margin-top:6px;font-weight:600;color:var(--label)">スクリーンショットを選ぶ</div><div class="small">複数まとめて選べます（乗換案内・ホテル・飛行機・バスの予約画面など）</div>
            <input type="file" accept="image/*" multiple hidden id="imp-file"></label>
          <div class="thumbs" id="imp-th"></div>
          <div class="section-title">取り込み方</div>
          <div class="segment" id="imp-mode"><button data-v="main" class="${mode === 'main' ? 'active' : ''}">本命のルート・予約</button><button data-v="alt" class="${mode === 'alt' ? 'active' : ''}">予備ルート</button></div>
          ${mode === 'alt' && moves.length ? `<div class="list"><div class="row"><div style="flex:none">どの予定の予備？</div><select id="imp-target"><option value="">自動で判断</option>${moves.map((e) => `<option value="${e.it.id}" ${target === e.it.id ? 'selected' : ''}>${e.at ? hm(e.at) : ''} ${esc(e.it.title || '')} ${esc(e.it.from || '')}→${esc(e.it.to || '')}</option>`).join('')}</select></div></div>` : ''}
          <div class="list" style="margin-top:12px"><div class="row"><div style="flex:none">補足</div><input type="text" id="imp-hint" class="left" placeholder="例：10月3日の出発です（任意）"></div></div>
          <div class="section-foot">${s.apiKey ? `${I.sparkles} AI（Claude）で読み取ります。画像は読み取りのために Anthropic に送られます。` : `端末の中で文字を読み取ります（精度は控えめ・読み取り後に直せます）。「設定」で Claude の API キーを入れると、ずっと正確に読み取れます。`}</div>
          <div style="margin-top:16px"><button class="btn" id="imp-go" ${files.length ? '' : 'disabled'}>${I.sparkles}${files.length ? `${files.length}枚を読み取る` : '画像を選んでください'}</button></div>
          <div id="imp-prog" style="margin-top:14px"></div>`;
        const th = $('#imp-th', body);
        files.forEach((f, i) => {
          const d = document.createElement('div');
          d.className = 'th';
          d.innerHTML = `<img src="${f.url}"><button data-rm="${i}">×</button>`;
          th.append(d);
        });
        $$('[data-rm]', body).forEach((b) => b.onclick = (e) => { e.preventDefault(); files.splice(+b.dataset.rm, 1); draw(); });
        $('#imp-file', body).onchange = (e) => { for (const f of e.target.files) files.push({ file: f, url: URL.createObjectURL(f) }); draw(); };
        segment($('#imp-mode', body), (v) => { mode = v; draw(); });
        $('#imp-target', body)?.addEventListener('change', (e) => { target = e.target.value || null; });
        $('#imp-go', body).onclick = () => run(body, close, files, mode, target, $('#imp-hint', body).value);
      };
      draw();
    },
  });
}

async function run(body, close, files, mode, target, hint) {
  const s = store.data.settings;
  const prog = $('#imp-prog', body);
  const go = $('#imp-go', body);
  go.disabled = true;
  const say = (msg, p) => { prog.innerHTML = `<div class="hstack small"><span class="spinner"></span>${esc(msg)}</div>${p != null ? `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(p * 100)}%"></i></div>` : ''}`; };
  try {
    say('画像を準備しています…', 0.05);
    const small = [];
    for (const f of files) small.push(await shrinkImage(f.file, 1568));
    let result;
    if (s.apiKey) {
      say('AIが読み取っています…（10〜60秒ほど）', 0.3);
      result = await askClaude(small, hint, mode === 'alt');
    } else {
      const items = [];
      for (let i = 0; i < small.length; i++) {
        say(`文字を読み取っています… ${i + 1}/${small.length}`, i / small.length);
        const text = await ocr(small[i], (p) => say(`文字を読み取っています… ${i + 1}/${small.length}`, (i + p) / small.length));
        items.push(...parseText(text, i + 1));
      }
      result = { trip_name: '', items };
    }
    // 画像を保存して予定に結びつける
    const keys = [];
    for (const b of small) { const k = 'img:' + uid(); await blobs.put(k, b); keys.push(k); }
    const items = (result.items || []).map((x) => {
      const it = { id: uid(), type: TYPES[x.type] ? x.type : 'other' };
      for (const k of ['title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'notes']) it[k] = (x[k] || '').trim();
      it.reserved = !!x.reserved;
      it.imgs = keys[(x.source_image || 1) - 1] ? [keys[(x.source_image || 1) - 1]] : [];
      it._alt = mode === 'alt' || !!x.is_alternate;
      it._group = x.route_group || 'main';
      return it;
    });
    if (!items.length) { prog.innerHTML = `<div class="small" style="color:var(--orange)">予定を見つけられませんでした。手入力で追加するか、別の画像を試してください。</div>`; go.disabled = false; return; }
    close();
    setTimeout(() => review(items, result.trip_name, target), 300);
  } catch (e) {
    console.error(e);
    const msg = friendlyError(e);
    prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(msg)}</div>`;
    go.disabled = false;
  }
}

// 読み取り結果の確認
export function review(items, tripName, target) {
  const sel = new Set(items.map((i) => i.id));
  sheet({
    title: '読み取り結果', right: '旅程に追加',
    onRight: () => {
      const chosen = items.filter((i) => sel.has(i.id));
      if (!chosen.length) return;
      const trip = ensureTrip(tripName || '新しい旅');
      if (trip.items.length === 0 && tripName && trip.name === '新しい旅') trip.name = tripName;
      const mains = chosen.filter((i) => !i._alt);
      const alts = chosen.filter((i) => i._alt);
      const clean = (i) => { const { _alt, _group, ...r } = i; return r; };
      // 本命：同じ予定がすでにあれば上書きしない
      let added = 0;
      for (const m of mains) {
        const dup = trip.items.find((x) => x.type === m.type && x.start === m.start && (x.from || '') === (m.from || '') && (x.title || '') === (m.title || ''));
        if (dup) { if (m.reserved) dup.reserved = true; continue; }
        trip.items.push(clean(m)); added++;
      }
      // 予備：まとまり（route_group）ごとに1つの予備ルートにして、いちばん合う予定にぶら下げる
      const groups = {};
      for (const a of alts) (groups[a._group] ??= []).push(clean(a));
      let altN = 0;
      for (const legs of Object.values(groups)) {
        legs.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
        const host = (target && trip.items.find((x) => x.id === target)) || bestHost(trip, legs);
        if (host) { host.alternates = [...(host.alternates || []), { id: uid(), name: `予備 ${(host.alternates?.length || 0) + 1}：${legs[0].from || ''}→${legs[legs.length - 1].to || ''}`, legs }]; altN++; }
        else { trip.items.push(...legs); added += legs.length; }
      }
      store.save(); renderTrip(); haptic();
      toast(`${added}件の予定${altN ? `と${altN}件の予備ルート` : ''}を追加しました`, 3000);
      document.querySelector('#tabbar [data-tab="trip"]')?.click();
    },
    build(body) {
      const draw = () => {
        body.innerHTML = `<div class="section-foot" style="margin:0 4px 10px">タップで直せます。追加しないものはチェックを外してください。</div>
          ${items.map((it) => { const T = TYPES[it.type] || TYPES.other; const s = parseLocal(it.start), e = parseLocal(it.end); return `
          <div class="ev" style="--c:${T.color};margin-bottom:10px" data-id="${it.id}">
            <div class="top"><button class="check ${sel.has(it.id) ? 'on' : ''}" data-chk>${sel.has(it.id) ? I.check : ''}</button><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(it.title || T.name)}</div>${it._alt ? '<span class="badge ng">予備</span>' : ''}${it.reserved ? '<span class="badge ok">予約済み</span>' : ''}</div>
            <div class="small muted" style="margin-top:6px" data-edit>${s ? mdw(s) + ' ' + hm(s) : '日時不明'}${e ? ' → ' + hm(e) : ''}　${esc(it.from || '')}${it.to ? ' → ' + esc(it.to) : ''}${it.platform ? '　' + esc(it.platform) : ''}${it.seat ? '　座席' + esc(it.seat) : ''}</div>
            <button class="link-btn small" data-edit>${I.edit} 直す</button>
          </div>`; }).join('')}`;
        $$('[data-chk]', body).forEach((b) => b.onclick = () => { const id = b.closest('[data-id]').dataset.id; sel.has(id) ? sel.delete(id) : sel.add(id); haptic(); draw(); });
        $$('[data-edit]', body).forEach((b) => b.onclick = () => {
          const it = items.find((x) => x.id === b.closest('[data-id]').dataset.id);
          editItem(it, { onSave: (n) => { Object.assign(it, n); draw(); } });
        });
      };
      draw();
    },
  });
}

// 予備ルートをぶら下げる先：出発地か到着地が同じで、時刻がいちばん近い予定
function bestHost(trip, legs) {
  const from = legs[0].from, to = legs[legs.length - 1].to;
  const st = parseLocal(legs[0].start)?.getTime();
  let best = null, score = -1;
  for (const it of trip.items) {
    if (!TRANSPORT.has(it.type)) continue;
    let sc = 0;
    if (from && it.from && (it.from.includes(from) || from.includes(it.from))) sc += 2;
    if (to && it.to && (it.to.includes(to) || to.includes(it.to))) sc += 2;
    const t = parseLocal(it.start)?.getTime();
    if (st && t) sc += Math.max(0, 1 - Math.abs(st - t) / (6 * 3600e3));
    if (sc > score) { score = sc; best = it; }
  }
  return score >= 2 ? best : null;
}
export const PLAN_SCHEMA = SCHEMA;
