// 貼り付け解析のテスト: node tests/parse.test.mjs
import { parseAny } from '../js/parse.js';
import fs from 'node:fs';
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

{
  const r = parseAny(fs.readFileSync(new URL('./samples/wakkanai.txt', import.meta.url), 'utf8'), today);
  check('旅程表（稚内・宗谷岬の旅）', r, [
    { type: 'flight', number: 'MM 579', from: '成田空港', to: '新千歳空港', start: '2026-10-27T18:10', end: '2026-10-27T20:00', reserved: true },
    { type: 'hotel', title: 'BIZCOURT CABINすすきの', start: '2026-10-27T20:30', end: '2026-10-28T07:00', reserved: true },
    { type: 'train', title: '特急宗谷', from: '札幌', to: '稚内', start: '2026-10-28T07:30', end: '2026-10-28T12:42' },
    { type: 'bus', from: '稚内駅前ターミナル', to: '宗谷岬', start: '2026-10-28T13:30', end: '2026-10-28T14:20' },
    { type: 'activity', title: '宗谷岬', start: '2026-10-28T14:20', end: '2026-10-28T15:20' },
    { type: 'bus', from: '宗谷岬', to: '稚内駅前ターミナル', start: '2026-10-28T15:20', end: '2026-10-28T16:18' },
    { type: 'activity', title: '稚内港北防波堤ドーム', start: '2026-10-28T17:00' },
    { type: 'meal', title: '夢広場', start: '2026-10-28T18:30' },
    { type: 'hotel', title: 'ゲストハウス モシリパ', start: '2026-10-28T20:00', end: '2026-10-29T10:00' },
    { type: 'bus', from: '稚内駅前ターミナル', to: 'ノシャップ', start: '2026-10-29T07:19', end: '2026-10-29T07:29' },
    { type: 'activity', title: 'ノシャップ', start: '2026-10-29T07:29' },
    { type: 'bus', from: 'ノシャップ', to: '駅前ターミナル', start: '2026-10-29T08:19', end: '2026-10-29T08:32' },
    { type: 'train', from: '稚内', to: '名寄', start: '2026-10-29T10:29', end: '2026-10-29T14:17' },
    { type: 'train', title: '快速なよろ', from: '名寄', to: '旭川', start: '2026-10-29T14:42', end: '2026-10-29T15:55' },
    { type: 'activity', title: '旭川', start: '2026-10-29T15:55', end: '2026-10-29T17:00' },
    { type: 'train', title: '特急カムイ', from: '旭川', to: '札幌', start: '2026-10-29T17:00', end: '2026-10-29T18:25' },
    { type: 'train', title: '特急すずらん10号', from: '札幌', to: '南千歳', start: '2026-10-29T19:14', end: '2026-10-29T19:48' },
    { type: 'train', title: '快速エアポート168号', from: '南千歳', to: '新千歳空港', start: '2026-10-29T19:59', end: '2026-10-29T20:03' },
    { type: 'flight', number: 'NH 084', from: '新千歳空港', to: '羽田空港', start: '2026-10-29T21:25', end: '2026-10-29T23:10', reserved: true },
  ]);
  if (r.title !== 'どこパスで行く 稚内・宗谷岬の旅') { fail++; console.log('FAIL 旅の名前', r.title); } else pass++;
}

check('1行ずつの旅程表', parseAny(`大阪日帰り 11/3
8:00 新大阪 発（のぞみ200号）
8:15 京都 着
9:00 清水寺 参拝
12:00頃 昼食 湯豆腐
15:30 京都 発（JR京都線 新快速）
16:00 大阪 着`, today), [
  { type: 'shinkansen', title: 'のぞみ200号', from: '新大阪', to: '京都', start: '2026-11-03T08:00', end: '2026-11-03T08:15' },
  { type: 'activity', title: '清水寺', start: '2026-11-03T09:00' },
  { type: 'meal', start: '2026-11-03T12:00' },
  { type: 'train', from: '京都', to: '大阪', start: '2026-11-03T15:30', end: '2026-11-03T16:00' },
]);

