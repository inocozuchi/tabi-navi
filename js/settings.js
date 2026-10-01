// 設定
import { $, $$, esc, store, page, toast, confirmBox, switchHTML, haptic, I, segment, download, blobs } from './util.js';
import { pickPlace } from './home.js';
import { askNotify } from './tools.js';
import { social } from './social.js';

const el = () => $('#view-settings');

export function applyTheme() {
  const t = store.data.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#000000' : '#F2F2F7'));
}

export function renderSettings() {
  const s = store.data.settings;
  el().innerHTML = `
    <div class="large-title"><h1>設定</h1></div>
    <div class="section-title">表示</div>
    <div class="segment" id="st-theme"><button data-v="auto" class="${s.theme === 'auto' ? 'active' : ''}">自動</button><button data-v="light" class="${s.theme === 'light' ? 'active' : ''}">☀️ ライト</button><button data-v="dark" class="${s.theme === 'dark' ? 'active' : ''}">🌙 ダーク</button></div>
    <div class="list">
      <div class="row icon-row"><span class="ico" style="background:var(--gray)">${I.clock}</span><div class="grow">時計に秒を表示</div>${switchHTML('', s.showSeconds, 'id="st-sec"')}</div>
      <button class="row icon-row" id="st-place"><span class="ico" style="background:var(--cyan)">${I.sun}</span><div class="grow">天気の場所</div><span class="val">${esc(s.place?.name || '現在地')}</span><span class="chev">${I.chev}</span></button>
      <button class="row icon-row" id="st-notify"><span class="ico" style="background:var(--red)">${I.info}</span><div class="grow">通知を許可</div><span class="val">${window.Notification ? ({ granted: '許可済み', denied: '拒否', default: '未設定' })[Notification.permission] : '非対応'}</span></button>
    </div>
    <div class="section-title">AI（スクショの読み取り・旅程の提案）</div>
    <div class="list">
      <div class="row icon-row"><span class="ico" style="background:var(--indigo)">${I.key}</span><div style="flex:none">API キー</div><input type="password" id="st-key" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></div>
      <div class="row icon-row"><span class="ico" style="background:var(--purple)">${I.sparkles}</span><div class="grow">モデル</div><select id="st-model">${[['claude-opus-5-5', 'Claude Opus 5.5（高精度）'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5（速い・安い）'], ['claude-haiku-4-5', 'Claude Haiku 4.5（最安）']].map(([v, n]) => `<option value="${v}" ${s.aiModel === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    <div class="section-foot">Claude の API キー（<a href="https://console.anthropic.com/" target="_blank">console.anthropic.com</a> で作成・従量課金）を入れると、スクショの読み取りがとても正確になり、旅程の提案も使えます。キーはこの端末の中にだけ保存されます。キーが無くても、端末の中での文字読み取りで使えます。</div>
    <div class="section-title">アラーム</div>
    <div class="list">
      <button class="row icon-row" id="st-alarmhelp"><span class="ico" style="background:var(--orange)">${I.headphones}</span><div class="grow">アラームのしくみと注意</div><span class="chev">${I.chev}</span></button>
    </div>
    <div class="section-title">旅仲間の共有</div>
    <div class="list">
      <div class="row icon-row"><span class="ico" style="background:var(--purple)">${I.globe}</span><div class="grow">あなたの名前</div><input type="text" id="st-name" value="${esc(store.data.social.name)}" placeholder="未設定"></div>
      <button class="row icon-row" id="st-fb"><span class="ico" style="background:#FFA000">🔥</span><div class="grow">共有サーバー（Firebase）</div><span class="val">${store.data.social.firebase ? '設定済み' : (window.FIREBASE_CONFIG ? '設定済み' : '未設定')}</span><span class="chev">${I.chev}</span></button>
    </div>
    ${social.error ? `<div class="section-foot" style="color:var(--red)">${esc(social.error)}</div>` : ''}
    <div class="section-title">データ</div>
    <div class="list">
      <button class="row icon-row" id="st-export"><span class="ico" style="background:var(--green)">${I.download}</span><div class="grow">バックアップを保存</div></button>
      <label class="row icon-row"><span class="ico" style="background:var(--blue)">${I.upload}</span><div class="grow">バックアップから戻す</div><input type="file" accept=".json" hidden id="st-import"></label>
      <button class="row icon-row" id="st-wipe" style="color:var(--red)"><span class="ico" style="background:var(--red)">${I.trash}</span><div class="grow">すべてのデータを消す</div></button>
    </div>
    <div class="section-title">このアプリについて</div>
    <div class="list">
      <button class="row icon-row" id="st-install"><span class="ico" style="background:var(--blue)">${I.share}</span><div class="grow">ホーム画面に追加する方法</div><span class="chev">${I.chev}</span></button>
      <div class="row icon-row"><span class="ico" style="background:var(--gray)">${I.info}</span><div class="grow">旅ナビ</div><span class="val">v1.0</span></div>
    </div>
    <div class="section-foot">天気: Open-Meteo ／ 地図: © OpenStreetMap 協力者 ／ 遅延情報: 鉄道遅延情報のjson（tetsudo.rti-giken.jp） ／ 為替: ExchangeRate-API</div>
  `;
  segment($('#st-theme'), (v) => { s.theme = v; store.save(); applyTheme(); });
  $('#st-sec').onchange = (e) => { s.showSeconds = e.target.checked; store.save(); };
  $('#st-place').onclick = () => pickPlace(renderSettings);
  $('#st-notify').onclick = async () => { askNotify(); setTimeout(renderSettings, 1500); };
  $('#st-key').onchange = (e) => { s.apiKey = e.target.value.trim(); store.save(); toast(s.apiKey ? 'API キーを保存しました' : 'API キーを消しました'); };
  $('#st-model').onchange = (e) => { s.aiModel = e.target.value; store.save(); };
  $('#st-alarmhelp').onclick = alarmHelp;
  $('#st-install').onclick = installHelp;
  $('#st-name').onchange = async (e) => { const { rename } = await import('./social.js'); rename(e.target.value.trim()); };
  $('#st-fb').onclick = firebaseHelp;
  $('#st-export').onclick = async () => {
    const data = { ...store.data, settings: { ...store.data.settings, apiKey: '' } };
    download(`旅ナビ_バックアップ_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
  };
  $('#st-import').onchange = async (e) => {
    try {
      const j = JSON.parse(await e.target.files[0].text());
      if (!j.settings) throw 0;
      if (!(await confirmBox('バックアップから戻しますか？', '今のデータは置き換わります', '戻す', { destructive: true }))) return;
      const key = store.data.settings.apiKey;
      localStorage.setItem('tabinavi.v1', JSON.stringify({ ...j, settings: { ...j.settings, apiKey: key } }));
      location.reload();
    } catch { toast('読み込めませんでした'); }
  };
  $('#st-wipe').onclick = async () => {
    if (!(await confirmBox('すべてのデータを消しますか？', '旅程・アラーム・メモ・画像・音がすべて消えます。取り消せません。', '消す', { destructive: true }))) return;
    store.reset();
    for (const k of await blobs.keys()) await blobs.del(k);
    location.reload();
  };
}

