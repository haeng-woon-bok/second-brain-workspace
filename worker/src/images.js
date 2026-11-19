// 내 이미지 보관함
// - image_search: post_images(파이프라인이 AI로 설명·태그한 과거 글 이미지)에서 찾기
// - image_fetch: 네이버 이미지 받아 오기 (네이버 이미지는 다른 사이트에서 직접 못 읽어서 웹의 "이미지 복사"용으로 대신 받음)
import { supabaseHeaders } from './lib.js';
import { getPublishDates, publishedOf } from './published.js';

export const IMAGE_TYPES = new Set(['image_search', 'image_fetch']);
const IMG_HOST = /^https:\/\/(?:postfiles|blogfiles)\.pstatic\.net\/[^?#\s]+$/;

// 감정 검색어를 비슷한 말로 넓힘 (짤은 같은 감정을 여러 말로 부름)
const SYNONYMS = [
  ['안도', '후련', '끝', '해방', '다행', '휴'],
  ['멘붕', '충격', '당황', '혼란', '황당', '어이'],
  ['기쁨', '행복', '신남', '환호', '축하', '감격'],
  ['걱정', '불안', '고민', '초조', '긴장'],
  ['분노', '화남', '짜증', '분개', '억울'],
  ['허탈', '실망', '좌절', '우울', '슬픔'],
  ['감동', '뭉클', '눈물', '고마움']
];
function expand(token) {
  const set = new Set([token]);
  for (const g of SYNONYMS) if (g.some(w => token.includes(w) || w.includes(token))) g.forEach(w => set.add(w));
  return [...set];
}

const KIND_WORDS = { reaction: ['짤', '밈', '만화'], photo: ['사진'], capture: ['캡처', '캡쳐', '카톡', '화면'], chart: ['도표', '그래프', '표'] };

export function scoreImage(row, tokens) {
  const tags = (row.tags || []).map(String);
  const text = `${row.description || ''} ${row.caption || ''}`;
  let score = 0;
  for (const t of tokens) {
    const words = expand(t);
    let best = 0;
    for (const w of words) {
      const direct = w === t ? 1 : 0.6;   // 비슷한 말은 조금 낮게
      if (tags.some(g => g === w)) best = Math.max(best, 3 * direct);
      else if (tags.some(g => g.includes(w) || (w.length >= 2 && w.includes(g)))) best = Math.max(best, 2 * direct);
      else if (text.includes(w)) best = Math.max(best, 1 * direct);
    }
    for (const [kind, ws] of Object.entries(KIND_WORDS)) if (ws.includes(t) && row.kind === kind) best = Math.max(best, 1.5);
    score += best;
  }
  return score;
}

async function handleSearch(body, env, ctx) {
  const q = String(body.q || '').trim().slice(0, 60);
  const [imgRes, scanRes, postRes, dates] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/post_images?select=id,post_id,image_url,kind,description,tags,caption&order=post_id.desc,position.asc&limit=2000`, { headers: supabaseHeaders(env) }),
    fetch(`${env.SUPABASE_URL}/rest/v1/post_image_scans?select=post_id`, { headers: supabaseHeaders(env) }),
    fetch(`${env.SUPABASE_URL}/rest/v1/my_insights?select=id,title,source_url&limit=1000`, { headers: supabaseHeaders(env) }),
    getPublishDates(ctx)
  ]);
  if (imgRes.status === 404 || (!imgRes.ok && /post_images/.test(await imgRes.clone().text()))) {
    return { status: 200, json: { unavailable: true, images: [] } };
  }
  if (!imgRes.ok) throw new Error(`post_images HTTP ${imgRes.status}`);
  const rows = await imgRes.json();
  const scanned = scanRes.ok ? (await scanRes.json()).length : 0;
  const posts = postRes.ok ? await postRes.json() : [];
  const byId = new Map(posts.map(p => [p.id, p]));

  // 검색어에서 "짤", "이미지" 같은 일반어는 종류 힌트로만 쓰고 나머지로 점수
  const tokens = q.split(/[\s,·|]+/).map(t => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(t => t.length >= 1 && !['이미지', '사진들', '느낌', '장면'].includes(t));
  let list = rows.map(r => ({ ...r, score: tokens.length ? scoreImage(r, tokens) : 0 }));
  if (tokens.length) list = list.filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.post_id - a.post_id);
  const limit = Math.min(Number(body.limit) || 30, 60);

  return {
    status: 200,
    json: {
      total: rows.length,
      scanned_posts: scanned,
      all_posts: posts.length,
      images: list.slice(0, limit).map(r => {
        const p = byId.get(r.post_id) || {};
        return {
          id: r.id, url: r.image_url, kind: r.kind, description: r.description, tags: r.tags, caption: r.caption,
          post_title: p.title || '', post_url: p.source_url || '', published: p.source_url ? publishedOf(p, dates) : null
        };
      })
    }
  };
}

// 이미지 바이트를 그대로 돌려줌 (CORS 허용) — 네이버 이미지 주소만
async function handleFetch(body) {
  const url = String(body.url || '');
  if (!IMG_HOST.test(url)) return { status: 400, json: { error: '네이버 블로그 이미지 주소만 받을 수 있습니다.' } };
  const res = await fetch(`${url}?type=w773`, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://blog.naver.com/dad_luckyhappy' } });
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || !type.startsWith('image/')) return { status: 502, json: { error: `이미지를 받지 못했습니다 (HTTP ${res.status})` } };
  return { status: 200, binary: res.body, contentType: type };
}

export async function handleImageRequest(body, env, ctx) {
  if (body.type === 'image_search') return handleSearch(body, env, ctx);
  if (body.type === 'image_fetch') return handleFetch(body);
  return { status: 400, json: { error: 'unknown type' } };
}
