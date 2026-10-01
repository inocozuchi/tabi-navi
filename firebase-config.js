/*
 * 旅仲間の共有（共有コード・チャット・位置・旅程の同期）に使う Firebase の設定
 * ---------------------------------------------------------------------
 * ここに firebaseConfig を貼ると、このアプリを開いた全員が同じ共有サーバーを使います
 * （友達はアプリを開いて共有コードを入れるだけ）。null のままなら、各自が
 * アプリの「設定 → 旅仲間の共有 → 共有サーバー」に貼り付けて使えます。
 *
 *   window.FIREBASE_CONFIG = { apiKey: "…", authDomain: "…", projectId: "…", storageBucket: "…", messagingSenderId: "…", appId: "…" };
 *
 * ※ Web用のAPIキーは公開前提の識別子です。データの保護は Firestore のルールで行います。
 */
window.FIREBASE_CONFIG = null;
