// AI に相談：旅程の並べ替え・抜けの補完・おすすめの提案
//  ・AI は「追加・変更・削除」の提案の一覧を返す。どれを使うかを選んでから反映する（元に戻す付き）
//  ・AI のキーが無い時は、旅程チェックの結果から端末の中で提案をつくる（整える・抜けを埋める・帰り）
import { $, $$, esc, uid, sheet, toast, haptic, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, toLocalISO, undoable, aiOn, aiName } from './util.js';
import { currentTrip, ensureTrip, renderTrip, events, flashNext, editItem } from './trip.js';
import { callAI, todayText, friendlyError, openCapture } from './ai.js';
import { checkTrip, autoFix } from './check.js';
import { FIELDS } from './merge.js';

// 相談のひな形 [キー, 名前, 説明, アイコン, AI に頼む内容, 端末だけでもできるか]
const PRESETS = [
  ['tidy', '流れを整える', '順番・時刻の矛盾・重複を直す', 'sparkles',
    '予定を実際に起きる順に整えてください。時刻の矛盾（宿のチェックインが到着より前、時間の重なり、到着が出発より前、日付の読み間違い）を直し、同じ予定が重複していれば片方を削除してください。', true],
  ['gaps', '抜けを埋める', '場所が飛んでいる所の移動・宿', 'route',
    '場所が飛んでいる所の移動と、泊まる場所が決まっていない夜の宿を追加してください。移動は実在する路線と現実的な所要時間で。便名や宿の名前が確かでない時は「JR○○線で移動」「○○駅周辺の宿」のようにし、notes に「目安・要確認」と書いてください。', true],
  ['free', '空き時間におすすめ', '近くの観光・体験を入れる', 'star',
    '1時間以上の空き時間に、その時にいる場所の近くで実在する有名な観光地・体験を追加してください（1つの空き時間に1件まで）。移動の時間も考えて、無理のない時刻にしてください。', false],
  ['meals', '食事を入れる', '昼食・夕食の時間をとる', 'food',
    '昼食（11:30〜13:30ごろ）・夕食（18:00〜20:00ごろ）が入っていない日に、その時にいる場所の近くでの食事を type=meal で追加してください。名物があれば title に入れ（例「小樽で寿司ランチ」）、店名は確かな時だけ書いてください。', false],
  ['return', '帰りを提案', '最後の場所から出発地へ', 'swap',
    '旅の最後の場所から、旅の最初の出発地へ帰る移動を提案してください。最終日の予定のあとに、現実的な時刻で。', true],
  ['relax', 'ゆとりを持たせる', '詰め込みすぎ・乗り換えを見直す', 'clock',
    '乗り換えや移動の間隔が短すぎる所、1日に詰め込みすぎている所を見直して、無理のない計画にしてください。観光の時間を短くする・順番を入れ替える・優先度の低いものを削除する、などを提案してください。', false],
];

