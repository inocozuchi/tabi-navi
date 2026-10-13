// 画像（JPEG）のページを並べただけの PDF をつくる（外の部品なし・通信なしで動く）
//  pages: [{ bytes: Uint8Array(JPEG), w: 画像の幅px, h: 画像の高さpx }]
//  用紙は A4（595.28 × 841.89 pt）
export function pdfFromJpegs(pages, pw = 595.28, ph = 841.89) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // 1: カタログ 2: ページの一覧 そのあと 1ページにつき（ページ・中身・画像）の3つ
  const pageId = (i) => 3 + i * 3, contId = (i) => 4 + i * 3, imgId = (i) => 5 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  pages.forEach((p, i) => {
    obj(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${imgId(i)} 0 R >> >> /Contents ${contId(i)} 0 R >>`);
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(contId(i), [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(imgId(i), [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`, p.bytes, '\nendstream']);
  });
  const xref = len;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}