function alarmHelp() {
  page({
    title: 'アラームのしくみ',
    build(body) {
      body.innerHTML = `<div class="card" style="line-height:1.7">
        <b>🎧 イヤホンからだけ鳴らすしくみ</b><br>
        このアプリのアラームは、iPhone の時計アプリと違い「音楽と同じ扱い」で鳴らします。音楽はイヤホンがつながっていればイヤホンから鳴り、マナーモード（消音スイッチ）でも鳴ります。<br>
        さらに iPhone は、音を流している途中でイヤホンが外れると自動で音を止めます（スピーカーには切り替えません）。このアプリはそれを検出して、以後は鳴らしません。<br><br>
        <b>😴 使い方</b><br>
        ① アラームをつくる（連続アラームで 6:00〜6:15 に1分ごと、などが一括で設定できます）<br>
        ② 寝る前にイヤホンをつけて「おやすみモード」を開始<br>
        ③ 節電モードではアプリを開いたまま（充電しながら）置く。確実モードでは画面を消してもOK<br><br>
        <b>🔋 イヤホンの電池を長持ちさせる</b><br>
        「イヤホン節電モード」では、待機中はイヤホンに一切音を送らず、鳴らす時だけ送ります。イヤホンはつながっているだけの状態になるので、音を流し続けるより電池が長持ちします。寝る前にイヤホンを満充電にしておくと安心です。<br><br>
        <b>⚠️ 知っておいてほしいこと</b><br>
        ・Webアプリは、アプリを完全に閉じる（上にスワイプして消す）と鳴りません。おやすみ画面のまま置いてください。<br>
        ・節電モードで iPhone を手動でロックすると止まることがあります。画面は自動で暗くなります（設定 → 画面表示と明るさ → 自動ロック が効かないよう、アプリが画面をつけたままにします）。<br>
        ・節電モードでは、寝ている間にイヤホンの電池が切れた場合に気づけないことがあります。「マイクの一覧でも確かめる」をオンにすると、マイク付きのイヤホン（AirPods など）なら検出できます。確実にしたい時は「確実モード」を使ってください。<br>
        ・電話がかかってきた時など、他のアプリに音を取られた場合も「イヤホンが外れた」と同じ扱いになり、無音になります。おやすみ画面の「イヤホンをつないだらタップ」で元に戻せます。<br>
        ・念のため、大事な予定の日は iPhone の時計アプリ（バイブのみ）なども併用してください。</div>`;
    },
  });
}

