// 블로그 글의 실제 발행일 (네이버 글 목록의 addDate)
// my_insights.created_at은 DB로 가져온 날이라 발행일과 다르다. 6시간 캐시.
import { kstDate } from './news.js';
import { blogId } from './profile.js';

const cacheKey = () => `https://cache.internal/naver-publish-dates/${blogId()}/public-v2`;
const CACHE_TTL_SEC = 6 * 3600;
const PER_PAGE = 30;
const MAX_PAGES = 10;

// "2026. 3. 11." → 2026-03-11, "3시간 전"/"어제" 같은 상대 표기 → 오늘/어제(KST)
export function parseAddDate(text, now = new Date()) {
  const m = String(text || '').match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const today = kstDate(now.toISOString());
  if (/어제/.test(text)) return kstDate(new Date(now.getTime() - 86400000).toISOString());
  if (/(분|시간)\s*전|방금/.test(text)) return today;
  return null;
}

export function logNoFromUrl(url) {
  const m = String(url || '').match(/(\d{9,})\/?$/) || String(url || '').match(/logNo=(\d+)/);
  return m ? m[1] : null;
}

async function fetchPage(page) {
  const res = await fetch(
    `https://blog.naver.com/PostTitleListAsync.naver?blogId=${blogId()}&currentPage=${page}&countPerPage=${PER_PAGE}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: `https://blog.naver.com/${blogId()}` } }
  );
  if (!res.ok) throw new Error(`naver list HTTP ${res.status}`);
  const text = await res.text();
  // 네이버 응답은 JSON 이스케이프가 깨진 경우가 있어 글 하나씩({...}) 필요한 필드만 정규식으로 읽는다
  // 전체공개(openType "2") 글만 — 비공개·이웃공개 글은 발행일 목록에도, 서식 습관 분석에도 쓰지 않음
  const field = (obj, k) => (obj.match(new RegExp(`"${k}"\\s*:\\s*"?([^",}]*)"?`)) || [])[1];
  const rows = [...text.matchAll(/\{[^{}]*"logNo"[^{}]*\}/g)]
    .map(m => m[0])
    .filter(obj => field(obj, 'openType') === '2' && field(obj, 'isPostNotOpen') !== '1')
    .map(obj => [field(obj, 'logNo'), field(obj, 'addDate') || ''])
    .filter(([no]) => /^\d+$/.test(no || ''));
  const total = Number((text.match(/"totalCount"\s*:\s*"?(\d+)/) || [])[1] || 0);
  return { rows, total };
}

async function loadFromNaver() {
  const dates = {};
  const first = await fetchPage(1);
  first.rows.forEach(([no, d]) => { const p = parseAddDate(d); if (p) dates[no] = p; });
  const pages = Math.min(MAX_PAGES, Math.ceil((first.total || first.rows.length) / PER_PAGE));
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(i + 2).catch(() => ({ rows: [] }))));
  rest.forEach(r => r.rows.forEach(([no, d]) => { const p = parseAddDate(d); if (p) dates[no] = p; }));
  return dates;
}

// { logNo: 'YYYY-MM-DD' } — 실패하면 {} (화면은 가져온 날짜로 대체)
export async function getPublishDates(ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey());
    if (hit) return hit.json();
  }
  try {
    const dates = await loadFromNaver();
    if (cache && Object.keys(dates).length) {
      const resp = new Response(JSON.stringify(dates), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_SEC}` } });
      const put = cache.put(cacheKey(), resp);
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
    return dates;
  } catch (e) {
    console.warn('발행일 조회 실패:', e.message);
    return {};
  }
}

export function publishedOf(row, dates) {
  const no = logNoFromUrl(row.source_url);
  return (no && dates[no]) || null;
}

// 최신 발행 순 (발행일 같으면 logNo 큰 것이 최신)
export function sortByPublished(rows, dates) {
  return rows
    .map(r => ({ ...r, published: publishedOf(r, dates) }))
    .sort((a, b) => {
      const pa = a.published || '', pb = b.published || '';
      if (pa !== pb) return pa < pb ? 1 : -1;
      const na = BigInt(logNoFromUrl(a.source_url) || 0), nb = BigInt(logNoFromUrl(b.source_url) || 0);
      return na === nb ? 0 : (na < nb ? 1 : -1);
    });
}
