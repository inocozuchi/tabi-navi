// スクリーンショットから旅程をつくる
//  ・AI（Claude / Gemini）の API キーがある時：画像を AI に読ませて、予定を構造化して返してもらう（高精度）
//  ・キーが無い時：端末の中で文字を読み取り（Tesseract.js）、簡単な規則で予定に分ける（精度は控えめ）
import { $, $$, esc, uid, store, sheet, toast, haptic, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, blobToBase64, blobs, pad, toLocalISO, segment, aiOn, aiName, aiCompany, aiProvider } from './util.js';
import { currentTrip, ensureTrip, renderTrip, editItem, events } from './trip.js';
import { parseAny, cleanOcrText, findDate, layoutLines } from './parse.js';
import { readPdf, isPdf, pdfThumb } from './pdfimport.js';
import { prepForAI, prepForOCR } from './imageprep.js';

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
        required: ['type', 'title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'phone', 'notes', 'reserved', 'is_alternate', 'route_group', 'source_image'],
        properties: {
          type: { type: 'string', enum: TYPE_KEYS },
          title: str, from: str, to: str,
          start: { type: 'string', description: 'YYYY-MM-DDTHH:MM（現地時刻）。不明なら空文字' },
          end: { type: 'string', description: 'YYYY-MM-DDTHH:MM。不明なら空文字' },
          operator: str, number: str, platform: str, seat: str, confirmation: str, cost: str, address: str, phone: str, notes: str,
          reserved: { type: 'boolean' },
          is_alternate: { type: 'boolean' },
          route_group: { type: 'string', description: '同じ経路の候補に属する区間に同じ値（例 "A"）' },
          source_image: { type: 'integer', description: '元になった画像の番号（1から）' },
        },
      },
    },
  },
};

const SYSTEM = `あなたは旅行の予定表をつくるアシスタントです。ユーザーが送るスクリーンショットや写真（乗換案内の検索結果、ホテル・航空券・高速バス・新幹線などの予約確認画面、予約メール、紙のきっぷ・旅程表の写真など）を読み取り、旅程の「予定」の一覧にして返します。

ルール:
- 乗換案内の結果は、乗り物に乗る区間ごとに1件の予定にする（徒歩の乗り換えは、10分以上の時だけ type=walk の予定にする）。title には列車名・路線名（例「のぞみ 21号」「JR山手線 外回り」）、operator に会社名、platform に「14番線発」のような番線、cost に運賃・特急料金を入れる。
- 新幹線・特急は type=shinkansen（新幹線）または train。地下鉄は subway、路線バス・高速バスは bus、飛行機は flight、フェリーは ferry、タクシーやレンタカーは taxi。
- 号車・座席（例「7号車 3番A席」）は seat に「7号車 3A」の形で入れる。指定席・自由席・グリーン車などは notes に入れる。
- ホテル・旅館・ゲストハウス・カプセルホテルは type=hotel の1件にまとめ、start=チェックイン日時、end=チェックアウト日時。時刻が書かれていなければ チェックイン 15:00、チェックアウト 10:00 とし、notes に「時刻は推定」と書く。部屋タイプやベッドは notes、住所は address、電話番号は phone に入れる。
- 飛行機は number に便名（例「NH 21」）、from/to に空港名（ターミナルがあれば含める）、seat、confirmation（予約番号・確認番号）を入れる。
- 日時は必ず「YYYY-MM-DDTHH:MM」。年が書かれていなければ、曜日が書かれていれば曜日が合う年、無ければ今日以降でいちばん近い日付にする。日付が書かれていない画像は、ほかの画像や補足の日付から判断する。分からない項目は空文字。
- 到着時刻が出発時刻より前なら、到着は翌日（夜行バス・深夜便など）。所要時間が書かれていれば、発着時刻と合っているか確かめる。数字の読み間違い（0と8、1と7、3と8など）に注意し、つじつまが合う方を選ぶ。
- 予約完了・予約確認・eチケット・予約番号のある画面は reserved=true。検索結果だけの画面は reserved=false。
- 同じ区間について別の候補（予備ルート）として送られた画像の予定は is_alternate=true にする。1つの経路候補に属する区間には同じ route_group を付ける（主のルートは "main"）。
- 縦長の画像は「分割した○枚目」として続けて送ることがある。分割の境目で同じ予定が2回写っていたら1件にまとめ、source_image は元の画像の番号にする。
- 画像に関係のない広告・おすすめ・アプリのボタンは無視する。重複する予定は1件にまとめる。写っていないことを推測で作らない。`;