{
  const r = parseAny(fs.readFileSync(new URL('./samples/gifu-livetext.txt', import.meta.url), 'utf8'), today);
  const main = r.filter((x) => !x.is_alternate);
  const alts = r.filter((x) => x.is_alternate);
  check('旅程表（岐阜・表を写真から文字コピー）本命', main, [
    { type: 'bus', title: '濃飛バス', from: 'バスタ新宿', to: '平湯バスターミナル', start: '2026-11-13T08:15', end: '2026-11-13T12:55' },
    { type: 'activity', title: '荷物を平田館へ預ける', start: '2026-11-13T13:00' },
    { type: 'meal', title: '昼食', start: '2026-11-13T13:15', end: '2026-11-13T14:00' },
    { type: 'activity', title: 'ひらゆの森', start: '2026-11-13T14:00', end: '2026-11-13T15:30', cost: '¥700' },
    { type: 'activity', title: '2日間きっぷ', start: '2026-11-13T15:30', end: '2026-11-13T16:30' },
    { type: 'hotel', title: '平田館', start: '2026-11-13T17:00' },
    { type: 'meal', title: '夕食・温泉', start: '2026-11-13T18:00' },
    { type: 'meal', title: '朝食', start: '2026-11-14T07:00' },
    { type: 'walk', to: '平湯バスターミナル', start: '2026-11-14T07:45' },
    { type: 'bus', from: '平湯', to: '新穂高', start: '2026-11-14T08:00', end: '2026-11-14T08:45' },
    { type: 'ropeway', title: 'ロープウェイ', to: '西穂高口', start: '2026-11-14T09:00', end: '2026-11-14T09:25' },
    { type: 'activity', title: '展望台', start: '2026-11-14T09:25', end: '2026-11-14T10:10' },
    { type: 'ropeway', to: '新穂高温泉駅', start: '2026-11-14T10:15', end: '2026-11-14T10:40' },
    { type: 'bus', to: '平湯', start: '2026-11-14T10:55', end: '2026-11-14T11:28' },
    { type: 'activity', title: '荷物を受け取り', start: '2026-11-14T11:30' },
    { type: 'meal', title: '昼食', start: '2026-11-14T11:35', end: '2026-11-14T12:20' },
    { type: 'bus', from: '平湯BT', to: '高山濃飛バスセンター', start: '2026-11-14T12:30', end: '2026-11-14T13:31' },
    { type: 'bus', title: 'さるぼぼバス', to: '飛騨の里', start: '2026-11-14T13:45', end: '2026-11-14T13:54' },
    { type: 'activity', title: '飛騨の里', start: '2026-11-14T13:55', end: '2026-11-14T15:50' },
    { type: 'bus', to: 'バスセンター', start: '2026-11-14T15:54', end: '2026-11-14T16:10' },
    { type: 'train', title: '特急ひだ18号', from: '高山', to: '下呂', start: '2026-11-14T16:33', end: '2026-11-14T17:21' },
    { type: 'walk', to: '大江戸温泉物語 下呂別館', start: '2026-11-14T17:25', end: '2026-11-14T17:40' },
    { type: 'hotel', title: '大江戸温泉物語 下呂別館', start: '2026-11-14T17:40', end: '2026-11-15T08:50' },
    { type: 'meal', title: '夕食・大浴場', start: '2026-11-14T20:00' },
    { type: 'meal', title: '朝食', start: '2026-11-15T07:00', end: '2026-11-15T08:15' },
    { type: 'activity', title: 'クアガーデン', start: '2026-11-15T09:30', end: '2026-11-15T10:30' },
    { type: 'walk', to: '水明館', start: '2026-11-15T10:35', end: '2026-11-15T10:50' },
    { type: 'activity', title: '水明館', start: '2026-11-15T11:00', end: '2026-11-15T12:00', notes: '小川屋' },
    { type: 'meal', title: '昼食', start: '2026-11-15T12:00', end: '2026-11-15T12:45' },
    { type: 'walk', to: '下呂駅', start: '2026-11-15T12:55' },
    { type: 'train', title: '特急ひだ10号', from: '下呂', to: '名古屋', start: '2026-11-15T13:21', end: '2026-11-15T15:04' },
    { type: 'shinkansen', title: 'ひかり654号', from: '名古屋', to: '東京', start: '2026-11-15T15:25', end: '2026-11-15T17:09', cost: '¥11,090' },
  ]);
  check('旅程表（岐阜）予備ルート', alts, [
    { type: 'train', title: 'ひだ20号', from: '高山', to: '下呂', start: '2026-11-14T18:48', end: '2026-11-14T19:29' },
    { type: 'shinkansen', title: 'こだま', from: '名古屋', to: '東京', start: '2026-11-15T15:38', end: '2026-11-15T18:18' },
    { type: 'shinkansen', title: 'ひかり658号', from: '名古屋', to: '東京', start: '2026-11-15T17:25', end: '2026-11-15T19:09' },
    { type: 'shinkansen', title: 'ひかり662号', from: '名古屋', start: '2026-11-15T19:31' },
  ]);
  if (r.title !== '岐阜2泊3日') { fail++; console.log('FAIL 旅の名前', r.title); } else pass++;
}

check('分類が行の終わりにある旅程表', parseAny(`DAY 1 11/13(金)
8:15 バスタ新宿 発（濃飛バス） 移動
12:55 平湯バスターミナル 着 移動
13:15–14:00 昼食 食事
17:00 平田館 チェックイン 宿
DAY 2 11/14(土)
8:00 → 8:45 バスで新穂高ロープウェイへ 移動
平湯発 → 新穂高（H03）`, today), [
  { type: 'bus', from: 'バスタ新宿', to: '平湯バスターミナル', start: '2026-11-13T08:15', end: '2026-11-13T12:55' },
  { type: 'meal', title: '昼食', start: '2026-11-13T13:15', end: '2026-11-13T14:00' },
  { type: 'hotel', title: '平田館', start: '2026-11-13T17:00', end: '2026-11-14T07:30' },
  { type: 'bus', from: '平湯', to: '新穂高', start: '2026-11-14T08:00', end: '2026-11-14T08:45' },
]);

check('宿のメールと電車の経路をまとめて貼った', parseAny(`2026年11月13日
07:00 東京 発
のぞみ21号
09:27 新大阪 着

【楽天トラベル】
宿泊施設：ホテル阪神
チェックイン：2026年11月13日 15:00
チェックアウト：2026年11月14日 10:00`, today), [
  { type: 'hotel', title: 'ホテル阪神', start: '2026-11-13T15:00', end: '2026-11-14T10:00' },
  { type: 'shinkansen', title: 'のぞみ21号', from: '東京', to: '新大阪', start: '2026-11-13T07:00', end: '2026-11-13T09:27' },
]);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
