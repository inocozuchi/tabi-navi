// 旅のしおり：旅程・宿・持ち物・メモ・費用から、印刷やPDF保存に向いたページを自動でつくる
import { $, $$, esc, store, page, toast, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, yen, download, WD } from './util.js';
import { currentTrip, events } from './trip.js';
import { tripCosts } from './tools.js';
import { pdfFromJpegs } from './pdfmake.js';

const THEMES = {
  ocean: { name: '海', a: '#0A6CFF', b: '#33C3F0', ink: '#0B2545', soft: '#EAF4FF', emoji: '🌊' },
  sakura: { name: '桜', a: '#E8557A', b: '#F7A8C0', ink: '#4A1D2C', soft: '#FDEFF3', emoji: '🌸' },
  forest: { name: '森', a: '#2E8B57', b: '#9BD18B', ink: '#173A26', soft: '#EEF7EA', emoji: '🌿' },
  sunset: { name: '夕焼け', a: '#F26B38', b: '#F9C74F', ink: '#4A2310', soft: '#FFF3E6', emoji: '🌅' },
  mono: { name: 'モノクロ', a: '#222222', b: '#888888', ink: '#111111', soft: '#F2F2F2', emoji: '✈️' },
};

export function openShiori() {
  const t = currentTrip();
  if (!t?.items.length) { toast('旅程に予定を入れてから作れます'); return; }
  let theme = localStorage.getItem('tabinavi.shiori') || 'ocean';
  const opts = { packing: true, memos: true, costs: true, wish: false, alts: true, notes: true };
  page({
    title: '旅のしおり',
    build(body) {
      let pdf = null, seq = 0;
      const fname = () => `${(t.name || '旅').replace(/[\\/:*?"<>|]/g, '')}_旅のしおり.pdf`;
      // PDF を共有（iPhone の共有シートから「プリント」「"ファイル"に保存」「AirDrop」などを選べる）
      const share = async () => {
        if (!pdf) return;
        const file = new File([pdf], fname(), { type: 'application/pdf' });
        try {
          if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `${t.name} 旅のしおり` }); return; }
        } catch (e) { if (e?.name === 'AbortError') return; }
        save();
      };
      const save = () => {
        if (!pdf) return;
        const url = URL.createObjectURL(pdf);
        const a = document.createElement('a'); a.href = url; a.download = fname(); document.body.append(a); a.click(); setTimeout(() => a.remove(), 1000);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        toast('PDFを書き出しました');
      };
      const make = async () => {
        const my = ++seq;
        const box = $('#sh-pages', body), st = $('#sh-state', body);
        st.innerHTML = '<span class="spinner"></span> つくっています…';
        $$('#sh-share, #sh-save', body).forEach((x) => { x.disabled = true; });
        await new Promise((r) => setTimeout(r, 30));
        try {
          const r = await shioriPdf(t, THEMES[theme], opts);
          if (my !== seq) return;
          pdf = r.blob;
          box.innerHTML = '';
          r.pages.forEach((c, i) => { const im = new Image(); im.src = c.toDataURL('image/jpeg', 0.8); im.alt = `${i + 1}ページ`; im.className = 'sh-page'; im.style.animationDelay = `${Math.min(i, 5) * 40}ms`; box.append(im); });
          st.textContent = `A4・${r.pages.length}ページ・${Math.max(1, Math.round(pdf.size / 1024))}KB`;
          $$('#sh-share, #sh-save', body).forEach((x) => { x.disabled = false; });
        } catch (e) { console.error(e); st.textContent = 'つくれませんでした'; }
      };
      const draw = () => {
        body.innerHTML = `
          <div class="chips">${Object.entries(THEMES).map(([k, v]) => `<button class="chip ${k === theme ? 'on' : ''}" data-th="${k}">${v.emoji} ${v.name}</button>`).join('')}</div>
          <div class="chips">${[['alts', '予備ルート'], ['notes', '予定のメモ'], ['packing', '持ち物'], ['memos', 'メモ'], ['costs', '費用'], ['wish', '行きたいリスト']].map(([k, n]) => `<button class="chip ${opts[k] ? 'on' : ''}" data-op="${k}">${opts[k] ? '✓ ' : ''}${n}</button>`).join('')}</div>
          <div class="sh-actions"><button class="btn" id="sh-share" disabled>${I.share}PDFを共有・印刷</button><button class="btn secondary" id="sh-save" disabled>${I.download}PDFを保存</button></div>
          <div class="section-foot" style="margin:0 4px 10px">「共有・印刷」で出る画面の<b>「プリント」</b>で印刷、<b>「"ファイル"に保存」</b>でPDFとして保存できます。</div>
          <div class="sh-state" id="sh-state"></div>
          <div class="sh-pages" id="sh-pages"></div>`;
        $$('[data-th]', body).forEach((b) => b.onclick = () => { theme = b.dataset.th; localStorage.setItem('tabinavi.shiori', theme); draw(); });
        $$('[data-op]', body).forEach((b) => b.onclick = () => { opts[b.dataset.op] = !opts[b.dataset.op]; draw(); });
        $('#sh-share', body).onclick = share;
        $('#sh-save', body).onclick = save;
        make();
      };
      draw();
    },
  });
}