const str = { type: 'string' };
const OPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'ops'],
  properties: {
    summary: { type: 'string', description: '提案の要点（日本語で1〜2文）' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'id', 'reason', 'item'],
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'delete'] },
          id: { type: 'string', description: 'update / delete の時は対象の予定の id。add の時は空文字' },
          reason: { type: 'string', description: 'この提案の理由（短く）' },
          item: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'title', 'from', 'to', 'start', 'end', 'address', 'notes', 'cost'],
            properties: {
              type: { type: 'string', enum: Object.keys(TYPES) },
              title: str, from: str, to: str,
              start: { type: 'string', description: 'YYYY-MM-DDTHH:MM' },
              end: { type: 'string', description: 'YYYY-MM-DDTHH:MM' },
              address: str, notes: str, cost: str,
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `あなたは旅程づくりを手伝う、日本の旅行に詳しいアシスタントです。ユーザーの旅程（JSON）と頼みごとを読み、旅程への変更を「提案の一覧（ops）」で返します。

ルール:
- op=add は新しい予定。op=update は既存の予定を変える（id を必ず入れ、item には変えない項目も含めた全項目を入れる）。op=delete は既存の予定を消す（id を入れ、item は今の値でよい）。
- reserved=true（予約済み）の予定は、ユーザーがはっきり頼んだ時以外、時刻を変えたり削除したりしない。
- 日時は「YYYY-MM-DDTHH:MM」（現地時刻）。旅の日付の範囲から外れない。移動の所要時間・乗り換え・チェックイン(15時ごろ)/アウト(10時ごろ)は現実的に。
- 宿（type=hotel）は start=チェックイン、end=チェックアウトの1件。移動は from / to を必ず入れる。観光・食事は address に場所（例「小樽市」）を入れる。
- 実在が確かでない店名・便名をつくらない。確かでない時は「○○駅周辺でランチ」「JR○○線で移動」のように書き、notes に「目安・要確認」と書く。
- 変える必要がなければ ops は空でよい。理由（reason）は日本語で短く。summary も日本語で。
- 旅程の予定が空なら、頼みごとと旅の日付から、旅程の案をまるごと add で提案してよい。`;

// 旅程を AI に渡す形にする
function tripJSON(trip) {
  return trip.items.map((i) => ({
    id: i.id, type: i.type, title: i.title || '', from: i.from || '', to: i.to || '', start: i.start || '', end: i.end || '',
    address: i.address || '', notes: String(i.notes || '').slice(0, 80), reserved: !!i.reserved,
  })).sort((a, b) => (a.start || '9').localeCompare(b.start || '9'));
}
function tripRange(trip) {
  const ev = events(trip).filter((e) => e.at);
  const a = (trip.start && parseLocal(trip.start + 'T00:00')) || ev[0]?.at, z = (trip.end && parseLocal(trip.end + 'T00:00')) || ev[ev.length - 1]?.at;
  return a ? `${dayKey(a)}${z ? ` 〜 ${dayKey(z)}` : ''}` : '未定';
}

// ===== 相談の画面 =====
export function openAssist({ preset = '', request = '' } = {}) {
  const trip = ensureTrip();
  let q = request;
  sheet({
    title: 'AIに相談', left: '閉じる',
    build(body, close) {
      const ai = aiOn();
      body.innerHTML = `
        <div class="as-hero"><span class="as-ico">${I.sparkles}</span><div><b>${ai ? `${esc(aiName())} が旅程を見て提案します` : '旅程を見て、直す所を提案します'}</b><span>提案は一覧で確かめてから反映できます。あとから元に戻せます。</span></div></div>
        ${ai ? `<div class="as-ask"><textarea id="as-q" rows="2" placeholder="例：2日目の午後に温泉を入れて／雨でも楽しめる所にして／京都2泊3日のプランをつくって">${esc(q)}</textarea><button class="btn" id="as-go" ${q.trim() ? '' : 'disabled'}>${I.sparkles}相談する</button></div>` : ''}
        <div class="section-title">${ai ? 'よく使う相談' : '端末でできること'}</div>
        <div class="list grouped as-presets">${PRESETS.map(([k, n, sub, ic, , local]) => {
          const off = !ai && !local;
          return `<button class="row icon-row ${off ? 'off' : ''}" data-p="${k}" ${off ? 'disabled' : ''}><span class="ico">${I[ic]}</span><div class="grow">${n}<div class="sub">${off ? 'AI のキーを入れると使えます' : sub}</div></div><span class="chev">${I.chev}</span></button>`;
        }).join('')}</div>
        ${ai ? '' : '<div class="section-foot">「設定」で AI（Gemini・Claude）のキーを入れると、おすすめの観光・食事や、自由な相談もできます。</div>'}
        <div id="as-prog" style="margin-top:12px"></div>`;
      const go = (p) => {
        haptic();
        const pr = PRESETS.find((x) => x[0] === p);
        const text = pr ? pr[4] : q.trim();
        if (!text) return;
        $$('button', body).forEach((b) => { b.disabled = true; });
        ask(trip, { key: p, label: pr ? pr[1] : q.trim(), text, local: !aiOn() }, $('#as-prog', body))
          .then((res) => { if (res) { close(); setTimeout(() => reviewOps(trip, res), 300); } })
          .finally(() => { $$('button', body).forEach((b) => { if (!b.classList.contains('off')) b.disabled = false; }); const g = $('#as-go', body); if (g) g.disabled = !q.trim(); });
      };
      $$('[data-p]', body).forEach((b) => b.onclick = () => go(b.dataset.p));
      const ta = $('#as-q', body);
      if (ta) {
        ta.oninput = () => { q = ta.value; $('#as-go', body).disabled = !q.trim(); };
        $('#as-go', body).onclick = () => go('');
      }
      if (preset) setTimeout(() => go(preset), 350);
      else if (ta && !trip.items.length) setTimeout(() => ta.focus(), 450);
    },
  });
}

// 相談する（AI、または端末の中で）→ { summary, ops }
async function ask(trip, { key, label, text, local }, prog) {
  prog.innerHTML = `<div class="as-wait"><span class="spinner"></span><div><b>${esc(label)}</b><span>${local ? '旅程を調べています…' : `${esc(aiName())} が考えています…（10〜40秒ほど）`}</span></div></div>`;
  prog.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    const res = local ? localOps(trip, key) : await aiOps(trip, text);
    res.ops = sanitize(trip, res.ops || []);
    if (!res.ops.length) {
      prog.innerHTML = `<div class="as-none">${I.check}<div><b>直す所は見つかりませんでした</b><span>${esc(res.summary || 'いまの旅程のままで大丈夫そうです。')}</span></div></div>`;
      return null;
    }
    return { ...res, label };
  } catch (e) {
    console.error(e);
    prog.innerHTML = `<div class="small" style="color:var(--red)">${esc(friendlyError(e))}</div>`;
    return null;
  }
}

