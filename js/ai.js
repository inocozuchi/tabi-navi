// スクリーンショットから旅程をつくる
//  ・AI（Claude / Gemini）の API キーがある時：画像を AI に読ませて、予定を構造化して返してもらう（高精度）
//  ・キーが無い時：端末の中で文字を読み取り（Tesseract.js）、簡単な規則で予定に分ける（精度は控えめ）
import { $, $$, esc, uid, store, sheet, toast, haptic, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, blobToBase64, blobs, pad, toLocalISO, segment, aiOn, aiName, aiCompany, aiProvider } from './util.js';
import { currentTrip, ensureTrip, renderTrip, editItem, events } from './trip.js';
import { parseAny, cleanOcrText, findDate, layoutLines, looksLikeSchedule } from './parse.js';
import { mergeReadings, pickVersion, findExisting, overwrite, diffs, FIELDS } from './merge.js';
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
  let how = readModeOf();
  sheet({
    title: '文字から取り込む', left: 'キャンセル',
    build(body, close) {
      body.innerHTML = `
        <div class="field-label">取り込む文字</div>
        <textarea id="ps-text" class="field" rows="9" placeholder="ここに貼り付け&#10;&#10;例）予約完了メール、乗換案内の結果、旅程表、&#10;「10/12 9:30 伏見稲荷」のようなメモ&#10;何件まとめて貼ってもOK">${esc(initialText)}</textarea>
        <div class="hstack" style="margin-top:8px"><button class="btn small secondary" id="ps-clip">${I.copy}クリップボードから貼り付け</button><button class="btn small secondary" id="ps-clear">消す</button></div>
        <div class="field-label">取り込み方</div>
        <div class="segment" id="ps-mode"><button data-v="main" class="${mode === 'main' ? 'active' : ''}">本命のルート・予約</button><button data-v="alt" class="${mode === 'alt' ? 'active' : ''}">予備ルート</button></div>
        <div id="ps-how-box">${readModeHTML('ps-how', how)}</div>
        <div class="section-foot">💡 写真やスクショの文字は、iPhoneの「写真」アプリで画像を開き、右下の<b>テキスト認識ボタン</b>→「すべてをコピー」でコピーできます（無料・高精度）。</div>
        <div style="margin-top:14px"><button class="btn" id="ps-go">${I.sparkles}読み取る</button></div>
        <div id="ps-prog" style="margin-top:12px"></div>`;
      const ta = $('#ps-text', body);
      $('#ps-clip', body).onclick = async () => { try { ta.value = await navigator.clipboard.readText(); toast('貼り付けました'); } catch { ta.focus(); toast('長押しして「ペースト」を選んでください'); } };
      $('#ps-clear', body).onclick = () => { ta.value = ''; ta.focus(); };
      segment($('#ps-mode', body), (v) => { mode = v; });
      const bindHow = () => { if ($('#ps-how', body)) segment($('#ps-how', body), (v) => { how = v; store.data.settings.readMode = v; store.save(); $('#ps-how-box', body).innerHTML = readModeHTML('ps-how', how); bindHow(); }); };
      bindHow();
      $('#ps-go', body).onclick = async (e) => {
        const text = ta.value.trim();
        if (!text) { toast('文字を貼り付けてください'); return; }
        const prog = $('#ps-prog', body);
        e.target.disabled = true;
        try {
          const readers = [];
          if (how !== 'ai') readers.push({ src: 'local', label: '端末の読み取り', run: async () => { const r = parseAny(text); return { items: r, trip_name: r.title || '' }; } });
          if (how !== 'local' && aiOn()) readers.push({
            src: 'ai', label: aiName(),
            run: async (p) => {
              p('AIが読み取っています…', 0.2);
              let k = 0.2; const tm = setInterval(() => { k = Math.min(0.92, k + (0.95 - k) * 0.08); p('AIが読み取っています…', k); }, 700);
              try { return await callAI({ system: SYSTEM, content: [{ type: 'text', text: `${todayText()}${mode === 'alt' ? 'これは「予備ルート」です。すべて is_alternate=true にしてください。' : ''}\n次の文章から旅程の予定を取り出してください（source_image は 0）。\n---\n${text}` }], schema: SCHEMA, effort: 'low' }); }
              finally { clearInterval(tm); }
            },
          });
          const st = await runReaders(prog, readers);
          // 表の形の旅程表は端末の読み取りが正確。それ以外は AI を初めの選択にする
          const out = finishReading(st, { mode, target, priority: looksLikeSchedule(text) ? 'local' : 'ai' });
          if (!out) { prog.innerHTML += '<div class="small" style="color:var(--orange);margin-top:10px">予定を見つけられませんでした。日付と時刻が入っているか確かめてください。</div>'; e.target.disabled = false; return; }
          close();
          setTimeout(() => review(out.items, out.name, target, { alternate: mode === 'alt', sources: out.sources }), 300);
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
  let how = readModeOf();
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
          <div class="list" style="margin-top:12px"><div class="row"><div style="flex:none">補足</div><input type="text" id="imp-hint" class="left" placeholder="例：10月3日の出発です（任意）" value="${esc(hint)}"></div></div>
          ${aiOn() ? readModeHTML('imp-how', how) : `<div class="section-foot">端末の中で読み取ります（無料・読み取り後に直せます）。<b>PDF</b>は文字がそのまま入っているので、いちばん正確です。写真の文字読み取りは、色付きの表や小さい字で間違えることがあります。「設定」で Gemini か Claude の API キーを入れると、写真もずっと正確に読めます（Gemini は無料枠あり）。</div>`}
          <div style="margin-top:16px"><button class="btn" id="imp-go" ${files.length ? '' : 'disabled'}>${I.sparkles}${files.length ? `${files.length}件を読み取る` : '写真かPDFを選んでください'}</button></div>
          <div id="imp-prog" style="margin-top:14px"></div>`;
        const th = $('#imp-th', body);
        files.forEach((f, i) => {
          const d = document.createElement('div');
          d.className = f.pdf ? 'th pdf' : 'th';
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
        if ($('#imp-how', body)) segment($('#imp-how', body), (v) => { how = v; store.data.settings.readMode = v; store.save(); draw(); });
        segment($('#imp-mode', body), (v) => { mode = v; draw(); });
        $('#imp-target', body)?.addEventListener('change', (e) => { target = e.target.value || null; });
        $('#imp-go', body).onclick = () => run(body, close, files, mode, target, hint, how);
      };
      onPaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { addFiles(fs); draw(); } };
      document.addEventListener('paste', onPaste);
      draw();
    },
  });
}

// ===== 複数の読み取りを同時に行う =====
// 読み方：both=AIと端末の両方（おすすめ） / ai=AIだけ / local=端末だけ
export const readModeOf = () => (aiOn() ? (store.data.settings.readMode || 'both') : 'local');
export function readModeHTML(id, cur) {
  if (!aiOn()) return '';
  return `<div class="field-label">読み取り方</div><div class="segment" id="${id}">${[['both', '両方で読む'], ['ai', `${aiName()}だけ`], ['local', '端末だけ']].map(([v, n]) => `<button data-v="${v}" class="${cur === v ? 'active' : ''}">${n}</button>`).join('')}</div>
    <div class="section-foot">${cur === 'both' ? `${I.sparkles} ${aiName()} と端末の読み取りを同時に行い、結果を見比べます。片方が失敗しても、もう片方の結果で続けられます。` : cur === 'ai' ? `${aiName()} だけで読みます（${aiCompany()} に送られます）。` : '端末の中だけで読みます（無料・通信なし）。'}</div>`;
}
// readers: [{ src, label, run(progress) → Promise<{items, trip_name, text?}> }]
// 進み具合を出しながら全部を同時に動かす。1つ終わった時点で「待たずに進む」を押せる
async function runReaders(prog, readers) {
  const st = readers.map((r) => ({ ...r, state: 'run', msg: '準備中…', p: 0, res: null, err: null }));
  let skip; const skipP = new Promise((res) => { skip = res; });
  const draw = () => {
    const done = st.filter((r) => r.state === 'ok' && r.res.items.length);
    prog.innerHTML = `<div class="readers">${st.map((r) => `<div class="reader ${r.state}">
      <span class="r-ico">${r.state === 'run' ? '<span class="spinner"></span>' : r.state === 'ok' ? I.check : '!'}</span>
      <div class="grow"><b>${esc(r.label)}</b><div class="sub">${r.state === 'run' ? esc(r.msg) : r.state === 'ok' ? `${r.res.items.length}件 見つかりました` : esc(friendlyError(r.err))}</div>
      ${r.state === 'run' ? `<div class="progress" style="margin-top:6px"><i style="width:${Math.round(Math.min(1, r.p) * 100)}%"></i></div>` : ''}</div></div>`).join('')}</div>
      ${done.length && st.some((r) => r.state === 'run') ? `<button class="btn small secondary" id="rd-skip" style="width:100%;margin-top:10px">待たずに進む（${esc(done.map((r) => r.label).join('・'))}の結果を使う）</button>` : ''}`;
    $('#rd-skip', prog)?.addEventListener('click', () => skip());
  };
  draw();
  prog.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const ps = st.map((r) => r.run((msg, p) => { r.msg = msg; if (p != null) r.p = p; draw(); })
    .then((res) => { r.state = 'ok'; r.res = { items: res.items || [], trip_name: res.trip_name || '', text: res.text || '' }; draw(); })
    .catch((e) => { console.error(e); r.state = 'err'; r.err = e; draw(); }));
  await Promise.race([Promise.allSettled(ps), skipP]);
  return st;
}
// 読み取った予定を、アプリの予定の形にする
function toItems(raw, mode, keys = []) {
  return raw.map((x) => {
    const it = { id: uid(), type: TYPES[x.type] ? x.type : 'other' };
    for (const k of ['title', 'from', 'to', 'start', 'end', 'operator', 'number', 'platform', 'seat', 'confirmation', 'cost', 'address', 'phone', 'notes']) it[k] = String(x[k] || '').trim();
    it.reserved = !!x.reserved;
    it.imgs = keys[(x.source_image || 1) - 1] ? [keys[(x.source_image || 1) - 1]] : [];
    it._alt = mode === 'alt' || !!x.is_alternate;
    it._group = x.route_group || 'main';
    return it;
  });
}
// 結果をまとめて確認画面へ。priority: 食い違った時に初めに選んでおく読み取り
function finishReading(st, { mode, target, priority, keys = [], rawText = '' }) {
  const ok = st.filter((r) => r.state === 'ok' && r.res.items.length);
  if (!ok.length) return null;
  ok.sort((a, b) => (a.src === priority ? -1 : b.src === priority ? 1 : 0));
  const readings = ok.map((r) => ({ src: r.src, label: r.label, items: toItems(r.res.items, mode, keys) }));
  const items = mergeReadings(readings);
  const name = ok.map((r) => r.res.trip_name).find(Boolean) || '';
  const text = rawText || ok.map((r) => r.res.text).find(Boolean) || '';
  return { items, name, text, sources: ok.map((r) => r.label) };
}

async function run(body, close, files, mode, target, hint, how) {
  const prog = $('#imp-prog', body);
  const go = $('#imp-go', body);
  go.disabled = true;
  const say = (msg, p) => { prog.innerHTML = `<div class="hstack small"><span class="spinner"></span>${esc(msg)}</div>${p != null ? `<div class="progress" style="margin-top:8px"><i style="width:${Math.round(Math.min(1, p) * 100)}%"></i></div>` : ''}`; };
  try {
    // PDF は先に文字を取り出す（文字の入っていない PDF はページを画像にする）
    const pdfTexts = [], pdfImages = [], pdfViews = [];
    for (let i = 0; i < files.length; i++) {
      if (!files[i].pdf) continue;
      say(`PDFを読んでいます… ${files[i].name || ''}`, 0.05);
      const res = await readPdf(files[i].file, (p) => say('PDFを読んでいます…', 0.05 + p * 0.9));
      if (res.scanned) pdfImages.push(...res.images); else pdfTexts.push(res.text);
      files[i].thumbs = await pdfThumb(files[i].file);
      pdfViews.push(files[i].thumbs?.[0] || null);
    }
    const images = [...files.filter((f) => !f.pdf).map((f) => f.file), ...pdfImages];
    // 予定に付ける画像（写真ごとに1枚）
    say('画像を準備しています…', 0);
    const imgViews = [];
    for (let i = 0; i < images.length; i++) { imgViews.push((await prepForAI(images[i], { maxSide: 1568 })).view); say('画像を準備しています…', (i + 1) / images.length); }
    const views = [...imgViews, ...pdfViews.filter(Boolean)];
    let ocrText = '';
    const readers = [];
    if (how !== 'ai') readers.push({
      src: 'local', label: '端末の読み取り',
      run: async (p) => {
        const texts = [...pdfTexts];
        for (let i = 0; i < images.length; i++) {
          const label = `文字を読み取っています… ${i + 1}/${images.length}枚`;
          p(label, i / images.length);
          texts.push(await ocr(images[i], (q, kind) => p(kind === 'load' ? '準備しています…（初回だけ少し時間がかかります）' : label, (i + q) / images.length)));
        }
        ocrText = texts.join('\n\n');
        const hinted = hint ? texts.map((t, i) => (i === 0 ? `${hint}\n${t}` : t)) : texts;
        const its = itemsFromOcrTexts(hinted);
        return { trip_name: its.title || '', items: its, text: ocrText };
      },
    });
    if (how !== 'local' && aiOn()) readers.push({
      src: 'ai', label: aiName(),
      run: async (p) => {
        p('画像を準備しています…', 0.05);
        const prep = images.length ? await prepareImages(images, (q) => p('画像を準備しています…', 0.05 + q * 0.2)) : { content: [] };
        p('AIが読み取っています…（10〜60秒ほど）', 0.3);
        // 時間がかかる間も進んでいる感じを出す
        let k = 0.3; const tm = setInterval(() => { k = Math.min(0.92, k + (0.95 - k) * 0.06); p('AIが読み取っています…（10〜60秒ほど）', k); }, 800);
        try {
          const content = [...prep.content, ...pdfTexts.map((t, i) => ({ type: 'text', text: `PDF${i + 1}の文字:\n${t}` }))];
          return await askAI(content, hint, mode === 'alt');
        } finally { clearInterval(tm); }
      },
    });
    const st = await runReaders(prog, readers);
    // 食い違った時の初めの選択：PDF の文字だけなら端末（正確）、写真があれば AI
    const priority = images.length ? 'ai' : 'local';
    const keys = [];
    const ready = st.some((r) => r.state === 'ok' && r.res.items.length);
    if (ready) for (const b of views) { const k = 'img:' + uid(); await blobs.put(k, b); keys.push(k); }
    const out = finishReading(st, { mode, target, priority, keys, rawText: ocrText });
    if (!out) {
      const errs = st.filter((r) => r.state === 'err');
      prog.innerHTML += `<div class="small" style="color:var(--orange);margin-top:10px">予定を見つけられませんでした。${ocrText ? '読み取った文字を直してから、もう一度読み取れます。' : errs.length ? '' : '手入力で追加するか、別の画像を試してください。'}</div>
        <div class="stack" style="margin-top:10px">${ocrText ? `<button class="btn secondary" id="imp-fix">${I.edit}読み取った文字を見て直す</button>` : ''}
        ${how !== 'local' && errs.some((r) => r.src === 'ai') && !readers.some((r) => r.src === 'local') ? `<button class="btn secondary" id="imp-local">端末の中で読み取る（AIを使わない）</button>` : ''}</div>`;
      $('#imp-fix', body)?.addEventListener('click', () => { close(); setTimeout(() => openPaste({ alternate: mode === 'alt', targetId: target, initialText: ocrText }), 300); });
      $('#imp-local', body)?.addEventListener('click', () => run(body, close, files, mode, target, hint, 'local'));
      go.disabled = false;
      return;
    }
    close();
    setTimeout(() => review(out.items, out.name, target, { rawText: out.text, alternate: mode === 'alt', sources: out.sources }), 350);
  } catch (e) {
    console.error(e);
    prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(friendlyError(e))}</div>`;
    go.disabled = false;
  }
}

// 読み取り結果の確認
//  ・複数の読み取りで内容が違う予定は、どちらを使うか選べる
//  ・表示中の旅に似た予定がある時は「上書き／両方残す／追加しない」を選べる
const fmtVal = (k, v) => (k === 'type' ? (TYPES[v]?.name || v) : (k === 'start' || k === 'end') && parseLocal(v) ? `${parseLocal(v).getMonth() + 1}/${parseLocal(v).getDate()} ${hm(parseLocal(v))}` : v || '—');
const clean = (i) => { const r = {}; for (const [k, v] of Object.entries(i)) if (!k.startsWith('_')) r[k] = v; return r; };
export function review(items, tripName, target, { rawText = '', alternate = false, sources = [] } = {}) {
  const cur = currentTrip();
  // 旅の名前が読めた・今の旅が空でない時は、新しい旅として追加するのを初めの選択にする
  let dest = target || (cur && !cur.items.length) ? 'cur' : tripName || !cur ? 'new' : 'cur';
  items.sort((a, b) => (a.start || '9').localeCompare(b.start || '9'));
  const sel = new Set(items.filter((i) => !i._weak).map((i) => i.id));
  let closeSheet = () => {};
  // 表示中の旅にある似た予定（予備ルートは除く）
  const exOf = (it) => {
    if (dest !== 'cur' || it._alt) return null;
    if (it._ex === undefined) {
      const ex = findExisting(currentTrip(), it);
      it._ex = ex?.id || null;
      // 中身が同じなら「追加しない」、違うところがあれば選んでもらう（初めは今の予定を残す）
      it._dup = ex ? 'skip' : '';
      it._exDiff = ex ? diffs(ex, it) : [];
    }
    return it._ex ? currentTrip()?.items.find((x) => x.id === it._ex) : null;
  };
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
      let added = 0, over = 0;
      for (const m of mains) {
        const ex = dest === 'cur' && m._ex ? trip.items.find((x) => x.id === m._ex) : null;
        if (ex && m._dup === 'over') { overwrite(ex, clean(m)); over++; continue; }
        if (ex && m._dup !== 'both') { if (m.reserved) ex.reserved = true; continue; }
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
      const msg = [added && `${added}件を追加`, over && `${over}件を上書き`, altN && `予備ルート${altN}件を追加`].filter(Boolean).join('、');
      toast(msg ? msg + 'しました' : '変更はありません（同じ予定はそのままにしました）', 3000);
      document.querySelector('#tabbar [data-tab="trip"]')?.click();
    },
    build(body, close) {
      closeSheet = close;
      const draw = () => {
        const dupN = items.filter((it) => exOf(it)).length;
        const both = items.filter((i) => i._vers?.length > 1);
        const confN = both.filter((i) => i._conf?.length).length;
        body.innerHTML = `${cur ? `<div class="field-label" style="margin-top:4px">追加する先</div><div class="segment" id="rv-dest"><button data-v="new" class="${dest === 'new' ? 'active' : ''}">新しい旅として</button><button data-v="cur" class="${dest === 'cur' ? 'active' : ''}">表示中の旅に追加</button></div>` : ''}
          <div class="rv-summary">
            <div><b>${items.length}</b><span>見つかった予定</span></div>
            ${sources.length > 1 ? `<div><b style="color:var(--green)">${both.length - confN}</b><span>読み取りが一致</span></div><div><b style="color:${confN ? 'var(--orange)' : 'var(--label3)'}">${confN}</b><span>違いあり・選ぶ</span></div>` : ''}
            ${dupN ? `<div><b style="color:var(--blue)">${dupN}</b><span>旅程と重複</span></div>` : ''}
          </div>
          <div class="section-foot" style="margin:0 4px 10px">${dest === 'new' && tripName ? `旅の名前：<b>${esc(tripName)}</b><br>` : ''}${sources.length > 1 ? `${esc(sources.join(' と '))}の結果をまとめました。内容が違う予定は、使う方をタップで選べます。` : ''}${items.some((i) => i._weak) ? '片方でしか見つからなかった予定は、チェックを外してあります。' : ''}タップで直せます。</div>
          ${dupN ? `<div class="hstack" style="margin:0 0 12px;gap:8px"><button class="btn small secondary" data-all="over" style="flex:1">重複をすべて上書き</button><button class="btn small secondary" data-all="skip" style="flex:1">すべて今のまま</button></div>` : ''}
          ${rawText ? `<button class="btn small secondary" id="rv-raw" style="width:100%;margin-bottom:12px">${I.edit}読み取った文字を見て直す</button>` : ''}
          ${items.map((it, n) => {
            const T = TYPES[it.type] || TYPES.other; const s = parseLocal(it.start), e = parseLocal(it.end);
            const ex = exOf(it);
            const on = sel.has(it.id);
            const srcBadge = sources.length > 1 ? (it._vers?.length > 1 ? (it._conf?.length ? '<span class="badge warn">違いあり</span>' : `<span class="badge ok">${I.check} 一致</span>`) : `<span class="badge">${esc(it._vers?.[0]?.label || '')}のみ</span>`) : '';
            return `
          <div class="ev rv-card ${on ? '' : 'off'}" style="--c:${T.color};--i:${Math.min(n, 12)}" data-id="${it.id}">
            <div class="top"><button class="check ${on ? 'on' : ''}" data-chk aria-label="追加する">${on ? I.check : ''}</button><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(it.title || T.name)}</div>${it._alt ? '<span class="badge ng">予備</span>' : ''}${srcBadge}</div>
            <div class="small muted rv-line" data-edit>${s ? mdw(s) + ' ' + hm(s) : '日時不明'}${e ? ' → ' + (s && dayKey(e) !== dayKey(s) ? mdw(e) + ' ' : '') + hm(e) : ''}　${esc(it.from || '')}${it.to ? ' → ' + esc(it.to) : ''}${it.platform ? '　' + esc(it.platform) : ''}${it.seat ? '　座席' + esc(it.seat) : ''}${it.reserved ? '　<b style="color:var(--green)">予約済み</b>' : ''}</div>
            ${it._conf?.length ? `<div class="pick">
              <div class="pick-head">${I.warn}<span>読み取りが違います。使う方を選んでください</span></div>
              <div class="pick-opts">${it._vers.map((v, k) => `<button class="pick-opt ${it._pick === k ? 'on' : ''}" data-pick="${k}"><span class="pick-radio"></span><div class="grow"><b>${esc(v.label)}</b>${it._conf.map((c) => `<div class="pick-row"><span>${c.label}</span>${esc(fmtVal(c.k, v.data[c.k]))}</div>`).join('')}</div></button>`).join('')}</div>
            </div>` : ''}
            ${ex ? `<div class="pick dup">
              <div class="pick-head">${I.copy}<span>旅程に似た予定があります：<b>${esc(ex.title || '')}</b> ${parseLocal(ex.start) ? hm(parseLocal(ex.start)) : ''}</span></div>
              ${it._exDiff?.length ? `<div class="pick-diff">${it._exDiff.map((c) => `<div class="pick-row"><span>${c.label}</span><s>${esc(fmtVal(c.k, ex[c.k]))}</s> → <b>${esc(fmtVal(c.k, it[c.k]))}</b></div>`).join('')}</div>` : '<div class="small muted" style="margin:2px 0 6px">中身は同じです</div>'}
              <div class="segment small" data-dup>${[['skip', '今のまま'], ['over', '上書き'], ['both', '両方残す']].map(([v, l]) => `<button data-v="${v}" class="${it._dup === v ? 'active' : ''}">${l}</button>`).join('')}</div>
            </div>` : ''}
            <button class="link-btn small" data-edit>${I.edit} 直す</button>
          </div>`; }).join('')}`;
        if ($('#rv-dest', body)) segment($('#rv-dest', body), (v) => { dest = v; draw(); });
        $('#rv-raw', body)?.addEventListener('click', () => { closeSheet(); setTimeout(() => openPaste({ alternate, targetId: target, initialText: rawText }), 350); });
        $$('[data-chk]', body).forEach((b) => b.onclick = () => { const id = b.closest('[data-id]').dataset.id; sel.has(id) ? sel.delete(id) : sel.add(id); haptic(); draw(); });
        $$('[data-pick]', body).forEach((b) => b.onclick = () => {
          const it = items.find((x) => x.id === b.closest('[data-id]').dataset.id);
          pickVersion(it, +b.dataset.pick); it._ex = undefined; sel.add(it.id); haptic(); draw();
        });
        $$('[data-dup]', body).forEach((g) => segment(g, (v) => { const it = items.find((x) => x.id === g.closest('[data-id]').dataset.id); it._dup = v; sel.add(it.id); haptic(); }));
        $$('[data-all]', body).forEach((b) => b.onclick = () => { for (const it of items) if (it._ex) { it._dup = b.dataset.all; sel.add(it.id); } haptic(); draw(); });
        $$('[data-edit]', body).forEach((b) => b.onclick = () => {
          const it = items.find((x) => x.id === b.closest('[data-id]').dataset.id);
          editItem(clean(it), { onSave: (n) => { Object.assign(it, n); it._conf = []; it._ex = undefined; draw(); } });
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
