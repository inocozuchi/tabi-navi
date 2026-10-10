// 旅の資料：時刻表・チケット・地図などの写真や PDF を、旅ごとに保存して見る
//  ・ファイルはこの端末の中（IndexedDB）にだけ保存。通信が無くても見られる
//  ・旅仲間との同期には含めない（大きいので）
import { $, $$, esc, uid, store, page, sheet, toast, confirmBox, haptic, I, blobs, shrinkImage, askText } from './util.js';
import { currentTrip, ensureTrip, renderTrip } from './trip.js';
import { isPdf, pdfThumb, renderPdf, pdfPageCount } from './pdfimport.js';

export const DOC_CATS = [
  ['time', '時刻表', 'clock'],
  ['ticket', 'チケット・予約', 'ticket'],
  ['map', '地図・案内', 'pin'],
  ['other', 'その他', 'folder'],
];
const catName = (k) => DOC_CATS.find((c) => c[0] === k)?.[1] || 'その他';
// ファイル名から種類を推測（あとで変えられる）
function guessCat(name) {
  const n = (name || '').toLowerCase();
  if (/時刻|ダイヤ|timetable|時間表|発車/.test(n)) return 'time';
  if (/チケット|ticket|予約|eチケ|搭乗|boarding|乗車券|特急券|reservation|confirm/.test(n)) return 'ticket';
  if (/地図|マップ|map|路線|案内|構内/.test(n)) return 'map';
  return 'other';
}
const sizeText = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1e3))}KB`);
const thumbURLs = new Map();
async function thumbURL(d) {
  if (thumbURLs.has(d.thumb)) return thumbURLs.get(d.thumb);
  const b = d.thumb && (await blobs.get(d.thumb).catch(() => null));
  const u = b ? URL.createObjectURL(b) : '';
  thumbURLs.set(d.thumb, u);
  return u;
}

// 写真・PDF を旅に追加する
export async function addDocs(trip, files, cat = '') {
  let n = 0;
  for (const f of files) {
    const pdf = isPdf(f);
    if (!pdf && !/^image\//.test(f.type || '')) continue;
    const id = uid();
    const key = 'doc:' + id, tkey = 'doct:' + id;
    // 写真は長い辺 2400px まで（文字が読める大きさ）に縮めて保存。PDF はそのまま
    const data = pdf ? f : await shrinkImage(f, 2400, 0.88).catch(() => f);
    await blobs.put(key, data);
    const th = pdf ? (await pdfThumb(f, 480))[0] : await shrinkImage(f, 480, 0.75).catch(() => null);
    if (th) await blobs.put(tkey, th);
    const name = (f.name || '').replace(/\.[a-z0-9]+$/i, '') || (pdf ? 'PDF' : '写真');
    (trip.docs ??= []).unshift({
      id, key, thumb: th ? tkey : '', kind: pdf ? 'pdf' : 'image', name: /^(image|IMG_|clip-)/i.test(name) ? `${catName(cat || guessCat(name))} ${(trip.docs?.length || 0) + 1}` : name,
      cat: cat || guessCat(f.name), size: data.size || f.size || 0, pages: pdf ? await pdfPageCount(f) : 1, added: Date.now(),
    });
    n++;
  }
  store.save();
  return n;
}

// ===== 資料の一覧 =====
export function openDocs() {
  const trip = ensureTrip();
  let cat = 'all';
  page({
    title: '旅の資料',
    right: `<button class="nav-add" aria-label="資料を追加">${I.plus}</button>`,
    onRight: () => $('#dc-file')?.click(),
    build(body) {
      const draw = async () => {
        const docs = trip.docs || [];
        const shown = docs.filter((d) => cat === 'all' || d.cat === cat);
        body.innerHTML = `
          <div class="docs-head"><div class="eyebrow">${esc(trip.name || '旅')}</div><h1>資料</h1><p>時刻表・チケット・地図などの写真や PDF を、この旅にまとめて保存できます。通信が無い所でも見られます。</p></div>
          <label class="drop-wide">${I.plus}<span><b>写真・PDFを追加</b><small>スクショ・カメラで撮った時刻表・PDFのチケットなど</small></span>
            <input type="file" id="dc-file" accept="image/*,application/pdf,.pdf" multiple hidden></label>
          ${docs.length ? `<div class="chips doc-chips">${[['all', 'すべて', docs.length], ...DOC_CATS.map(([k, n]) => [k, n, docs.filter((d) => d.cat === k).length])].filter((c) => c[0] === 'all' || c[2]).map(([k, n, c]) => `<button class="chip ${cat === k ? 'on' : ''}" data-cat="${k}">${n}<span class="cnt">${c}</span></button>`).join('')}</div>` : ''}
          ${shown.length ? `<div class="doc-grid">${shown.map((d, i) => `
            <button class="doc-card" data-doc="${d.id}" style="--i:${Math.min(i, 12)}">
              <div class="doc-th">${d.kind === 'pdf' ? `<span class="doc-kind">PDF${d.pages > 1 ? ` ・${d.pages}ページ` : ''}</span>` : ''}<img alt="" data-th="${d.id}"></div>
              <div class="doc-name">${esc(d.name)}</div>
              <div class="doc-meta">${esc(catName(d.cat))}・${sizeText(d.size)}</div>
            </button>`).join('')}</div>`
            : `<div class="empty-card" style="margin-top:4px"><div class="ec-ico">${I.folder}</div><b>${docs.length ? 'この種類の資料はありません' : 'まだ資料がありません'}</b><span>時刻表の写真、eチケットのPDF、駅の構内図などを入れておくと、旅先ですぐ見られます。</span></div>`}
          ${docs.length ? `<div class="section-foot" style="margin-top:14px">この端末にだけ保存されています（${sizeText(docs.reduce((s, d) => s + (d.size || 0), 0))}）。旅仲間には共有されません。</div>` : ''}`;
        $('#dc-file', body).onchange = async (e) => {
          const fs = [...e.target.files];
          if (!fs.length) return;
          toast('保存しています…');
          const n = await addDocs(trip, fs, cat === 'all' ? '' : cat);
          haptic(); toast(n ? `${n}件を保存しました` : '写真か PDF を選んでください');
          draw(); renderTrip();
        };
        $$('[data-cat]', body).forEach((b) => b.onclick = () => { cat = b.dataset.cat; haptic(); draw(); });
        $$('[data-doc]', body).forEach((b) => b.onclick = () => viewDoc(trip, trip.docs.find((d) => d.id === b.dataset.doc), draw));
        for (const im of $$('[data-th]', body)) {
          const d = docs.find((x) => x.id === im.dataset.th);
          thumbURL(d).then((u) => { if (u) { im.src = u; im.onload = () => im.classList.add('on'); } });
        }
      };
      draw();
    },
  });
}

// ===== 1つの資料を見る（指2本で拡大・2回タップで拡大／戻す） =====
export async function viewDoc(trip, d, after) {
  if (!d) return;
  const urls = [];
  page({
    title: d.name,
    right: `<button class="nav-add" aria-label="その他">${I.dots}</button>`,
    onRight: (body, close) => docMenu(trip, d, close, after),
    onClose: () => { setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 500); },
    async build(body) {
      body.classList.add('viewer-body');
      body.innerHTML = `<div class="viewer"><div class="viewer-inner" style="width:100%"></div></div>
        <div class="viewer-hint">${I.zoom} 指2本で拡大・2回タップで拡大／もどす</div>`;
      const box = $('.viewer', body), inner = $('.viewer-inner', body);
      const blob = await blobs.get(d.key).catch(() => null);
      if (!blob) { inner.innerHTML = '<div class="empty">ファイルが見つかりませんでした</div>'; return; }
      if (d.kind === 'pdf') {
        inner.innerHTML = '<div class="viewer-loading"><span class="spinner"></span> PDFを開いています…</div>';
        try {
          await renderPdf(blob, box.clientWidth || 360, (i, u, total) => {
            urls.push(u);
            if (i === 1) inner.innerHTML = '';
            const im = new Image(); im.src = u; im.className = 'viewer-page'; im.alt = `${i}/${total}ページ`;
            inner.append(im);
          });
        } catch { inner.innerHTML = '<div class="empty">PDFを開けませんでした</div>'; }
      } else {
        const u = URL.createObjectURL(blob); urls.push(u);
        inner.innerHTML = `<img class="viewer-page" src="${u}" alt="">`;
      }
      zoomable(box, inner);
    },
  });
}

// 拡大：中身の幅を変えて、スクロールで動かす（ページ全体の拡大は止めてあるため）
function zoomable(box, inner) {
  let scale = 1, d0 = 0, s0 = 1, cx = 0, cy = 0, lastTap = 0;
  const apply = (s, ox, oy) => {
    const prev = scale;
    scale = Math.min(5, Math.max(1, s));
    const r = box.getBoundingClientRect();
    const px = (ox ?? r.width / 2), py = (oy ?? r.height / 2);
    const fx = (box.scrollLeft + px) / prev, fy = (box.scrollTop + py) / prev;
    inner.style.width = `${scale * 100}%`;
    box.scrollLeft = fx * scale - px; box.scrollTop = fy * scale - py;
  };
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches; d0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); s0 = scale;
      const r = box.getBoundingClientRect(); cx = (a.clientX + b.clientX) / 2 - r.left; cy = (a.clientY + b.clientY) / 2 - r.top;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { const r = box.getBoundingClientRect(); apply(scale > 1.2 ? 1 : 2.5, e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); haptic(); lastTap = 0; }
      else lastTap = now;
    }
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !d0) return;
    e.preventDefault();
    const [a, b] = e.touches;
    apply(s0 * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / d0, cx, cy);
  }, { passive: false });
  box.addEventListener('touchend', () => { d0 = 0; });
  box.addEventListener('dblclick', (e) => { const r = box.getBoundingClientRect(); apply(scale > 1.2 ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top); });
}

// 名前・種類の変更、共有、削除
function docMenu(trip, d, closeViewer, after) {
  sheet({
    title: d.name, left: '閉じる',
    build(body, close) {
      body.innerHTML = `
        <div class="section-title">種類</div>
        <div class="chips wrap">${DOC_CATS.map(([k, n, ic]) => `<button class="chip ${d.cat === k ? 'on' : ''}" data-c="${k}">${I[ic]}${n}</button>`).join('')}</div>
        <div class="list" style="margin-top:8px">
          <button class="row icon-row" data-k="rename"><span class="ico">${I.edit}</span><div class="grow">名前を変える</div><span class="chev">${I.chev}</span></button>
          <button class="row icon-row" data-k="share"><span class="ico">${I.share}</span><div class="grow">共有・ファイルに保存<div class="sub">AirDrop・メッセージ・「ファイル」アプリなど</div></div><span class="chev">${I.chev}</span></button>
          <button class="row icon-row danger" data-k="del"><span class="ico">${I.trash}</span><div class="grow">この資料を削除</div></button>
        </div>`;
      $$('[data-c]', body).forEach((b) => b.onclick = () => { d.cat = b.dataset.c; store.save(); haptic(); $$('[data-c]', body).forEach((x) => x.classList.toggle('on', x === b)); after?.(); });
      $('[data-k="rename"]', body).onclick = async () => {
        close();
        const n = await askText({ title: '資料の名前', value: d.name });
        if (n) { d.name = n; store.save(); const h = document.querySelector('.page:last-of-type .page-head h2'); if (h) h.textContent = n; after?.(); }
      };
      $('[data-k="share"]', body).onclick = async () => {
        const b = await blobs.get(d.key).catch(() => null);
        if (!b) return toast('ファイルが見つかりませんでした');
        const ext = d.kind === 'pdf' ? 'pdf' : (b.type.split('/')[1] || 'jpg');
        const file = new File([b], `${d.name}.${ext}`, { type: b.type || (d.kind === 'pdf' ? 'application/pdf' : 'image/jpeg') });
        try {
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: d.name });
          else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
        } catch {}
      };
      $('[data-k="del"]', body).onclick = async () => {
        if (!(await confirmBox('この資料を削除しますか？', d.name, '削除', { destructive: true }))) return;
        trip.docs = (trip.docs || []).filter((x) => x.id !== d.id);
        store.save();
        await blobs.del(d.key).catch(() => {}); if (d.thumb) await blobs.del(d.thumb).catch(() => {});
        close(); closeViewer(); after?.(); renderTrip(); toast('削除しました');
      };
    },
  });
}

// 旅を消した時に、その旅の資料のファイルも消す
export async function removeTripDocs(trip) {
  for (const d of trip?.docs || []) { await blobs.del(d.key).catch(() => {}); if (d.thumb) await blobs.del(d.thumb).catch(() => {}); }
}

// ホームに出す小さい一覧
export function docsStripHTML(trip) {
  const docs = trip?.docs || [];
  if (!docs.length) return '';
  return `<div class="section-head small"><h3>資料 ${docs.length}件</h3><button class="text-btn" data-act="docs">すべて見る${I.chev}</button></div>
    <div class="doc-strip">${docs.slice(0, 8).map((d) => `<button class="doc-mini" data-act="doc" data-doc="${d.id}"><img alt="" data-dth="${d.id}">${d.kind === 'pdf' ? '<span>PDF</span>' : ''}<b>${esc(d.name)}</b></button>`).join('')}</div>`;
}
export function fillDocThumbs(root, trip) {
  for (const im of $$('[data-dth]', root)) {
    const d = (trip.docs || []).find((x) => x.id === im.dataset.dth);
    if (d) thumbURL(d).then((u) => { if (u) { im.src = u; im.onload = () => im.classList.add('on'); } });
  }
}
