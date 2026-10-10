// 旅程の自動最適化・移動時間・乗換考慮・おすすめスポット提案ロジック
import { aiOn, uid, store, parseLocal, toLocalISO, dayKey, mdw, hm, dur, pad, TYPES, TRANSPORT } from './util.js';
import { callClaude, todayText } from './ai.js';
import { geocode, spotSearch } from './transit.js';

// 2点間の概算直線距離（km）
export function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 移動に必要な標準バッファ・乗り換え時間（分）
export function getRecommendedTransferTime(prevItem, nextItem) {
  if (!prevItem || !nextItem) return 10;
  // 飛行機に乗る前：国内線40分、国際線90分
  if (nextItem.type === 'flight') return 50;
  // 新幹線に乗る前：15分
  if (nextItem.type === 'shinkansen') return 15;
  // 宿のチェックイン後：20分
  if (prevItem.type === 'hotel') return 15;
  // 電車・バスの乗り換え：通常8〜10分
  if (TRANSPORT.has(prevItem.type) && TRANSPORT.has(nextItem.type)) return 10;
  return 15;
}

// 予定間の空き時間（ギャップ）を検出
export function detectGaps(trip, targetDay = null) {
  if (!trip?.items?.length) return [];
  const items = [...trip.items].filter((i) => i.start).sort((a, b) => a.start.localeCompare(b.start));
  const gaps = [];

  for (let i = 0; i < items.length - 1; i++) {
    const cur = items[i];
    const nxt = items[i + 1];
    const sCur = parseLocal(cur.start);
    const eCur = parseLocal(cur.end || cur.start);
    const sNxt = parseLocal(nxt.start);

    if (!sCur || !eCur || !sNxt) continue;
    if (targetDay && dayKey(sCur) !== targetDay) continue;

    // 同じ日のギャップを検出
    if (dayKey(eCur) === dayKey(sNxt)) {
      const diffMs = sNxt - eCur;
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin >= 30) {
        gaps.push({
          prev: cur,
          next: nxt,
          start: eCur,
          end: sNxt,
          minutes: diffMin,
          location: cur.to || cur.address || cur.title || nxt.from || nxt.address || ''
        });
      }
    }
  }
  return gaps;
}

// 空き時間に対して、行きたいリストや周辺のおすすめスポットをマッチング
export async function suggestSpotsForGap(gap) {
  const suggestions = [];
  const loc = gap.location;

  // 1. ユーザーの「行きたいリスト」から未訪問かつ場所・キーワードが近いものを優先抽出
  const wishlist = store.data.wishlist || [];
  for (const w of wishlist.filter((x) => !x.done)) {
    let matchScore = 0;
    if (loc && (loc.includes(w.area || '') || (w.area && loc.includes(w.area)))) matchScore += 3;
    if (loc && (loc.includes(w.name) || w.name.includes(loc))) matchScore += 2;
    if (w.stay <= gap.minutes) matchScore += 1;

    suggestions.push({
      id: w.id,
      name: w.name,
      category: w.category || '観光',
      stay: w.stay || 60,
      notes: w.notes || '',
      source: 'wishlist',
      score: matchScore
    });
  }

  suggestions.sort((a, b) => b.score - a.score);

  // 2. 登録済みが少ない場合、エリア周辺のスポット検索（OpenStreetMap）を活用
  if (suggestions.length < 3 && loc) {
    try {
      const geo = await geocode(loc);
      if (geo && geo.lat && geo.lon) {
        const found = await spotSearch(geo.lat, geo.lon, 'tourism');
        for (const f of found.slice(0, 3)) {
          if (!suggestions.some((s) => s.name === f.name)) {
            suggestions.push({
              name: f.name,
              category: '観光・散策',
              stay: 45,
              notes: f.sub || '',
              source: 'nearby',
              address: f.sub || '',
              score: 1
            });
          }
        }
      }
    } catch {}
  }

  return suggestions.slice(0, 5);
}

