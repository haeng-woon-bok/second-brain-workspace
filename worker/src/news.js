// 날짜별 뉴스(달력)와 "이 뉴스와 관련된 내 과거 글" 조회
import { supabaseHeaders, searchPastInsights } from './lib.js';

export const NEWS_TYPES = new Set(['news_dates', 'news_by_date', 'related_posts', 'post_get']);

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function kstDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// KST 하루(YYYY-MM-DD)의 UTC 범위
export function kstDayRange(date) {
  const start = new Date(`${date}T00:00:00+09:00`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86400000).toISOString() };
}

async function sbGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

export function splitPayload(row) {
  const p = (row && row.sector_news) || {};
  return { news: p.news || p, briefing: p.briefing || null, indices: p.indices || null, items: p.items || null, themes: p.themes || null };
}

// 문단 고르기: 질의와 글자쌍이 가장 많이 겹치는 문단 (임베딩은 글 단위라 문단은 간단한 겹침으로 선택)
function bigrams(s) {
  const t = String(s || '').replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

export function bestPassage(content, query, maxLen = 160) {
  const q = bigrams(query);
  const paras = String(content || '')
    .replace(/[\u200B\uFEFF]/g, '')
    .split(/\n\s*\n|\n/)
    .map(p => p.trim())
    .filter(p => p.length >= 20 && !/^#|^https?:\/\//.test(p));
  let best = '', score = -1;
  for (let i = 0; i < paras.length; i++) {
    // 짧은 줄은 다음 줄과 이어 붙여 문맥을 확보
    const text = paras[i].length < 60 && paras[i + 1] ? `${paras[i]} ${paras[i + 1]}` : paras[i];
    const g = bigrams(text);
    let hit = 0;
    for (const x of g) if (q.has(x)) hit++;
    const s = hit / Math.sqrt(g.size || 1);
    if (s > score) { score = s; best = text; }
  }
  return best.length > maxLen ? best.slice(0, maxLen).replace(/\s+\S*$/, '') + '…' : best;
}

export async function handleNewsRequest(body, env) {
  if (body.type === 'news_dates') {
    // 최근 120일치 날짜 목록 (하루에 여러 번 실행됐으면 하나로)
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const rows = await sbGet(env, `daily_news?select=id,created_at&created_at=gte.${since}&order=created_at.desc&limit=500`);
    const dates = [...new Set(rows.map(r => kstDate(r.created_at)).filter(Boolean))];
    return { status: 200, json: { dates } };
  }

  if (body.type === 'news_by_date') {
    const date = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, json: { error: 'date는 YYYY-MM-DD 형식이어야 합니다.' } };
    const { from, to } = kstDayRange(date);
    const rows = await sbGet(env,
      `daily_news?select=id,created_at,sector_news&created_at=gte.${encodeURIComponent(from)}&created_at=lt.${encodeURIComponent(to)}&order=created_at.desc&limit=1`);
    if (!rows.length) return { status: 404, json: { error: '그날 저장된 뉴스가 없습니다.' } };
    return { status: 200, json: { date, created_at: rows[0].created_at, ...splitPayload(rows[0]) } };
  }

  if (body.type === 'related_posts') {
    const text = String(body.text || '').slice(0, 1000).trim();
    if (text.length < 4) return { status: 400, json: { error: 'text가 필요합니다.' } };
    const count = Math.min(Math.max(Number(body.count) || 3, 1), 5);
    const rows = await searchPastInsights(text, count, env);
    const posts = rows.map(r => ({
      id: r.id,
      title: r.title,
      url: r.source_url || '',
      date: kstDate(r.created_at),
      similarity: Math.round((r.similarity || 0) * 100) / 100
    }));
    return { status: 200, json: { posts } };
  }

  if (body.type === 'post_get') {
    // 사이트 안에서 과거 글 전문 읽기 (공개 블로그 글이므로 작업 키 불필요)
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return { status: 400, json: { error: 'id가 필요합니다.' } };
    const rows = await sbGet(env, `my_insights?select=id,created_at,title,summary,tags,source_url,content_final&id=eq.${id}&limit=1`);
    if (!rows.length) return { status: 404, json: { error: '글을 찾을 수 없습니다.' } };
    const r = rows[0];
    return { status: 200, json: { post: {
      id: r.id, title: r.title, url: r.source_url || '', date: kstDate(r.created_at),
      summary: r.summary || '', tags: r.tags || [],
      content: String(r.content_final || '').replace(/[\u200B\uFEFF]/g, '')
    } } };
  }

  return { status: 400, json: { error: 'Invalid request' } };
}
