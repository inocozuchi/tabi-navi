// 旅のしおり：旅程・宿・持ち物・メモ・費用から、印刷やPDF保存に向いたページを自動でつくる
import { $, $$, esc, store, page, toast, I, TYPES, TRANSPORT, parseLocal, hm, mdw, dayKey, yen, download, WD } from './util.js';
import { currentTrip, events } from './trip.js';
import { tripCosts } from './tools.js';

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
      const draw = () => {
        body.innerHTML = `
          <div class="chips">${Object.entries(THEMES).map(([k, v]) => `<button class="chip ${k === theme ? 'on' : ''}" data-th="${k}">${v.emoji} ${v.name}</button>`).join('')}</div>
          <div class="chips">${[['alts', '予備ルート'], ['notes', '予定のメモ'], ['packing', '持ち物'], ['memos', 'メモ'], ['costs', '費用'], ['wish', '行きたいリスト']].map(([k, n]) => `<button class="chip ${opts[k] ? 'on' : ''}" data-op="${k}">${opts[k] ? '✓ ' : ''}${n}</button>`).join('')}</div>
          <div class="hstack" style="margin-bottom:12px"><button class="btn" id="sh-print" style="flex:1">${I.share}印刷・PDF</button><button class="btn secondary" id="sh-save" style="flex:1">${I.download}ファイル保存</button></div>
          <iframe id="sh-frame" style="width:100%;height:70vh;border:0;border-radius:14px;background:#fff;box-shadow:var(--shadow)"></iframe>
          <div class="section-foot">「印刷・PDFで保存」→ 共有ボタン →「プリント」で印刷できます。プリント画面でプレビューを2本指で広げると PDF として保存・送信できます。</div>`;
        const html = build(t, THEMES[theme], opts);
        const fr = $('#sh-frame', body);
        fr.srcdoc = html;
        $$('[data-th]', body).forEach((b) => b.onclick = () => { theme = b.dataset.th; localStorage.setItem('tabinavi.shiori', theme); draw(); });
        $$('[data-op]', body).forEach((b) => b.onclick = () => { opts[b.dataset.op] = !opts[b.dataset.op]; draw(); });
        $('#sh-print', body).onclick = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { toast('印刷を開けませんでした。「ファイルで保存」をお試しください'); } };
        $('#sh-save', body).onclick = () => download(`${t.name}_旅のしおり.html`, html, 'text/html');
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