// AIまたはスマートロジックを用いて旅程全体のスケジュールを最適化（移動時間・乗換・スポット配置）
export async function autoOptimizeSchedule(trip, options = { includeSuggestions: true, bufferMargin: 15 }) {
  if (!trip?.items?.length) return trip;
  const s = store.data.settings;

  // AI の APIキーがある場合は高度な自動最適化・おすすめスポット組み込みを実施
  if (aiOn()) {
    const prompt = `あなたは旅行行程のプロフェッショナルです。以下の旅行の予定表を見直し、より現実的で快適なスケジュールに最適化してください。
要件:
1. 移動時間や乗り換え時間（新幹線15分前、飛行機50分前、通常乗り換え8-10分）に無理がないか確認し、必要に応じて発着時刻を調整。
2. 予定と予定の間に1時間以上の余裕がある場合、その前後のエリアに合ったおすすめの観光スポットや食事処（type: activity または meal）を提案・追加。
3. 旅程の全体的な流れ（午前・昼食・午後・夕食・宿泊）を自然に整える。

現在の予定リスト:
${JSON.stringify(trip.items.map((it) => ({
  id: it.id,
  type: it.type,
  title: it.title,
  from: it.from,
  to: it.to,
  start: it.start,
  end: it.end,
  cost: it.cost,
  notes: it.notes
})), null, 2)}

今日の日付情報: ${todayText()}`;

    const OPTIMIZE_SCHEMA = {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'summary'],
      properties: {
        summary: { type: 'string', description: '調整したポイントの簡潔な解説' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'title', 'from', 'to', 'start', 'end', 'notes', 'reserved'],
            properties: {
              type: { type: 'string' },
              title: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              start: { type: 'string' },
              end: { type: 'string' },
              notes: { type: 'string' },
              reserved: { type: 'boolean' }
            }
          }
        }
      }
    };

    const res = await callClaude({
      system: 'あなたは旅行日程の最適化アシスタントです。',
      content: [{ type: 'text', text: prompt }],
      schema: OPTIMIZE_SCHEMA,
      effort: 'medium'
    });

    return {
      items: res.items.map((it) => {
        const orig = trip.items.find((x) => x.title === it.title && x.type === it.type);
        return {
          id: orig ? orig.id : uid(),
          ...it,
          operator: orig?.operator || '',
          number: orig?.number || '',
          platform: orig?.platform || '',
          seat: orig?.seat || '',
          confirmation: orig?.confirmation || '',
          cost: orig?.cost || '',
          address: orig?.address || '',
          phone: orig?.phone || '',
          imgs: orig?.imgs || []
        };
      }),
      summary: res.summary
    };
  }

  // APIキーがない場合のオフライン自動調整ロジック:
  // 乗り換え時間が短すぎる箇所の警告解消やバッファ確保
  const sorted = [...trip.items].filter((i) => i.start).sort((a, b) => a.start.localeCompare(b.start));
  let adjusted = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const nxt = sorted[i + 1];
    const eCur = parseLocal(cur.end || cur.start);
    const sNxt = parseLocal(nxt.start);

    if (eCur && sNxt && dayKey(eCur) === dayKey(sNxt)) {
      const rec = getRecommendedTransferTime(cur, nxt);
      const currentGap = (sNxt - eCur) / 60000;
      if (currentGap < rec && !nxt.reserved) {
        // 未予約の次の予定を少し後ろにずらして安全な乗り換え時間を確保
        const needed = rec - currentGap;
        const newStart = new Date(sNxt.getTime() + needed * 60000);
        const durMs = parseLocal(nxt.end) ? (parseLocal(nxt.end) - sNxt) : 3600000;
        nxt.start = toLocalISO(newStart);
        nxt.end = toLocalISO(new Date(newStart.getTime() + durMs));
        adjusted++;
      }
    }
  }

  return {
    items: trip.items,
    summary: adjusted > 0 ? `${adjusted}件の予定の乗り換え・移動バッファ時間を自動調整しました` : '乗り換え・移動時間に大きな無理は見つかりませんでした'
  };
}
