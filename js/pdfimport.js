// PDF の旅程表を読む（文字がそのまま入っている PDF なら、読み間違いがない）
//  ・pdf.js で、文字と「ページの上の位置」を取り出す
//  ・位置から表の行（時刻・内容・補足・分類）を組み立て直して、旅程表として読む
//  ・文字が入っていない PDF（スキャンした紙など）は、ページを画像にして文字読み取りに回す
import { layoutLines } from './schedule.js';

const DIR = 'vendor/pdfjs/';
const MAX_PAGES = 30;
let loading = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { s.remove(); rej(new Error('PDFを読む部品を読み込めませんでした（通信を確認してください）')); };
    document.head.append(s);
  });
}
// 読む処理は画面と同じ所で動かす（先に worker を読んでおくと、pdf.js はそれを使う）
function pdfjs() {
  if (window.pdfjsLib && window.pdfjsWorker) return Promise.resolve(window.pdfjsLib);
  loading ??= loadScript(DIR + 'pdf.worker.min.js')
    .then(() => loadScript(DIR + 'pdf.min.js'))
    .then(() => { if (!window.pdfjsLib) throw new Error('PDFを読む部品が見つかりません'); return window.pdfjsLib; })
    .catch((e) => { loading = null; throw e; });
  return loading;
}

export const isPdf = (f) => f && (/pdf/i.test(f.type || '') || /\.pdf$/i.test(f.name || ''));

// PDF → { text: 読む順の文字, pages: ページ数, scanned: 文字が無かった（画像だけ）, images: 文字が無い時のページ画像 }
export async function readPdf(file, onProg) {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data, cMapUrl: DIR + 'cmaps/', cMapPacked: true, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  let chars = 0;
  const n = Math.min(doc.numPages, MAX_PAGES);
  try {
    for (let i = 1; i <= n; i++) {
      onProg?.((i - 1) / n);
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      const items = [];
      for (const t of tc.items) {
        if (!t || typeof t.str !== 'string' || !t.str.trim() || !t.transform) continue;
        const h = Math.abs(t.transform[3]) || Math.abs(t.height) || 8;
        // pdf.js の y は下から。上からに直す
        items.push({ s: t.str, x: t.transform[4], y: vp.height - t.transform[5] - h, w: t.width || t.str.length * h, h });
        chars += t.str.trim().length;
      }
      pages.push({ w: vp.width, h: vp.height, items, page: pg, vp });
    }
    // 文字がほとんど無い（スキャンした紙など）→ ページを画像にする
    if (chars < 20) {
      const images = [];
      for (const p of pages) {
        const scale = Math.min(3, 2200 / Math.max(p.vp.width, p.vp.height));
        const v = p.page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.round(v.width); c.height = Math.round(v.height);
        await p.page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        images.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92)));
      }
      return { text: '', pages: pages.length, scanned: true, images };
    }
    onProg?.(1);
    return { text: layoutLines(pages.map(({ w, h, items }) => ({ w, h, items }))), pages: pages.length, scanned: false, images: [] };
  } finally {
    try { doc.destroy(); } catch {}
  }
}

// PDF の1ページ目を画像にする（予定に付けて、あとで見返せるように）
export async function pdfThumb(file, maxSide = 1400) {
  try {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: DIR + 'cmaps/', cMapPacked: true, isEvalSupported: false, disableFontFace: true }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
      const pg = await doc.getPage(i);
      const vp0 = pg.getViewport({ scale: 1 });
      const v = pg.getViewport({ scale: maxSide / Math.max(vp0.width, vp0.height) });
      const c = document.createElement('canvas');
      c.width = Math.round(v.width); c.height = Math.round(v.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
      out.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85)));
    }
    doc.destroy();
    return out;
  } catch { return []; }
}
