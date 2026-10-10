// 写真・スクショを読み取りやすい形に整える
//  ・縦に長いスクショ（スクロールして撮ったもの）は、文字の行の間（何も無い横の帯）で切り分ける
//    → 縮めすぎて文字がつぶれるのを防ぐ（以前は長い辺を 1568px に縮めていたので、縦長だと文字が読めなかった）
//  ・端末の中の文字読み取り用：白黒にして、ダークモードは白黒反転、コントラストを強める、小さい文字は拡大
//  ・iPhone の画面の大きさの上限（約1,670万画素）を超えないように、少しずつ描く

const MAX_PIXELS = 16_000_000;

export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('画像を開けませんでした（対応していない形式かもしれません）'));
      i.src = url;
    });
    if (img.decode) await img.decode().catch(() => {});
    return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) { URL.revokeObjectURL(url); throw e; }
}

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const toBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像を作れませんでした（大きすぎるかもしれません）'))), type, q));

// 小さく描いて、横一列ごとの「にぎやかさ」（明るさのばらつき）と全体の明るさを調べる
function analyze({ img, w, h }) {
  const aw = Math.min(240, w);
  const s = aw / w;
  const ah = Math.max(1, Math.min(8000, Math.round(h * s)));
  const c = canvas(aw, ah);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, aw, ah);
  const d = g.getImageData(0, 0, aw, ah).data;
  const busy = new Float32Array(ah);
  let sum = 0;
  for (let y = 0; y < ah; y++) {
    let mn = 255, mx = 0, rs = 0;
    for (let x = 0; x < aw; x++) {
      const i = (y * aw + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      rs += l; if (l < mn) mn = l; if (l > mx) mx = l;
    }
    busy[y] = mx - mn;
    sum += rs / aw;
  }
  return { busy, sy: ah / h, mean: sum / ah };
}

// 縦の範囲 [y0, y1) の一覧。できるだけ文字の無い帯で切る（見つからない時は少し重ねて切る）
export function planSlices(an, h, maxH) {
  const out = [];
  let y = 0;
  while (h - y > maxH) {
    const target = y + maxH;
    const lo = y + maxH * 0.55;
    let cut = -1;
    // 下から上へ、静かな行（ばらつきが小さい）が3行以上続く所を探す
    let run = 0;
    for (let ay = Math.floor(target * an.sy); ay >= lo * an.sy; ay--) {
      if (an.busy[ay] < 10) { run++; if (run >= 3) { cut = Math.round((ay + 1) / an.sy); break; } } else run = 0;
    }
    if (cut > y) { out.push([y, cut]); y = cut; }
    else { out.push([y, target]); y = Math.round(target - maxH * 0.08); }
  }
  out.push([y, h]);
  return out;
}

// ===== AI（Claude）に送る用 =====
// 1枚あたり長い辺 1568px まで（Claude がそれ以上は縮めてしまうため）。縦横比が 1:2 を超える時は切り分ける。
export async function prepForAI(file, { maxSide = 1568, ratio = 2 } = {}) {
  const im = await loadImage(file);
  try {
    const { img, w, h } = im;
    let ranges = [[0, h]];
    if (h > w * (ratio + 0.3)) ranges = planSlices(analyze(im), h, w * ratio);
    const tiles = [];
    for (const [y0, y1] of ranges) {
      const th = y1 - y0;
      const s = Math.min(1, maxSide / Math.max(w, th));
      const c = canvas(w * s, th * s);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, y0, w, th, 0, 0, c.width, c.height);
      tiles.push(await toBlob(c, 'image/jpeg', 0.9));
    }
    return { tiles, view: await viewImage(im) };
  } finally { im.done(); }
}

// 予定に付けて保存する画像（見る用）。縦長でも文字が読めるように、幅を基準に縮める
export async function makeView(file) {
  const im = await loadImage(file);
  try { return await viewImage(im); } finally { im.done(); }
}
async function viewImage({ img, w, h }) {
  const s = Math.min(1, 1170 / w, Math.sqrt(6_000_000 / (w * h)));
  const c = canvas(w * s, h * s);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return toBlob(c, 'image/jpeg', 0.82);
}

// ===== 端末の中の文字読み取り（Tesseract）用 =====
// 文字の高さが 20〜40px くらいだとよく読めるので、幅 1400〜2200px に合わせる
export async function prepForOCR(file) {
  const im = await loadImage(file);
  try {
    const { img, w, h } = im;
    const s = w < 1000 ? Math.min(2.5, 1600 / w) : Math.min(1, 2200 / w);
    const maxOutH = Math.min(3200, MAX_PIXELS / 4 / (w * s));
    const an = analyze(im);
    const ranges = h * s > maxOutH ? planSlices(an, h, maxOutH / s) : [[0, h]];
    const out = [];
    for (const [y0, y1] of ranges) {
      const th = y1 - y0;
      const c = canvas(w * s, th * s);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, y0, w, th, 0, 0, c.width, c.height);
      enhance(g, c.width, c.height);
      out.push(await toBlob(c, 'image/png'));
    }
    return out;
  } finally { im.done(); }
}

// 白黒にする。場所ごとに背景の明るさを見て、暗い所（色付きの表のます・ダークモード）は反転してから、
// まわりより暗い所を文字（黒）、それ以外を白にする（色付きの表でも白い字が読めるように）
function enhance(g, w, h) {
  const id = g.getImageData(0, 0, w, h);
  const d = id.data;
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) L[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  // 積分画像で、まわりの平均の明るさをすばやく求める
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += L[y * w + x]; S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + row; }
  }
  const r = Math.max(12, Math.round(Math.min(w, h) / 60));
  const mean = (x, y) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
    return (S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
  };
  // 背景の明るさは、もっと広い範囲の平均で決める（文字だけの所で反転しないように）
  const R = r * 3;
  const meanWide = (x, y) => {
    const x0 = Math.max(0, x - R), y0 = Math.max(0, y - R), x1 = Math.min(w, x + R + 1), y1 = Math.min(h, y + R + 1);
    return (S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const dark = meanWide(x, y) < 135;
      let v = L[p], m = mean(x, y);
      if (dark) { v = 255 - v; m = 255 - m; }
      // まわりより十分暗ければ文字
      const out = v < m - 18 || v < 70 ? 0 : 255;
      const i = p * 4;
      d[i] = d[i + 1] = d[i + 2] = out; d[i + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
}
