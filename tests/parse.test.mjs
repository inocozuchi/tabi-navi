// 貼り付け解析のテスト: node tests/parse.test.mjs
import { parseAny } from '../js/parse.js';
const today = new Date(2026, 9, 1);
let pass = 0, fail = 0;
const check = (name, items, expect) => {
  const errs = [];
  for (const [i, exp] of expect.entries()) {
    const it = items[i];
    if (!it) { errs.push(`#${i} がない`); continue; }
    for (const [k, v] of Object.entries(exp)) if (String(it[k]).indexOf(v) < 0 && it[k] !== v) errs.push(`#${i}.${k}=${JSON.stringify(it[k])} 期待 ${JSON.stringify(v)}`);
  }
  if (items.length !== expect.length) errs.push(`件数 ${items.length} 期待 ${expect.length}`);
  if (errs.length) { fail++; console.log('FAIL', name, errs.join(' / ')); console.log(JSON.stringify(items, null, 1)); } else { pass++; console.log('PASS', name); }
};

check('Yahoo乗換案内（縦に並ぶ形）', parseAny(`東京 → 京都
2026年10月12日(月)
06:00発→08:15着 2時間15分
14,170円
東京
06:00発
JR新幹線のぞみ1号・博多行
14番線発 / 7号車 3番A席
京都
08:15着
08:21発
JR奈良線普通・奈良行
8番線発
稲荷
08:26着`, today), [
  { type: 'shinkansen', from: '東京', to: '京都', start: '2026-10-12T06:00', end: '2026-10-12T08:15', platform: '14番線', seat: '7号車 3A', cost: '¥14,170' },
  { type: 'train', from: '京都', to: '稲荷', start: '2026-10-12T08:21', end: '2026-10-12T08:26', platform: '8番線' },
]);

check('時刻が先・駅が後の形', parseAny(`10/12
06:00 発 東京
JR新幹線のぞみ21号
08:15 着 新大阪`, today), [{ type: 'shinkansen', from: '東京', to: '新大阪', start: '2026-10-12T06:00', end: '2026-10-12T08:15' }]);

check('予約サイトの宿メール', parseAny(`【楽天トラベル】ご予約ありがとうございます
予約番号：RY8823991
宿泊施設：ナインアワーズ京都
住所：京都府京都市下京区寺町通四条下る貞安前之町588
チェックイン：2026年10月12日(月) 15:00
チェックアウト：2026年10月13日(火) 10:00
1泊 1名
合計金額 4,800円`, today), [{ type: 'hotel', title: 'ナインアワーズ京都', start: '2026-10-12T15:00', end: '2026-10-13T10:00', confirmation: 'RY8823991', cost: '¥4,800', reserved: true, address: '京都府京都市' }]);

check('英語の宿（Booking形式）', parseAny(`Booking confirmation
Hotel: Hostel Mundo Chuo
Check-in Mon, Oct 12, 2026 from 4:00 PM
Check-out Tue, Oct 13, 2026 until 11:00 AM
Confirmation number: 4419.882.103
Total price ¥3,900`, today), [{ type: 'hotel', title: 'Hostel Mundo Chuo', start: '2026-10-12T16:00', end: '2026-10-13T11:00', reserved: true }]);

check('泊数だけの宿', parseAny(`東横INN 京都四条烏丸
10月12日から2泊
予約番号 55512`, today), [{ type: 'hotel', start: '2026-10-12T15:00', end: '2026-10-14T10:00', confirmation: '55512' }]);

check('飛行機（ANA形式）', parseAny(`ご予約内容
予約番号 ABC123
2026年10月14日(水) NH 21便
大阪(伊丹) ITM 18:00発 → 東京(羽田) HND 19:10着
座席 12A
運賃合計 ¥15,400`, today), [{ type: 'flight', number: 'NH 21', from: '伊丹空港', to: '羽田空港', start: '2026-10-14T18:00', end: '2026-10-14T19:10', seat: '12A', confirmation: 'ABC123', reserved: true }]);

check('飛行機（往復2便）', parseAny(`往路 10/12 JL 123 羽田空港 7:00 → 那覇空港 9:45
復路 10/15 JL 128 那覇空港 13:00 → 羽田空港 15:30`, today), [
  { type: 'flight', number: 'JL 123', from: '羽田空港', to: '那覇空港', start: '2026-10-12T07:00', end: '2026-10-12T09:45' },
  { type: 'flight', number: 'JL 128', from: '那覇空港', to: '羽田空港', start: '2026-10-15T13:00', end: '2026-10-15T15:30' },
]);

check('高速バス', parseAny(`WILLER EXPRESS ご予約確定
乗車日 2026/10/11
乗車：バスタ新宿 23:10発
降車：京都駅八条口 6:30着
座席 5A
予約番号 W99812`, today), [{ type: 'bus', from: 'バスタ新宿', to: '京都駅八条口', start: '2026-10-11T23:10', end: '2026-10-12T06:30', seat: '5A' }]);

check('予定メモ', parseAny(`10/12(月)
9:30 伏見稲荷大社
12:00 ランチ 錦市場
14:00~16:00 清水寺
10/13
8:30 ツアー集合 京都駅八条口`, today), [
  { type: 'activity', title: '伏見稲荷大社', start: '2026-10-12T09:30' },
  { type: 'meal', title: 'ランチ 錦市場', start: '2026-10-12T12:00' },
  { type: 'activity', title: '清水寺', start: '2026-10-12T14:00', end: '2026-10-12T16:00' },
  { type: 'activity', title: 'ツアー集合 京都駅八条口', start: '2026-10-13T08:30' },
]);

check('全角混じり', parseAny(`１０月１２日　新幹線
東京　０６：００発
のぞみ１号
新大阪　０８：２７着`, today), [{ type: 'shinkansen', from: '東京', to: '新大阪', start: '2026-10-12T06:00', end: '2026-10-12T08:27' }]);

check('まとめて貼った（区切り線あり）', parseAny(`JL 123便 10/12 羽田空港 7:00発 → 那覇空港 9:45着
-----
ホテル：沖縄ゲストハウス
チェックイン 10月12日 16:00
チェックアウト 10月14日 10:00`, today), [
  { type: 'flight', start: '2026-10-12T07:00' },
  { type: 'hotel', title: '沖縄ゲストハウス', start: '2026-10-12T16:00', end: '2026-10-14T10:00' },
]);


check('JR EX予約のメール', parseAny(`【EX予約】予約が完了しました
乗車日：10月12日
列車名：のぞみ21号
東京(9:00)→新大阪(11:27)
7号車 12番E席
お支払い金額：14,720円
お預かり番号：1234`, today), [{ type: 'shinkansen', from: '東京', to: '新大阪', start: '2026-10-12T09:00', end: '2026-10-12T11:27', seat: '7号車 12E', reserved: true }]);

check('Googleマップ（英語・AM/PM）', parseAny(`Oct 12
7:05 AM Tokyo Station
Tokaido Shinkansen Nozomi 9
9:20 AM Kyoto Station`, today), [{ type: 'shinkansen', from: 'Tokyo Station', to: 'Kyoto Station', start: '2026-10-12T07:05', end: '2026-10-12T09:20' }]);

check('写真から文字をコピー（崩れ気味）', parseAny(`10月12日(月) 出発
06:00 発
東京
JR新幹線のぞみ1号 博多行
[14番線]
08:27 着
新大阪
運賃 14,720円`, today), [{ type: 'shinkansen', from: '東京', to: '新大阪', start: '2026-10-12T06:00', end: '2026-10-12T08:27', platform: '14番線' }]);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