async function aiOps(trip, text) {
  const chk = checkTrip(trip);
  const notes = [
    ...chk.issues.map((x) => `- ${x.title}：${x.detail || ''}`),
    ...[...chk.slots.values()].flat().map((s) => s.kind === 'hotel' ? `- ${mdw(s.start)}の夜の宿が未定（${s.place || '場所不明'}）` : `- ${s.from} → ${s.to} の移動が抜けているかも（${hm(s.start)}ごろ）`),
  ];
  const content = [{ type: 'text', text: [
    todayText(),
    `旅の名前：${trip.name || '旅'}`,
    `旅の日付：${tripRange(trip)}`,
    `いまの旅程（JSON）：\n${JSON.stringify(tripJSON(trip))}`,
    notes.length ? `アプリのチェックで見つかったこと：\n${notes.join('\n')}` : '',
    `頼みごと：${text}`,
  ].filter(Boolean).join('\n\n') }];
  return callAI({ system: SYSTEM, content, schema: OPS_SCHEMA, effort: 'medium' });
}

// ===== 端末の中でつくる提案（旅程チェックの直し方を写しの旅程で試し、違いを提案にする） =====
function localOps(trip, key) {
  const copy = structuredClone(trip);
  const reasons = new Map();
  const note = (id, r) => { if (!reasons.has(id)) reasons.set(id, r); };
  if (key === 'tidy') {
    for (let k = 0; k < 6; k++) {
      const fx = checkTrip(copy).issues.filter((x) => x.fix && x.key !== 'return');
      if (!fx.length) break;
      const x = fx[0];
      const before = JSON.stringify(copy.items);
      x.fix.run();
      if (JSON.stringify(copy.items) === before) break;
      for (const it of copy.items) if (JSON.stringify(it) !== JSON.stringify(trip.items.find((o) => o.id === it.id))) note(it.id, x.title);
    }
    autoFix(copy);
    // 中身が同じ予定の重なり（取り込みの二重など）は後ろを削除
    const seen = new Map();
    for (const it of [...copy.items]) {
      const k = `${it.type}|${it.start}|${(it.title || '').replace(/\s/g, '')}|${it.from || ''}`;
      if (it.start && seen.has(k) && !it.reserved) { copy.items = copy.items.filter((x) => x !== it); note(it.id, `「${seen.get(k)}」と同じ予定です`); }
      else seen.set(k, it.title || TYPES[it.type]?.name || '予定');
    }
  } else if (key === 'gaps') {
    for (const sl of [...checkTrip(copy).slots.values()].flat()) {
      const it = sl.kind === 'hotel'
        ? { id: uid(), type: 'hotel', title: sl.place ? `${sl.place}周辺の宿` : '宿', address: sl.place || '', start: toLocalISO(sl.start), end: toLocalISO(sl.end), notes: '目安・要確認', reserved: false }
        : { id: uid(), type: sl.type, title: `${TYPES[sl.type]?.name || '移動'}で移動`, from: sl.from || '', to: sl.to || '', start: toLocalISO(new Date(sl.start)), end: toLocalISO(new Date(new Date(sl.start).getTime() + (sl.est || 60) * 60000)), notes: '時刻は目安・要確認', reserved: false };
      copy.items.push(it);
      note(it.id, sl.kind === 'hotel' ? 'この夜の宿が決まっていません' : `${sl.from} と ${sl.to} の間の移動がありません`);
    }
  } else if (key === 'return') {
    const r = checkTrip(copy).issues.find((x) => x.key === 'return');
    if (r?.fix) { const n0 = copy.items.length; r.fix.run(); for (const it of copy.items.slice(n0)) note(it.id, '行きの移動を逆にした帰り（時刻は目安）'); }
  }
  const ops = [];
  for (const it of copy.items) {
    const o = trip.items.find((x) => x.id === it.id);
    if (!o) ops.push({ op: 'add', id: '', reason: reasons.get(it.id) || '', item: it });
    else if (JSON.stringify(o) !== JSON.stringify(it)) ops.push({ op: 'update', id: it.id, reason: reasons.get(it.id) || '流れに合わせて時刻を直します', item: it });
  }
  for (const o of trip.items) if (!copy.items.some((x) => x.id === o.id)) ops.push({ op: 'delete', id: o.id, reason: reasons.get(o.id) || '', item: o });
  const sum = { tidy: '順番と時刻の矛盾を直す提案です。', gaps: '抜けている移動・宿の入力枠を追加します。内容はあとで直せます。', return: '行きを逆にして帰りの移動をつくります。' }[key] || '';
  return { summary: ops.length ? sum : '', ops };
}

