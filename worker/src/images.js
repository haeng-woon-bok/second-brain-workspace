// 내 이미지 보관함
// - image_search: post_images(파이프라인이 AI로 설명·태그한 과거 글 이미지)에서 찾기
// - image_fetch: 네이버 이미지 받아 오기 (네이버 이미지는 다른 사이트에서 직접 못 읽어서 웹의 "이미지 복사"용으로 대신 받음)
import { supabaseHeaders } from './lib.js';
import { getPublishDates, publishedOf } from './published.js';

export const IMAGE_TYPES = new Set(['image_search', 'image_fetch', 'meme_list', 'meme_mark']);
export const MARK_TYPES = new Set(['meme_mark']);   // 작업 키가 있어야 하는 요청
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

// ---------- 짤 모음: 짤(reaction)만 + ★·숨기기·복사 횟수 (meme_marks, SQL 007) ----------
async function handleMemeList(env, ctx) {
  const h = { headers: supabaseHeaders(env) };
  const [imgRes, markRes, postRes, dates] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/post_images?select=id,post_id,image_url,description,tags,caption&kind=eq.reaction&order=post_id.desc,position.asc&limit=1000`, h),
    fetch(`${env.SUPABASE_URL}/rest/v1/meme_marks?select=image_id,favorite,hidden,copy_count,last_copied_at&limit=2000`, h),
    fetch(`${env.SUPABASE_URL}/rest/v1/my_insights?select=id,title,source_url&limit=1000`, h),
    getPublishDates(ctx)
  ]);
  if (!imgRes.ok) throw new Error(`post_images HTTP ${imgRes.status}`);
  const rows = await imgRes.json();
  const marksReady = markRes.ok;   // 표(SQL 007)가 아직 없으면 표시 없이 동작
  const marks = new Map((marksReady ? await markRes.json() : []).map(m => [m.image_id, m]));
  const posts = new Map((postRes.ok ? await postRes.json() : []).map(p => [p.id, p]));
  const memes = rows.map(r => {
    const m = marks.get(r.id) || {};
    const p = posts.get(r.post_id) || {};
    return {
      id: r.id, url: r.image_url, description: r.description, tags: r.tags, caption: r.caption,
      post_title: p.title || '', published: p.source_url ? publishedOf(p, dates) : null,
      favorite: !!m.favorite, hidden: !!m.hidden, copy_count: m.copy_count || 0, last_copied_at: m.last_copied_at || null
    };
  });
  // ★ → 많이 복사한 순 → 최근 글 순
  memes.sort((a, b) => (b.favorite - a.favorite) || (b.copy_count - a.copy_count) || 0);
  return { status: 200, json: { memes, marks_ready: marksReady } };
}

async function handleMemeMark(body, env) {
  const id = Number(body.image_id);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, json: { error: 'image_id가 올바르지 않습니다.' } };
  const base = `${env.SUPABASE_URL}/rest/v1/meme_marks`;
  const headers = { ...supabaseHeaders(env), 'Content-Type': 'application/json' };
  const cur = await fetch(`${base}?select=favorite,hidden,copy_count&image_id=eq.${id}`, { headers });
  if (!cur.ok) {
    const t = await cur.text();
    if (/meme_marks/.test(t)) return { status: 503, json: { error: '짤 표시를 저장할 표가 아직 없습니다 (SQL 007 실행 필요).', code: 'marks_table_missing' } };
    throw new Error(`meme_marks HTTP ${cur.status}`);
  }
  const prev = (await cur.json())[0] || { favorite: false, hidden: false, copy_count: 0 };
  const row = { image_id: id, favorite: prev.favorite, hidden: prev.hidden, copy_count: prev.copy_count, updated_at: new Date().toISOString() };
  if (typeof body.favorite === 'boolean') row.favorite = body.favorite;
  if (typeof body.hidden === 'boolean') row.hidden = body.hidden;
  if (body.copied === true) { row.copy_count = (prev.copy_count || 0) + 1; row.last_copied_at = row.updated_at; }
  const res = await fetch(`${base}?on_conflict=image_id`, {
    method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`짤 표시 저장 실패 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return { status: 200, json: { mark: (await res.json())[0] || row } };
}

export async function handleImageRequest(body, env, ctx) {
  if (body.type === 'image_search') return handleSearch(body, env, ctx);
  if (body.type === 'image_fetch') return handleFetch(body);
  if (body.type === 'meme_list') return handleMemeList(env, ctx);
  if (body.type === 'meme_mark') return handleMemeMark(body, env);
  return { status: 400, json: { error: 'unknown type' } };
}
