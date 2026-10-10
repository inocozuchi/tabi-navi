# pdf.js（旅程のPDFを取り込む時だけ使う）

- 元: npm の `pdfjs-dist@3.11.174`（Mozilla、Apache License 2.0。`LICENSE` を参照）
- `pdf.min.js` / `pdf.worker.min.js` … 古いブラウザでも動く `legacy/build` のもの
- `cmaps/` … 日本語の文字の読み取りに使う表

アプリの起動時には読み込みません。「PDFから取り込む」でファイルを選んだ時にだけ読み込みます。