// AI の答えを確かめて、使えるものだけにする
const KEYS = ['type', 'title', 'from', 'to', 'start', 'end', 'address', 'notes', 'cost'];
function sanitize(trip, ops) {
  const out = [];
  for (const o of ops) {
    const cur = o.id ? trip.items.find((x) => x.id === o.id) : null;
    if ((o.op === 'update' || o.op === 'delete') && !cur) continue;
    const it = {};
    for (const k of KEYS) it[k] = String(o.item?.[k] ?? '').trim();
    if (!TYPES[it.type]) it.type = cur?.type || 'activity';
    for (const k of ['start', 'end']) if (it[k] && !parseLocal(it[k])) it[k] = cur?.[k] || '';
    if (o.op === 'add') {
      if (!it.title && !it.from && !it.to) continue;
      out.push({ op: 'add', reason: o.reason || '', item: it, on: true });
    } else if (o.op === 'update') {
      // 実際に変わる項目だけ（空で返ってきた項目は今のまま）
      const ch = KEYS.filter((k) => it[k] && it[k] !== (cur[k] || '') && !(k === 'notes' && String(cur.notes || '').startsWith(it.notes.slice(0, 20))));
      if (!ch.length) continue;
      out.push({ op: 'update', id: cur.id, reason: o.reason || '', item: it, ch, on: !cur.reserved || /推定|目安/.test(cur.notes || '') || !ch.some((k) => k === 'start' || k === 'end') });
    } else if (o.op === 'delete') {
      out.push({ op: 'delete', id: cur.id, reason: o.reason || '', on: !cur.reserved });
    }
  }
  return out;
}

// ===== 提案の確認と反映 =====
const LABEL = Object.fromEntries([...FIELDS, ['notes', 'メモ']]);
const when = (it) => { const s = parseLocal(it.start), e = parseLocal(it.end); return s ? `${mdw(s)} ${hm(s)}${e ? `〜${dayKey(e) !== dayKey(s) ? mdw(e) + ' ' : ''}${hm(e)}` : ''}` : '日時未定'; };
const fmt = (k, v) => (k === 'type' ? TYPES[v]?.name || v : (k === 'start' || k === 'end') && parseLocal(v) ? `${parseLocal(v).getMonth() + 1}/${parseLocal(v).getDate()} ${hm(parseLocal(v))}` : v || '—');