let sdkPromise;
async function sdk() {
  sdkPromise ??= import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm').catch(() => import('https://esm.sh/@anthropic-ai/sdk'));
  return (await sdkPromise).default;
}

// AI（Claude か Gemini）に画像や文章を渡し、schema の形の JSON で答えてもらう（共通）
//  content は Claude の形（{type:'text'} / {type:'image', source:{base64}}）。Gemini には形を変えて渡す
export async function callAI(opts) {
  const p = aiProvider();
  if (!p) throw new Error('「設定」で AI の API キーを入れてください');
  return p === 'gemini' ? callGemini(opts) : callClaudeAPI(opts);
}
export const callClaude = callAI;

async function callClaudeAPI({ system, content, schema, effort = 'medium' }) {
  const s = store.data.settings;
  const Anthropic = await sdk();
  const client = new Anthropic({ apiKey: s.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: s.aiModel || 'claude-opus-5-5',
    max_tokens: 16000,
    system,
    // Haiku 4.5 は effort を受け付けないので付けない
    output_config: /haiku/.test(s.aiModel || '') ? { format: { type: 'json_schema', schema } } : { effort, format: { type: 'json_schema', schema } },
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

// ----- Gemini（Google AI Studio の API キー）-----
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';
// 古い形の schema（responseSchema）は additionalProperties を受け付けないので外す
const stripSchema = (o) => Array.isArray(o) ? o.map(stripSchema) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, stripSchema(v)])) : o;
async function geminiFetch(path, body) {
  const s = store.data.settings;
  const r = await fetch(GEMINI + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = j?.error?.message || `HTTP ${r.status}`;
    const e = new Error(m);
    e.status = /API key not valid|API_KEY_INVALID/i.test(m) ? 401 : r.status;
    e.provider = 'gemini';
    throw e;
  }
  return j;
}
// 名前で指定したモデルが無くなっていた時：使えるモデルの中から Flash を選ぶ
const swapped = {};
async function geminiFallbackModel(cur) {
  const j = await geminiFetch('models?pageSize=200');
  const ok = (j.models || []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  const want = /lite/.test(cur) ? /flash-lite/ : /pro/.test(cur) ? /pro/ : /flash(?!-lite)/;
  return ok.filter((n) => want.test(n) && !/tts|image|audio|live|embed|thinking-exp/.test(n)).sort().reverse()[0] || ok.find((n) => /flash/.test(n));
}
async function callGemini({ system, content, schema }) {
  const s = store.data.settings;
  const parts = content.map((b) => b.type === 'image' ? { inline_data: { mime_type: b.source.media_type, data: b.source.data } } : { text: b.text });
  const base = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }] };
  // 形の指定のしかた：新しい形 → 古い形 → 文章で指示（モデルによって受け付ける形が違う）
  const configs = [
    { responseMimeType: 'application/json', responseJsonSchema: schema },
    { responseMimeType: 'application/json', responseSchema: stripSchema(schema) },
    { responseMimeType: 'application/json' },
  ];
  let model = s.geminiModel || 'gemini-flash-latest', lastErr;
  if (swapped[model]) model = swapped[model];
  for (let i = 0; i < configs.length; i++) {
    const body = { ...base, generationConfig: { ...configs[i], maxOutputTokens: 32768 } };
    if (i === 2) body.contents = [{ role: 'user', parts: [...parts, { text: `次の JSON Schema の形の JSON だけで答えてください:\n${JSON.stringify(schema)}` }] }];
    let res;
    try {
      res = await geminiFetch(`models/${model}:generateContent`, body);
    } catch (e) {
      lastErr = e;
      if (e.status === 404) {
        const alt = await geminiFallbackModel(model).catch(() => null);
        if (alt && alt !== model) { swapped[s.geminiModel || 'gemini-flash-latest'] = alt; model = alt; i--; continue; }
      }
      if (e.status === 400 && i < configs.length - 1) continue;
      throw e;
    }
    const c = res.candidates?.[0];
    if (!c) throw new Error(res.promptFeedback?.blockReason ? '読み取れませんでした（AIが処理を断りました）' : 'AIから答えが返りませんでした');
    if (c.finishReason === 'MAX_TOKENS') throw new Error('内容が多すぎて途中で切れました。分けて送ってください');
    if (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(c.finishReason || '')) throw new Error('読み取れませんでした（AIが処理を断りました）');
    const text = (c.content?.parts || []).filter((x) => !x.thought && x.text).map((x) => x.text).join('');
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
    catch (e) { lastErr = new Error('AIの答えを読めませんでした。もう一度お試しください'); if (i < configs.length - 1) continue; }
  }
  throw lastErr;
}