function installHelp() {
  page({
    title: 'ホーム画面に追加',
    build(body) {
      body.innerHTML = `<div class="card" style="line-height:1.8">
        ① Safari でこのページを開く<br>
        ② 画面下の <b>共有ボタン</b>（□に↑）を押す<br>
        ③ <b>「ホーム画面に追加」</b>を選ぶ<br>
        ④ 右上の「追加」を押す<br><br>
        ホーム画面のアイコンから開くと、アプリのように全画面で使えます。オフラインでも旅程・メモ・アラームは使えます（天気・地図・AIは通信が必要）。</div>
        <div class="list"><div class="row"><div class="grow small mono" style="word-break:break-all">${esc(location.href.split('#')[0])}</div></div></div>`;
    },
  });
}

function firebaseHelp() {
  page({
    title: '共有サーバー',
    build(body) {
      body.innerHTML = `<div class="card" style="line-height:1.7">
        旅仲間の共有（共有コード・チャット・位置・旅程の同期）は Firebase（Google の無料枠のあるサービス）を使います。<b>アカウント登録は不要</b>で、端末ごとに自動で匿名ログインします。<br><br>
        <b>はじめの準備（1回だけ・旅仲間の共有を使う人だけ）</b><br>
        ① <a href="https://console.firebase.google.com/" target="_blank">Firebase コンソール</a>でプロジェクトをつくる<br>
        ② Firestore Database をつくる（ロケーション asia-northeast1）<br>
        ③ Authentication →「匿名」を有効にする<br>
        ④ プロジェクトの設定 → マイアプリ → ウェブ（&lt;/&gt;）で表示される firebaseConfig を、下の欄に貼り付けて保存<br>
        ⑤ Firestore →「ルール」に次の内容を貼って公開<br>
        （友達の端末は、あなたが④を済ませた後にアプリを開けば自動で同じ設定を使います — リポジトリの firebase-config.js に貼った場合）</div>
        <pre class="card small mono" style="white-space:pre-wrap;-webkit-user-select:text;user-select:text">match /tabi_codes/{code} {
  allow read, write: if request.auth != null;
}
match /tabi_groups/{gid} {
  allow create: if request.auth != null;
  allow read, update, delete: if request.auth != null;
  match /{sub=**} {
    allow read, write: if request.auth != null
      && !(request.auth.uid in get(/databases/$(database)/documents/tabi_groups/$(gid)).data.kicked);
  }
}</pre>
        <div class="section-title">firebaseConfig（この端末に保存）</div>
        <div class="list"><div class="row" style="align-items:stretch"><textarea id="fb-cfg" placeholder="firebaseConfig = { apiKey: ..., projectId: ... } をそのまま貼り付け" style="min-height:120px">${esc(store.data.social.firebase)}</textarea></div></div>
        <div style="margin-top:10px"><button class="btn" id="fb-save">保存</button></div>`;
      $('#fb-save', body).onclick = () => { store.data.social.firebase = $('#fb-cfg', body).value.trim(); store.save(); toast('保存しました（アプリを開き直すと反映されます）'); };
    },
  });
}