function build(t, th, o) {
  const evs = events(t).filter((e) => e.at);
  const first = evs[0]?.at, last = evs[evs.length - 1]?.at;
  const nights = first && last ? Math.round((new Date(last.getFullYear(), last.getMonth(), last.getDate()) - new Date(first.getFullYear(), first.getMonth(), first.getDate())) / 864e5) : 0;
  const hotels = t.items.filter((i) => i.type === 'hotel');
  const places = [...new Set(t.items.flatMap((i) => (TRANSPORT.has(i.type) ? [i.to] : [])).filter(Boolean))].slice(0, 6);
  const days = {};
  for (const e of evs) (days[dayKey(e.at)] ??= []).push(e);
  const { by, planned, spent } = tripCosts(t);
  const resv = t.items.filter((i) => i.reserved).length;
  const dateRange = first ? `${first.getFullYear()}.${first.getMonth() + 1}.${first.getDate()}（${WD[first.getDay()]}）${last && dayKey(last) !== dayKey(first) ? ` – ${last.getMonth() + 1}.${last.getDate()}（${WD[last.getDay()]}）` : ''}` : '';

  const row = (e) => {
    const it = e.it, T = TYPES[it.type] || TYPES.other;
    const title = it.type === 'hotel' ? `${e.kind === 'out' ? 'チェックアウト' : 'チェックイン'}　${esc(it.title || '宿')}` : esc(it.title || T.name);
    const details = [];
    if (e.kind !== 'out') {
      if (TRANSPORT.has(it.type) && (it.from || it.to)) details.push(`${esc(it.from || '')} → ${esc(it.to || '')}${e.end && +e.end !== +e.at ? `（着 ${hm(e.end)}）` : ''}`);
      if (it.address && !TRANSPORT.has(it.type)) details.push(`📍 ${esc(it.address)}`);
      const chips = [it.platform, it.seat && `座席 ${it.seat}`, it.room, it.confirmation && `予約番号 ${it.confirmation}`, it.cost, it.phone && `☎ ${it.phone}`].filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
      if (chips) details.push(chips);
      if (o.notes && it.notes) details.push(`<span class="note">${esc(it.notes).replace(/\n/g, '<br>')}</span>`);
      if (o.alts && it.alternates?.length) details.push(it.alternates.map((a) => `<div class="alt">↺ ${esc(a.name || '予備ルート')}：${a.legs.map((l) => `${hm(parseLocal(l.start))} ${esc(l.from || '')}→${esc(l.to || '')} ${esc(l.title || '')}`).join(' ／ ')}</div>`).join(''));
    }
    return `<tr><td class="tm">${hm(e.at)}</td><td class="ic"><span style="background:${T.color}">${typeEmoji(it.type)}</span></td><td><div class="tt">${title} ${it.reserved ? '<span class="ok">予約済</span>' : '<span class="ng">未予約</span>'}</div>${details.map((d) => `<div class="dt">${d}</div>`).join('')}</td><td class="ck">☐</td></tr>`;
  };

  const dayPages = Object.entries(days).map(([k, list], i) => {
    const d = parseLocal(k);
    return `<section class="day"><div class="dayhead"><div class="num">DAY ${i + 1}</div><div class="date">${d.getMonth() + 1}月${d.getDate()}日 <small>${WD[d.getDay()]}曜日</small></div></div>
      <table class="tl">${list.map(row).join('')}</table></section>`;
  }).join('');

  const memos = store.data.memos.filter((m) => m.text);
  const pack = store.data.checklist || [];
  const wish = store.data.wishlist.filter((w) => !w.done);

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.name)} 旅のしおり</title>
<style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; color: ${th.ink}; background: #fff; font-size: 12.5px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.wrap { max-width: 760px; margin: 0 auto; padding: 18px; }
.cover { position: relative; overflow: hidden; border-radius: 22px; padding: 46px 30px 34px; color: #fff; background: linear-gradient(135deg, ${th.a}, ${th.b}); min-height: 330px; display: flex; flex-direction: column; justify-content: flex-end; page-break-after: always; }
.cover .big { position: absolute; right: -10px; top: -30px; font-size: 220px; opacity: .18; }
.cover .lbl { letter-spacing: .4em; font-size: 12px; opacity: .9; }
.cover h1 { font-size: 40px; margin: 6px 0 8px; line-height: 1.15; }
.cover .dr { font-size: 18px; font-weight: 600; }
.cover .pl { margin-top: 14px; display: flex; gap: 6px; flex-wrap: wrap; }
.cover .pl span { background: rgba(255,255,255,.22); border: 1px solid rgba(255,255,255,.4); padding: 3px 10px; border-radius: 20px; font-size: 12px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
.stats div { background: ${th.soft}; border-radius: 14px; padding: 12px; text-align: center; }
.stats b { display: block; font-size: 22px; color: ${th.a}; }
h2 { font-size: 16px; margin: 26px 0 10px; display: flex; align-items: center; gap: 8px; }
h2::before { content: ""; width: 6px; height: 18px; border-radius: 3px; background: ${th.a}; }
.day { page-break-inside: auto; margin-top: 22px; }
.dayhead { display: flex; align-items: baseline; gap: 12px; border-bottom: 2px solid ${th.a}; padding-bottom: 6px; margin-bottom: 8px; }
.dayhead .num { background: ${th.a}; color: #fff; font-weight: 800; letter-spacing: .1em; padding: 3px 10px; border-radius: 8px; font-size: 13px; }
.dayhead .date { font-size: 20px; font-weight: 700; }
.dayhead small { font-size: 12px; font-weight: 500; opacity: .7; }
table.tl { width: 100%; border-collapse: collapse; }
table.tl tr { page-break-inside: avoid; }
table.tl td { vertical-align: top; padding: 8px 6px; border-bottom: 1px dashed #d9d9de; }
td.tm { width: 52px; font-weight: 800; font-size: 14px; font-variant-numeric: tabular-nums; color: ${th.a}; }
td.ic { width: 34px; } td.ic span { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: #fff; font-size: 14px; }
td.ck { width: 22px; font-size: 16px; color: #aaa; }
.tt { font-weight: 700; font-size: 13.5px; }
.dt { margin-top: 3px; color: #444; }
.chip { display: inline-block; background: ${th.soft}; border-radius: 6px; padding: 1px 7px; margin: 0 4px 3px 0; font-size: 11.5px; }
.note { color: #666; font-size: 11.5px; }
.alt { color: #8a5a00; font-size: 11.5px; }
.ok, .ng { font-size: 10.5px; padding: 1px 6px; border-radius: 5px; margin-left: 4px; font-weight: 600; vertical-align: 1px; }
.ok { background: #e3f6e8; color: #1f8a3b; } .ng { background: #fff1de; color: #b36200; }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.card { border: 1px solid #e3e3e8; border-radius: 14px; padding: 12px 14px; page-break-inside: avoid; }
.card b { font-size: 14px; }
.card .s { color: #666; font-size: 11.5px; margin-top: 3px; white-space: pre-wrap; }
.pack { columns: 3; column-gap: 14px; } .pack div { break-inside: avoid; padding: 3px 0; }
.foot { text-align: center; color: #aaa; font-size: 10.5px; margin: 30px 0 10px; }
@media print { .wrap { padding: 0; } .cover { border-radius: 16px; } }
@media (max-width: 520px) { .stats { grid-template-columns: repeat(2, 1fr); } .cards { grid-template-columns: 1fr; } .pack { columns: 2; } .cover h1 { font-size: 30px; } }
</style></head><body><div class="wrap">
<div class="cover"><div class="big">${th.emoji}</div><div class="lbl">TRAVEL GUIDE BOOK</div><h1>${esc(t.name)}</h1><div class="dr">${dateRange}</div>
  ${places.length ? `<div class="pl">${places.map((p) => `<span>${esc(p)}</span>`).join('')}</div>` : ''}</div>
<div class="stats"><div><b>${nights ? `${nights}泊${nights + 1}日` : '日帰り'}</b>日程</div><div><b>${t.items.filter((i) => TRANSPORT.has(i.type)).length}</b>移動</div><div><b>${hotels.length}</b>宿</div><div><b>${resv}/${t.items.length}</b>予約済み</div></div>
<h2>スケジュール</h2>${dayPages}
${hotels.length ? `<h2>宿泊先</h2><div class="cards">${hotels.map((h) => { const s = parseLocal(h.start), e = parseLocal(h.end); return `<div class="card"><b>🛏 ${esc(h.title || '宿')}</b><div class="s">${s ? `IN ${mdw(s)} ${hm(s)}` : ''}${e ? `　OUT ${mdw(e)} ${hm(e)}` : ''}${h.address ? `\n📍 ${esc(h.address)}` : ''}${h.phone ? `\n☎ ${esc(h.phone)}` : ''}${h.confirmation ? `\n予約番号 ${esc(h.confirmation)}` : ''}${h.room ? `\n部屋・ベッド ${esc(h.room)}` : ''}${h.wifi ? `\nWi-Fi ${esc(h.wifi)}` : ''}</div></div>`; }).join('')}</div>` : ''}
${o.costs && (planned || spent) ? `<h2>費用</h2><div class="cards">${Object.entries(by).map(([k, v]) => `<div class="card"><b>${typeEmoji(k)} ${TYPES[k].name}</b><div class="s">${yen(v)}</div></div>`).join('')}${spent ? `<div class="card"><b>💴 旅先で使ったお金</b><div class="s">${yen(spent)}</div></div>` : ''}<div class="card" style="background:${th.soft}"><b>合計</b><div class="s" style="font-size:16px;font-weight:700;color:${th.ink}">${yen(planned + spent)}${store.data.budget.people > 1 ? `（1人 ${yen(Math.ceil((planned + spent) / store.data.budget.people))}）` : ''}</div></div></div>` : ''}
${o.packing && pack.length ? `<h2>持ち物チェック</h2><div class="pack">${pack.map((p) => `<div>${p.done ? '☑' : '☐'} ${esc(p.text)}</div>`).join('')}</div>` : ''}
${o.wish && wish.length ? `<h2>行きたい場所</h2><div class="cards">${wish.map((w) => `<div class="card"><b>${w.star ? '⭐️ ' : ''}${esc(w.name)}</b><div class="s">${esc([w.category, w.area, w.hours, w.price].filter(Boolean).join('・'))}</div></div>`).join('')}</div>` : ''}
${o.memos && memos.length ? `<h2>メモ</h2><div class="cards">${memos.map((m) => `<div class="card"><b>${esc(m.title || 'メモ')}</b><div class="s">${esc(m.text)}</div></div>`).join('')}</div>` : ''}
<div class="foot">旅ナビでつくりました ・ ${new Date().toLocaleDateString('ja-JP')}</div>
</div></body></html>`;
}
function typeEmoji(t) {
  return { shinkansen: '🚄', train: '🚃', subway: '🚇', bus: '🚌', flight: '✈️', ferry: '⛴', taxi: '🚕', walk: '🚶', hotel: '🛏', activity: '⭐️', meal: '🍴', other: '•' }[t] || '•';
}

// ===== A4 のページを絵として描く（これを PDF にする） =====
//  1pt = S px（A4 = 595 × 842 pt）。文字は端末のフォントで描くので、日本語も絵文字もそのまま出る
const S = 2, PW = 595, PH = 842, M = 36;
const FONT = '-apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
export function renderPages(t, th, o) {
  const pages = [];
  let c, g, y;
  const CW = PW - M * 2;
  const newPage = () => {
    c = document.createElement('canvas'); c.width = PW * S; c.height = PH * S;
    g = c.getContext('2d'); g.scale(S, S);
    g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
    g.textBaseline = 'top';
    pages.push(c); y = M;
  };
  const font = (size, w = 400) => { g.font = `${w} ${size}px ${FONT}`; };
  // 文字を幅で折り返す（日本語は1文字ずつ）
  const wrap = (s, w, size, wt = 400) => {
    font(size, wt);
    const out = [];
    for (const para of String(s ?? '').split('\n')) {
      let line = '';
      for (const ch of [...para]) {
        if (g.measureText(line + ch).width > w && line) { out.push(line); line = ch; } else line += ch;
      }
      out.push(line);
    }
    return out;
  };
  const text = (s, x, yy, { size = 10, w = 400, color = '#222', max = CW, lh = 1.45, measure = false } = {}) => {
    const lines = wrap(s, max, size, w);
    if (!measure) { font(size, w); g.fillStyle = color; lines.forEach((l, i) => g.fillText(l, x, yy + i * size * lh)); }
    return lines.length * size * lh;
  };
  const rrect = (x, yy, w, h, r, fill) => { g.beginPath(); g.roundRect ? g.roundRect(x, yy, w, h, r) : g.rect(x, yy, w, h); g.fillStyle = fill; g.fill(); };
  const need = (h) => { if (y + h > PH - M - 18) { newPage(); return true; } return false; };
  const heading = (s) => {
    need(40);
    y += 14;
    rrect(M, y + 2, 4, 14, 2, th.a);
    text(s, M + 10, y, { size: 13, w: 700, color: th.ink });
    y += 26;
  };

  const evs = events(t).filter((e) => e.at);
  const first = evs[0]?.at, last = evs[evs.length - 1]?.at;
  const nights = first && last ? Math.round((new Date(last.getFullYear(), last.getMonth(), last.getDate()) - new Date(first.getFullYear(), first.getMonth(), first.getDate())) / 864e5) : 0;
  const hotels = t.items.filter((i) => i.type === 'hotel');
  const places = [...new Set(t.items.flatMap((i) => (TRANSPORT.has(i.type) ? [i.to] : [])).filter(Boolean))].slice(0, 6);
  const { by, planned, spent } = tripCosts(t);
  const resv = t.items.filter((i) => i.reserved).length;
  const dateRange = first ? `${first.getFullYear()}.${first.getMonth() + 1}.${first.getDate()}（${WD[first.getDay()]}）${last && dayKey(last) !== dayKey(first) ? ` – ${last.getMonth() + 1}.${last.getDate()}（${WD[last.getDay()]}）` : ''}` : '';

  newPage();
  // --- 表紙 ---
  const ch = 230;
  const gr = g.createLinearGradient(M, M, M + CW, M + ch);
  gr.addColorStop(0, th.a); gr.addColorStop(1, th.b);
  rrect(M, y, CW, ch, 18, gr);
  g.save(); g.globalAlpha = .2; font(150); g.fillStyle = '#fff'; g.fillText(th.emoji, M + CW - 150, y - 10); g.restore();
  text('TRAVEL GUIDE BOOK', M + 24, y + 26, { size: 9, w: 600, color: 'rgba(255,255,255,.9)' });
  // 題名は日付のすぐ上に（長い時は折り返して上へのびる）
  const th1 = text(t.name || '旅', 0, 0, { size: 28, w: 800, max: CW - 48, lh: 1.2, measure: true });
  text(t.name || '旅', M + 24, y + ch - 66 - th1, { size: 28, w: 800, color: '#fff', max: CW - 48, lh: 1.2 });
  text(dateRange, M + 24, y + ch - 60, { size: 13, w: 600, color: '#fff' });
  let px = M + 24;
  font(9, 600);
  for (const p of places) { const w = g.measureText(p).width + 16; if (px + w > M + CW - 20) break; rrect(px, y + ch - 34, w, 18, 9, 'rgba(255,255,255,.25)'); text(p, px + 8, y + ch - 30, { size: 9, w: 600, color: '#fff' }); px += w + 6; }
  y += ch + 12;
  // --- 数字 ---
  const stats = [[nights ? `${nights}泊${nights + 1}日` : '日帰り', '日程'], [String(t.items.filter((i) => TRANSPORT.has(i.type)).length), '移動'], [String(hotels.length), '宿'], [`${resv}/${t.items.length}`, '予約済み']];
  const sw = (CW - 18) / 4;
  stats.forEach(([v, l], i) => { const x = M + i * (sw + 6); rrect(x, y, sw, 44, 10, th.soft); g.textAlign = 'center'; text(v, x + sw / 2, y + 7, { size: 15, w: 800, color: th.a, max: sw }); text(l, x + sw / 2, y + 28, { size: 8.5, color: '#666', max: sw }); g.textAlign = 'left'; });
  y += 54;

  // --- スケジュール ---
  heading('スケジュール');
  const days = {};
  for (const e of evs) (days[dayKey(e.at)] ??= []).push(e);
  const dayHead = (k, i, cont) => {
    const d = parseLocal(k);
    font(9, 800); const lw = g.measureText(`DAY ${i + 1}`).width + 14;
    rrect(M, y, lw, 18, 5, th.a); text(`DAY ${i + 1}`, M + 7, y + 4, { size: 9, w: 800, color: '#fff' });
    text(`${d.getMonth() + 1}月${d.getDate()}日 ${WD[d.getDay()]}曜日${cont ? '（つづき）' : ''}`, M + lw + 8, y + 1, { size: 13, w: 700, color: th.ink });
    y += 22; g.fillStyle = th.a; g.fillRect(M, y, CW, 1.5); y += 6;
  };
  Object.entries(days).forEach(([k, list], di) => {
    need(70); y += 6; dayHead(k, di, false);
    for (const e of list) {
      const it = e.it, T = TYPES[it.type] || TYPES.other;
      const title = it.type === 'hotel' ? `${e.kind === 'out' ? 'チェックアウト' : 'チェックイン'}　${it.title || '宿'}` : (it.title || T.name);
      const det = [];
      if (e.kind !== 'out') {
        if (TRANSPORT.has(it.type) && (it.from || it.to)) det.push([`${it.from || ''} → ${it.to || ''}${e.end && +e.end !== +e.at ? `（着 ${hm(e.end)}）` : ''}`, '#333']);
        if (it.address && !TRANSPORT.has(it.type)) det.push([`📍 ${it.address}`, '#555']);
        const chips = [it.platform, it.seat && `座席 ${it.seat}`, it.room, it.confirmation && `予約番号 ${it.confirmation}`, it.cost, it.phone && `☎ ${it.phone}`].filter(Boolean);
        if (chips.length) det.push([chips.join('　'), '#555']);
        if (o.notes && it.notes) det.push([it.notes, '#777']);
        if (o.alts && it.alternates?.length) for (const a of it.alternates) det.push([`↺ ${a.name || '予備ルート'}：${a.legs.map((l) => `${hm(parseLocal(l.start))} ${l.from || ''}→${l.to || ''} ${l.title || ''}`).join(' ／ ')}`, '#8a5a00']);
      }
      const tx = M + 70, tw = CW - 70 - 22;
      const badge = it.reserved ? '予約済' : '';
      let h = text(title + (badge ? '　　　' : ''), tx, 0, { size: 11, w: 700, max: tw, measure: true });
      for (const [s] of det) h += text(s, tx, 0, { size: 9, max: tw, measure: true, lh: 1.4 }) + 1;
      h += 12;
      if (need(h)) dayHead(k, di, true);
      // 時刻・種類・題名・中身・チェック欄
      text(hm(e.at), M, y + 4, { size: 11.5, w: 800, color: th.a });
      rrect(M + 42, y + 2, 18, 18, 5, T.color);
      g.textAlign = 'center'; text(typeEmoji(it.type), M + 51, y + 5, { size: 9.5, color: '#fff', max: 18 }); g.textAlign = 'left';
      let yy = y + 3;
      const th2 = text(title, tx, yy, { size: 11, w: 700, color: th.ink, max: tw });
      if (badge) { font(11, 700); const lines = wrap(title, tw, 11, 700); const lw2 = g.measureText(lines[lines.length - 1]).width; rrect(tx + lw2 + 6, yy + th2 - 15, 34, 13, 4, '#e3f6e8'); text(badge, tx + lw2 + 10, yy + th2 - 13.5, { size: 7.5, w: 700, color: '#1f8a3b' }); }
      yy += th2 + 1;
      for (const [s, col] of det) yy += text(s, tx, yy, { size: 9, color: col, max: tw, lh: 1.4 }) + 1;
      g.strokeStyle = '#bbb'; g.lineWidth = 1; g.strokeRect(M + CW - 12, y + 4, 10, 10);
      y += h;
      g.save(); g.setLineDash([2, 3]); g.strokeStyle = '#d9d9de'; g.beginPath(); g.moveTo(M, y - 5); g.lineTo(M + CW, y - 5); g.stroke(); g.restore();
    }
  });

  // --- カード（宿・費用・メモなど） ---
  const cards = (list) => {
    const cw = (CW - 10) / 2;
    for (let i = 0; i < list.length; i += 2) {
      const pair = list.slice(i, i + 2);
      const hs = pair.map(([tt, s]) => 26 + text(s, 0, 0, { size: 9, max: cw - 24, measure: true, lh: 1.45 }));
      const h = Math.max(...hs);
      need(h + 8);
      pair.forEach(([tt, s, bg], j) => {
        const x = M + j * (cw + 10);
        rrect(x, y, cw, h, 10, bg || '#fff'); g.strokeStyle = '#e3e3e8'; g.lineWidth = 1; g.beginPath(); g.roundRect ? g.roundRect(x, y, cw, h, 10) : g.rect(x, y, cw, h); g.stroke();
        text(tt, x + 12, y + 9, { size: 10.5, w: 700, color: th.ink, max: cw - 24 });
        text(s, x + 12, y + 25, { size: 9, color: '#555', max: cw - 24, lh: 1.45 });
      });
      y += h + 8;
    }
  };
  if (hotels.length) {
    heading('宿泊先');
    cards(hotels.map((h) => { const s = parseLocal(h.start), e = parseLocal(h.end); return [`🛏 ${h.title || '宿'}`, [s && `IN ${mdw(s)} ${hm(s)}`, e && `OUT ${mdw(e)} ${hm(e)}`, h.address && `📍 ${h.address}`, h.phone && `☎ ${h.phone}`, h.confirmation && `予約番号 ${h.confirmation}`, h.room && `部屋・ベッド ${h.room}`, h.wifi && `Wi-Fi ${h.wifi}`].filter(Boolean).join('\n')]; }));
  }
  if (o.costs && (planned || spent)) {
    heading('費用');
    const people = store.data.budget?.people || 1;
    cards([...Object.entries(by).map(([k, v]) => [`${typeEmoji(k)} ${TYPES[k]?.name || k}`, yen(v)]), ...(spent ? [['💴 旅先で使ったお金', yen(spent)]] : []), ['合計', `${yen(planned + spent)}${people > 1 ? `（1人 ${yen(Math.ceil((planned + spent) / people))}）` : ''}`, th.soft]]);
  }
  const pack = store.data.checklist || [];
  if (o.packing && pack.length) {
    heading('持ち物チェック');
    const colW = CW / 3;
    for (let i = 0; i < pack.length; i += 3) {
      need(16);
      pack.slice(i, i + 3).forEach((p, j) => text(`${p.done ? '☑' : '☐'} ${p.text}`, M + j * colW, y, { size: 9.5, max: colW - 8 }));
      y += 16;
    }
  }
  const wish = (store.data.wishlist || []).filter((w) => !w.done);
  if (o.wish && wish.length) { heading('行きたい場所'); cards(wish.map((w) => [`${w.star ? '⭐️ ' : ''}${w.name}`, [w.category, w.area, w.hours, w.price].filter(Boolean).join('・') || ' '])); }
  const memos = (store.data.memos || []).filter((m) => m.text);
  if (o.memos && memos.length) { heading('メモ'); cards(memos.map((m) => [m.title || 'メモ', m.text])); }

  // --- ページ番号 ---
  pages.forEach((pc, i) => {
    const gg = pc.getContext('2d');
    gg.save(); gg.setTransform(S, 0, 0, S, 0, 0);
    gg.font = `400 7.5px ${FONT}`; gg.fillStyle = '#aaa'; gg.textAlign = 'center'; gg.textBaseline = 'alphabetic';
    gg.fillText(`${t.name || '旅'} ・ 旅のしおり ・ ${i + 1} / ${pages.length}`, PW / 2, PH - 16);
    gg.restore();
  });
  return pages;
}

// ページの絵 → PDF のファイル
export async function shioriPdf(t, th, o) {
  const pages = renderPages(t, th, o);
  const jpgs = [];
  for (const c of pages) {
    const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    jpgs.push({ bytes: new Uint8Array(await b.arrayBuffer()), w: c.width, h: c.height });
  }
  return { blob: pdfFromJpegs(jpgs), pages };
}