// キーが使えるか確かめる（設定の「接続テスト」）
export async function testAI() {
  const r = await callAI({ system: 'テストです。', content: [{ type: 'text', text: '{"ok": true} と答えてください。' }], schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, effort: 'low' });
  return !!r?.ok;
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
// 写真を AI 用に整える：縦長のスクショは切り分けて、文字がつぶれないようにする
//  戻り値 { content: Claude に渡す中身, views: 保存して予定に付ける画像（元の写真1枚につき1つ） }
export async function prepareImages(files, onProg) {
  const content = [], views = [];
  for (let i = 0; i < files.length; i++) {
    onProg?.(i / files.length);
    const { tiles, view } = await prepForAI(files[i]);
    views.push(view);
    for (let k = 0; k < tiles.length; k++) {
      content.push({ type: 'text', text: tiles.length > 1 ? `画像${i + 1}（縦長のため ${tiles.length} 枚に分割した ${k + 1} 枚目${k ? '・前の続き' : ''}）` : `画像${i + 1}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToBase64(tiles[k]) } });
    }
  }
  return { content, views };
}
export function friendlyError(e) {
  let msg = e?.message || String(e);
  if (e?.status === 401) msg = 'API キーが正しくありません（設定を確認してください）';
  else if (e?.status === 403) msg = 'この API キーでは使えません（キーの制限や、Google AI Studio の設定を確認してください）';
  else if (e?.status === 429 && e?.provider === 'gemini') msg = '無料で使える回数の上限です。1分ほど待つか、明日もう一度お試しください（モデルを Flash-Lite にすると回数が増えます）';
  else if (e?.status === 429 || e?.status === 529 || e?.status === 503) msg = '混み合っています。少し待ってからもう一度お試しください';
  else if (e?.status === 413) msg = '画像が大きすぎます。枚数を減らしてお試しください';
  else if (/fetch|network|load failed/i.test(msg)) msg = '通信できませんでした。電波を確認してください';
  return msg;
}

async function askAI(content, hint, alternate) {
  content = [...content, { type: 'text', text: `${todayText()}${alternate ? 'これらの画像は「予備ルート」です。すべて is_alternate=true にしてください。' : ''}${hint ? `\n補足: ${hint}` : ''}\n画像から旅程の予定を取り出してください。` }];
  return callAI({ system: SYSTEM, content, schema: SCHEMA });
}

// ===== キーが無い時：端末内の文字読み取り＋規則 =====
let tessP;
function tesseract() {
  tessP ??= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tessP = null; rej(new Error('文字読み取りの部品を読み込めませんでした（通信を確認してください）')); };
    document.head.append(s);
  });
  return tessP;
}
// 読み取りの係（worker）は1つを使い回す。毎回つくると言語データ（日本語は十数MB）を読み直して遅い
let workerP, progFn = null;
function worker() {
  workerP ??= (async () => {
    const T = await tesseract();
    const w = await T.createWorker('jpn+eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') progFn?.(m.progress, 'read');
        else if (/loading|initializ/.test(m.status) && m.progress != null) progFn?.(m.progress, 'load');
      },
    });
    // 単語の間の空白をそのまま残す（表の列がくっつかないように）
    await w.setParameters({ preserve_interword_spaces: '1' });
    return w;
  })().catch((e) => { workerP = null; throw e; });
  return workerP;
}
// 写真1枚から文字を読む。縦長は分けて読み、つなげる
//  onProg(0〜1, 'load'|'read')
export async function ocr(file, onProg) {
  const parts = await prepForOCR(file);
  const w = await worker();
  let text = '';
  const pages = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      progFn = (p, kind) => onProg?.(kind === 'load' ? p * 0.1 : (i + p) / parts.length, kind);
      const r = await w.recognize(parts[i], {}, { text: true, blocks: true });
      text += r.data.text + '\n';
      // 文字の位置から、表の行を組み立て直す（読み取りの自信が低い字は捨てる）
      const words = r.data.words?.length ? r.data.words : (r.data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || [])));
      const items = words.filter((wd) => wd.text?.trim() && (wd.confidence ?? 100) >= 55).map((wd) => ({ s: wd.text, x: wd.bbox.x0, y: wd.bbox.y0, w: wd.bbox.x1 - wd.bbox.x0, h: wd.bbox.y1 - wd.bbox.y0 }));
      const bmp = await createImageBitmap(parts[i]).catch(() => null);
      if (items.length) pages.push({ w: bmp?.width || Math.max(...items.map((x) => x.x + x.w)), h: bmp?.height || 0, items });
      bmp?.close?.();
    }
  } finally { progFn = null; }
  // 位置から組み立てた行の方が、表の旅程は正しい順になる
  const laid = pages.length ? cleanOcrText(layoutLines(pages)) : '';
  return laid && laid.length > 20 ? laid : cleanOcrText(text);
}

// 写真から読んだ文字を予定にする。日付が書かれていない画像は、前の画像の日付を引き継ぐ
export function itemsFromOcrTexts(texts) {
  const items = [];
  let lastDateLine = '';
  texts.forEach((text, i) => {
    let src = text;
    const dl = text.split('\n').find((l) => findDate(l));
    if (dl) lastDateLine = dl;
    else if (lastDateLine) src = `${lastDateLine}\n${text}`;
    items.push(...parseAny(src).map((x) => ({ ...x, is_alternate: !!x.is_alternate, route_group: x.route_group || 'main', source_image: i + 1 })));
  });
  const seen = new Set();
  const out = items.filter((x) => { const k = `${x.type}|${x.start}|${x.from}|${x.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
  out.title = texts.map((t) => parseAny(t).title).find(Boolean) || '';
  return out;
}
// ===== 文字を貼り付けて取り込む =====
// 予約メール・乗換案内の結果・メモなど、形式がバラバラでも自動で見分ける
export function openPaste({ alternate = false, targetId = null, initialText = '' } = {}) {
  const s = store.data.settings;
  let mode = alternate ? 'alt' : 'main';
  let target = targetId;
  let useAI = aiOn();
  sheet({
    title: '文字から取り込む', left: 'キャンセル',
    build(body, close) {
      body.innerHTML = `
        <div class="field-label">取り込む文字</div>
        <textarea id="ps-text" class="field" rows="9" placeholder="ここに貼り付け&#10;&#10;例）予約完了メール、乗換案内の結果、旅程表、&#10;「10/12 9:30 伏見稲荷」のようなメモ&#10;何件まとめて貼ってもOK">${esc(initialText)}</textarea>
        <div class="hstack" style="margin-top:8px"><button class="btn small secondary" id="ps-clip">${I.copy}クリップボードから貼り付け</button><button class="btn small secondary" id="ps-clear">消す</button></div>
        <div class="field-label">取り込み方</div>
        <div class="segment" id="ps-mode"><button data-v="main" class="${mode === 'main' ? 'active' : ''}">本命のルート・予約</button><button data-v="alt" class="${mode === 'alt' ? 'active' : ''}">予備ルート</button></div>
        ${aiOn() ? `<div class="list"><div class="row"><div class="grow">AI（${aiName()}）で読む<div class="sub">オフにすると端末の中だけで読み取ります（無料）</div></div><label class="switch"><input type="checkbox" id="ps-ai" ${useAI ? 'checked' : ''}><span></span></label></div></div>` : ''}
        <div class="section-foot">💡 写真やスクショの文字は、iPhoneの「写真」アプリで画像を開き、右下の<b>テキスト認識ボタン</b>→「すべてをコピー」でコピーできます（無料・高精度）。</div>
        <div style="margin-top:14px"><button class="btn" id="ps-go">${I.sparkles}読み取る</button></div>
        <div id="ps-prog" style="margin-top:12px"></div>`;
      const ta = $('#ps-text', body);
      $('#ps-clip', body).onclick = async () => { try { ta.value = await navigator.clipboard.readText(); toast('貼り付けました'); } catch { ta.focus(); toast('長押しして「ペースト」を選んでください'); } };
      $('#ps-clear', body).onclick = () => { ta.value = ''; ta.focus(); };
      segment($('#ps-mode', body), (v) => { mode = v; });
      $('#ps-ai', body)?.addEventListener('change', (e) => { useAI = e.target.checked; });
      $('#ps-go', body).onclick = async (e) => {
        const text = ta.value.trim();
        if (!text) { toast('文字を貼り付けてください'); return; }
        const prog = $('#ps-prog', body);
        e.target.disabled = true;
        try {
          let raw, name = '';
          if (useAI && aiOn()) {
            prog.innerHTML = '<div class="hstack small"><span class="spinner"></span>AIが読み取っています…</div>';
            const r = await callAI({ system: SYSTEM, content: [{ type: 'text', text: `${todayText()}${mode === 'alt' ? 'これは「予備ルート」です。すべて is_alternate=true にしてください。' : ''}\n次の文章から旅程の予定を取り出してください（source_image は 0）。\n---\n${text}` }], schema: SCHEMA, effort: 'low' });
            raw = r.items; name = r.trip_name;
          } else {
            raw = parseAny(text);
            name = raw.title || '';
          }
          const items = raw.map((x) => {
            const it = { id: uid(), type: TYPES[x.type] ? x.type : 'other' };
            for (const k of ['title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'notes', 'phone']) it[k] = (x[k] || '').trim();
            it.reserved = !!x.reserved; it.imgs = [];
            it._alt = mode === 'alt' || !!x.is_alternate; it._group = x.route_group || 'main';
            return it;
          });
          if (!items.length) { prog.innerHTML = '<div class="small" style="color:var(--orange)">予定を見つけられませんでした。日付と時刻が入っているか確かめてください。</div>'; e.target.disabled = false; return; }
          close();
          setTimeout(() => review(items, name, target), 300);
        } catch (err) { prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(friendlyError(err))}</div>`; e.target.disabled = false; }
      };
      setTimeout(() => ta.focus(), 450);
    },
  });
}

// ===== 取り込み画面 =====
export function openImport({ alternate = false, targetId = null }) {
  const s = store.data.settings;
  const files = [];
  let mode = alternate ? 'alt' : 'main';
  let target = targetId;
  let useAI = aiOn();
  let hint = '';
  let onPaste = null;
  const addFiles = (list) => { for (const f of list) if (f && (isPdf(f) || /^image\//.test(f.type || 'image/'))) files.push({ file: f, url: isPdf(f) ? '' : URL.createObjectURL(f), pdf: isPdf(f), name: f.name }); };
  sheet({
    title: alternate ? '予備ルートを取り込む' : '写真・PDFから取り込む', left: 'キャンセル',
    onClose: () => { document.removeEventListener('paste', onPaste); },
    build(body, close) {
      const draw = () => {
        const trip = currentTrip();
        const moves = trip ? events(trip).filter((e) => e.kind !== 'out') : [];
        body.innerHTML = `
          <div class="drop-pair">
            <label class="drop" id="imp-drop"><span class="drop-ico">${I.photo}</span><span class="drop-title">写真・スクショ</span><span class="drop-sub">予約画面・乗換案内など<br>複数まとめてOK</span>
              <input type="file" accept="image/*" multiple hidden id="imp-file"></label>
            <label class="drop pdf"><span class="drop-ico">${I.note}</span><span class="drop-title">PDFファイル</span><span class="drop-sub">旅程表・予約確認の PDF<br>いちばん正確に読めます</span>
              <input type="file" accept="application/pdf,.pdf" multiple hidden id="imp-pdf"></label>
          </div>
          <button class="btn small secondary" id="imp-clip" style="margin-top:10px;width:100%">${I.copy}コピーした画像を貼り付け</button>
          <div class="thumbs" id="imp-th"></div>
          <div class="section-title">取り込み方</div>
          <div class="segment" id="imp-mode"><button data-v="main" class="${mode === 'main' ? 'active' : ''}">本命のルート・予約</button><button data-v="alt" class="${mode === 'alt' ? 'active' : ''}">予備ルート</button></div>
          ${mode === 'alt' && moves.length ? `<div class="list"><div class="row"><div style="flex:none">どの予定の予備？</div><select id="imp-target"><option value="">自動で判断</option>${moves.map((e) => `<option value="${e.it.id}" ${target === e.it.id ? 'selected' : ''}>${e.at ? hm(e.at) : ''} ${esc(e.it.title || '')} ${esc(e.it.from || '')}→${esc(e.it.to || '')}</option>`).join('')}</select></div></div>` : ''}
          <div class="list" style="margin-top:12px"><div class="row"><div style="flex:none">補足</div><input type="text" id="imp-hint" class="left" placeholder="例：10月3日の出発です（任意）" value="${esc(hint)}"></div>
          ${aiOn() ? `<div class="row"><div class="grow">AI（${aiName()}）で読む<div class="sub">オフにすると端末の中だけで読み取ります（無料）</div></div><label class="switch"><input type="checkbox" id="imp-ai" ${useAI ? 'checked' : ''}><span></span></label></div>` : ''}</div>
          <div class="section-foot">${useAI && aiOn() ? `${I.sparkles} AI（${aiName()}）で読み取ります。画像は読み取りのために ${aiCompany()} に送られます。` : `端末の中で読み取ります（無料・読み取り後に直せます）。<b>PDF</b>は文字がそのまま入っているので、いちばん正確です。写真の文字読み取りは、色付きの表や小さい字で間違えることがあります。${aiOn() ? '' : '「設定」で Gemini か Claude の API キーを入れると、写真もずっと正確に読めます（Gemini は無料枠あり）。'}`}</div>
          <div style="margin-top:16px"><button class="btn" id="imp-go" ${files.length ? '' : 'disabled'}>${I.sparkles}${files.length ? `${files.length}件を読み取る` : '写真かPDFを選んでください'}</button></div>
          <div id="imp-prog" style="margin-top:14px"></div>`;
        const th = $('#imp-th', body);
        files.forEach((f, i) => {
          const d = document.createElement('div');
          d.className = 'th';
          d.innerHTML = f.pdf ? `<div class="th-pdf">${I.note}<b>PDF</b><span>${esc(f.name || '')}</span></div><button data-rm="${i}" aria-label="外す">×</button>` : `<img src="${f.url}" alt=""><button data-rm="${i}" aria-label="外す">×</button>`;
          th.append(d);
        });
        $$('[data-rm]', body).forEach((b) => b.onclick = (e) => { e.preventDefault(); if (files[+b.dataset.rm].url) URL.revokeObjectURL(files[+b.dataset.rm].url); files.splice(+b.dataset.rm, 1); haptic(); draw(); });
        $('#imp-file', body).onchange = (e) => { addFiles(e.target.files); draw(); };
        $('#imp-pdf', body).onchange = (e) => { addFiles(e.target.files); draw(); };
        const drop = $('#imp-drop', body);
        drop.ondragover = (e) => { e.preventDefault(); };
        drop.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer?.files || []); draw(); };
        $('#imp-clip', body).onclick = async () => {
          try {
            const list = await navigator.clipboard.read();
            let n = 0;
            for (const ci of list) for (const t of ci.types) if (t.startsWith('image/')) { const b = await ci.getType(t); addFiles([new File([b], `clip-${Date.now()}.${t.split('/')[1]}`, { type: t })]); n++; }
            if (n) { toast(`${n}枚貼り付けました`); draw(); } else toast('コピーされた画像がありません');
          } catch { toast('貼り付けできませんでした。写真を選んでください'); }
        };
        $('#imp-hint', body).oninput = (e) => { hint = e.target.value; };
        $('#imp-ai', body)?.addEventListener('change', (e) => { useAI = e.target.checked; draw(); });
        segment($('#imp-mode', body), (v) => { mode = v; draw(); });
        $('#imp-target', body)?.addEventListener('change', (e) => { target = e.target.value || null; });
        $('#imp-go', body).onclick = () => run(body, close, files, mode, target, hint, useAI && aiOn());
      };
      onPaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { addFiles(fs); draw(); } };
      document.addEventListener('paste', onPaste);
      draw();
    },
  });
}

async function run(body, close, files, mode, target, hint, useAI) {
  const prog = $('#imp-prog', body);
  const go = $('#imp-go', body);
  go.disabled = true;
  const say = (msg, p) => { prog.innerHTML = `<div class="hstack small"><span class="spinner"></span>${esc(msg)}</div>${p != null ? `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(Math.min(1, p) * 100)}%"></i></div>` : ''}`; };
  let ocrText = '';
  try {
    let result, views;
    // PDF は先に文字を取り出す（文字の入っていない PDF はページを画像にする）
    const pdfTexts = [], pdfImages = [];
    views = [];
    for (let i = 0; i < files.length; i++) {
      if (!files[i].pdf) continue;
      say(`PDFを読んでいます… ${files[i].name || ''}`, 0.05);
      const res = await readPdf(files[i].file, (p) => say('PDFを読んでいます…', 0.05 + p * 0.25));
      if (res.scanned) pdfImages.push(...res.images); else pdfTexts.push(res.text);
      files[i].thumbs = await pdfThumb(files[i].file);
    }
    const images = [...files.filter((f) => !f.pdf).map((f) => f.file), ...pdfImages];
    for (const f of files) { if (f.pdf) views.push(f.thumbs?.[0] || null); }
    if (useAI) {
      say('画像を準備しています…', 0.3);
      const prep = images.length ? await prepareImages(images, (p) => say('画像を準備しています…', 0.3 + p * 0.2)) : { content: [], views: [] };
      views = [...prep.views, ...views];
      say('AIが読み取っています…（10〜60秒ほど）', 0.5);
      const content = [...prep.content, ...pdfTexts.map((t, k) => ({ type: 'text', text: `PDF${k + 1}の文字:\n${t}` }))];
      result = await askAI(content, hint, mode === 'alt');
    } else {
      const texts = [...pdfTexts];
      const imgViews = [];
      for (let i = 0; i < images.length; i++) {
        const label = `文字を読み取っています… ${i + 1}/${images.length}`;
        say(label, 0.3 + (i / images.length) * 0.7);
        imgViews.push((await prepForAI(images[i], { maxSide: 1568 })).view);
        texts.push(await ocr(images[i], (p, kind) => say(kind === 'load' ? '文字読み取りの準備をしています…（初回だけ少し時間がかかります）' : label, 0.3 + ((i + p) / images.length) * 0.7)));
      }
      views = [...views, ...imgViews];
      ocrText = texts.join('\n\n');
      const hinted = hint ? texts.map((t, i) => (i === 0 ? `${hint}\n${t}` : t)) : texts;
      const its = itemsFromOcrTexts(hinted);
      result = { trip_name: its.title || '', items: its };
    }
    const raw = result.items || [];
    if (!raw.length) {
      prog.innerHTML = `<div class="small" style="color:var(--orange)">予定を見つけられませんでした。${ocrText ? '読み取った文字を直してから、もう一度読み取れます。' : '手入力で追加するか、別の画像を試してください。'}</div>${ocrText ? `<div style="margin-top:10px"><button class="btn secondary" id="imp-fix">${I.edit}読み取った文字を見て直す</button></div>` : ''}`;
      $('#imp-fix', body)?.addEventListener('click', () => { close(); setTimeout(() => openPaste({ alternate: mode === 'alt', targetId: target, initialText: ocrText }), 300); });
      go.disabled = false;
      return;
    }
    // 画像を保存して予定に結びつける
    const keys = [];
    for (const b of views) { const k = 'img:' + uid(); await blobs.put(k, b); keys.push(k); }
    const items = raw.map((x) => {
      const it = { id: uid(), type: TYPES[x.type] ? x.type : 'other' };
      for (const k of ['title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'phone', 'notes']) it[k] = (x[k] || '').trim();
      it.reserved = !!x.reserved;
      it.imgs = keys[(x.source_image || 1) - 1] ? [keys[(x.source_image || 1) - 1]] : [];
      it._alt = mode === 'alt' || !!x.is_alternate;
      it._group = x.route_group || 'main';
      return it;
    });
    close();
    setTimeout(() => review(items, result.trip_name, target, { rawText: ocrText, alternate: mode === 'alt' }), 350);
  } catch (e) {
    console.error(e);
    const msg = friendlyError(e);
    prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(msg)}</div>${useAI ? `<div style="margin-top:10px"><button class="btn secondary" id="imp-local">端末の中で読み取る（AIを使わない）</button></div>` : ''}`;
    $('#imp-local', body)?.addEventListener('click', () => run(body, close, files, mode, target, hint, false));
    go.disabled = false;
  }
}

// 読み取り結果の確認
export function review(items, tripName, target, { rawText = '', alternate = false } = {}) {
  const cur = currentTrip();
  // 旅の名前が読めた・今の旅が空でない時は、新しい旅として追加するのを初めの選択にする
  let dest = target || (cur && !cur.items.length) ? 'cur' : tripName || !cur ? 'new' : 'cur';
  items.sort((a, b) => (a.start || '9').localeCompare(b.start || '9'));
  const sel = new Set(items.map((i) => i.id));
  let closeSheet = () => {};
  sheet({
    title: '読み取り結果', right: '旅程に追加',
    onRight: () => {
      const chosen = items.filter((i) => sel.has(i.id));
      if (!chosen.length) return;
      let trip;
      if (dest === 'new' || !currentTrip()) {
        trip = { id: uid(), name: tripName || '新しい旅', items: [] };
        store.data.trips.push(trip); store.data.currentTrip = trip.id;
      } else trip = ensureTrip();
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
    build(body, close) {
      closeSheet = close;
      const draw = () => {
        body.innerHTML = `${cur ? `<div class="field-label" style="margin-top:4px">追加する先</div><div class="segment" id="rv-dest"><button data-v="new" class="${dest === 'new' ? 'active' : ''}">新しい旅として</button><button data-v="cur" class="${dest === 'cur' ? 'active' : ''}">表示中の旅に追加</button></div>` : ''}
          <div class="section-foot" style="margin:0 4px 10px">${dest === 'new' && tripName ? `旅の名前：<b>${esc(tripName)}</b><br>` : ''}${items.length}件見つかりました（予備ルート ${items.filter((i) => i._alt).length}件）。タップで直せます。追加しないものはチェックを外してください。</div>
          ${rawText ? `<button class="btn small secondary" id="rv-raw" style="width:100%;margin-bottom:12px">${I.edit}読み取った文字を見て直す</button>` : ''}
          ${items.map((it) => { const T = TYPES[it.type] || TYPES.other; const s = parseLocal(it.start), e = parseLocal(it.end); return `
          <div class="ev" style="--c:${T.color};margin-bottom:10px" data-id="${it.id}">
            <div class="top"><button class="check ${sel.has(it.id) ? 'on' : ''}" data-chk>${sel.has(it.id) ? I.check : ''}</button><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(it.title || T.name)}</div>${it._alt ? '<span class="badge ng">予備</span>' : ''}${it.reserved ? '<span class="badge ok">予約済み</span>' : ''}</div>
            <div class="small muted" style="margin-top:6px" data-edit>${s ? mdw(s) + ' ' + hm(s) : '日時不明'}${e ? ' → ' + (s && dayKey(e) !== dayKey(s) ? mdw(e) + ' ' : '') + hm(e) : ''}　${esc(it.from || '')}${it.to ? ' → ' + esc(it.to) : ''}${it.platform ? '　' + esc(it.platform) : ''}${it.seat ? '　座席' + esc(it.seat) : ''}</div>
            <button class="link-btn small" data-edit>${I.edit} 直す</button>
          </div>`; }).join('')}`;
        if ($('#rv-dest', body)) segment($('#rv-dest', body), (v) => { dest = v; });
        $('#rv-raw', body)?.addEventListener('click', () => { closeSheet(); setTimeout(() => openPaste({ alternate, targetId: target, initialText: rawText }), 350); });
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