export function reviewOps(trip, { summary = '', ops, label = '' }) {
  ops.sort((a, b) => ((a.item || trip.items.find((x) => x.id === a.id))?.start || '9').localeCompare((b.item || trip.items.find((x) => x.id === b.id))?.start || '9'));
  sheet({
    title: '提案', right: '反映する',
    onRight: (body, close) => {
      const use = ops.filter((o) => o.on);
      if (!use.length) { toast('反映する提案を選んでください'); return false; }
      let first = null;
      undoable(trip, `${use.length}件の提案を反映しました`, () => {
        for (const o of use) {
          if (o.op === 'add') { const it = { id: uid(), ...o.item, reserved: false, remind: 30 }; trip.items.push(it); first ??= it.id; }
          else if (o.op === 'update') { const it = trip.items.find((x) => x.id === o.id); if (it) { for (const k of o.ch) it[k] = o.item[k]; first ??= it.id; } }
          else trip.items = trip.items.filter((x) => x.id !== o.id);
        }
        autoFix(trip);
        if (first) flashNext(first);
      }, renderTrip);
      haptic(); close();
      document.querySelector('#tabbar [data-tab="trip"]')?.click();
      return true;
    },
    build(body) {
      const draw = () => {
        const n = (k) => ops.filter((o) => o.op === k).length;
        body.innerHTML = `
          <div class="as-sum"><span class="as-ico">${I.sparkles}</span><div><b>${esc(label || '提案')}</b><span>${esc(summary || '')}</span></div></div>
          <div class="rv-summary">
            ${n('add') ? `<div><b style="color:var(--green)">${n('add')}</b><span>追加</span></div>` : ''}
            ${n('update') ? `<div><b style="color:var(--blue)">${n('update')}</b><span>変更</span></div>` : ''}
            ${n('delete') ? `<div><b style="color:var(--red)">${n('delete')}</b><span>削除</span></div>` : ''}
          </div>
          <div class="section-foot" style="margin:0 4px 10px">使う提案にチェックを入れて「反映する」を押してください。追加する予定はタップで直せます。</div>
          ${ops.map((o, i) => {
            const cur = o.id && trip.items.find((x) => x.id === o.id);
            const it = o.op === 'add' ? o.item : cur;
            const T = TYPES[it.type] || TYPES.other;
            const tag = { add: ['追加', 'ok'], update: ['変更', 'info'], delete: ['削除', 'ng'] }[o.op];
            return `<div class="ev rv-card op-${o.op} ${o.on ? '' : 'off'}" style="--c:${T.color};--i:${Math.min(i, 12)}" data-i="${i}">
              <div class="top"><button class="check ${o.on ? 'on' : ''}" data-chk aria-label="使う">${o.on ? I.check : ''}</button><div class="type-ico">${I[T.icon]}</div><div class="title">${esc(it.title || T.name)}</div><span class="badge ${tag[1]}">${tag[0]}</span></div>
              <div class="small muted rv-line">${esc(when(it))}${TRANSPORT.has(it.type) && (it.from || it.to) ? `　${esc(it.from || '')} → ${esc(it.to || '')}` : it.address ? `　${esc(it.address)}` : ''}${cur?.reserved ? '　<b style="color:var(--green)">予約済み</b>' : ''}</div>
              ${o.op === 'update' ? `<div class="pick-diff">${o.ch.map((k) => `<div class="pick-row"><span>${LABEL[k] || k}</span><s>${esc(fmt(k, cur[k]))}</s> → <b>${esc(fmt(k, o.item[k]))}</b></div>`).join('')}</div>` : ''}
              ${o.op === 'add' && o.item.notes ? `<div class="small muted" style="margin-top:2px">${esc(o.item.notes)}</div>` : ''}
              ${o.reason ? `<div class="op-why">${I.info}<span>${esc(o.reason)}</span></div>` : ''}
              ${o.op === 'add' ? `<button class="link-btn small" data-edit>${I.edit} 直す</button>` : ''}
            </div>`;
          }).join('')}`;
        $$('[data-chk]', body).forEach((b) => b.onclick = () => { const o = ops[+b.closest('[data-i]').dataset.i]; o.on = !o.on; haptic(); draw(); });
        $$('[data-edit]', body).forEach((b) => b.onclick = () => {
          const o = ops[+b.closest('[data-i]').dataset.i];
          editItem({ id: uid(), ...o.item, reserved: false }, { onSave: (nv) => { for (const k of KEYS) o.item[k] = nv[k] || ''; o.on = true; draw(); } });
        });
      };
      draw();
    },
  });
}

// 取り込みのあとの入口など、ほかの画面から相談を始める
export const assistOrCapture = () => (currentTrip()?.items.length || aiOn() ? openAssist() : openCapture());
