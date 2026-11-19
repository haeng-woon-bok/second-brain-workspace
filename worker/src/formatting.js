// 필자의 네이버 서식 습관 (최근 발행 글의 원본 HTML에서 추출, 24시간 캐시)
// - 형광펜(#fff8b2) 문장, 소제목(큰 굵은 글씨), 구분선 개수
// - draft.js 프롬프트에 "이런 곳에 형광펜을 칠한다" 예시로 넣는다
import { getPublishDates } from './published.js';

const BLOG_ID = 'dad_luckyhappy';
const CACHE_KEY = `https://cache.internal/naver-format-habits/${BLOG_ID}/v2`;
const CACHE_TTL_SEC = 24 * 3600;
const SAMPLE_POSTS = 6;

const decode = (s) => String(s)
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/[​﻿]/g, '').trim();

// 발행 글 HTML 하나 → { highlights: [문장], headings: [소제목], dividers, chars }
export function extractHabits(html) {
  const main = String(html);
  const highlights = [...main.matchAll(/<span style="[^"]*background-color:\s*#fff8b2[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(m => decode(m[1])).filter(t => t.length >= 4);
  const headings = [...main.matchAll(/<span[^>]*class="se-fs-fs(?:2[4-9]|3\d)[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
    .map(m => decode(m[1])).filter(t => t.length >= 2 && t.length <= 60);
  const dividers = (main.match(/se-component se-horizontalLine/g) || []).length;
  // 이미지 묶음(나란히 붙인 사진)도 한 자리로 셈
  const images = (main.match(/se-component se-(?:image|imageStrip|imageGroup|sticker)\b/g) || []).length;
  const text = [...main.matchAll(/<p class="se-text-paragraph[^>]*>([\s\S]*?)<\/p>/g)].map(m => decode(m[1])).join('');
  return { highlights, headings, dividers, images, chars: text.length };
}

async function fetchPost(logNo) {
  const res = await fetch(`https://blog.naver.com/PostView.naver?blogId=${BLOG_ID}&logNo=${logNo}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: `https://blog.naver.com/${BLOG_ID}` }
  });
  if (!res.ok) throw new Error(`post HTTP ${res.status}`);
  return res.text();
}

async function compute(ctx) {
  const dates = await getPublishDates(ctx);
  const recent = Object.entries(dates).sort((a, b) => (b[1].localeCompare(a[1])) || (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1))
    .slice(0, SAMPLE_POSTS * 2).map(([no]) => no);
  // 동시에 받아 최신순으로 SAMPLE_POSTS편 (짧은 일상글 제외)
  const fetched = await Promise.all(recent.map(no => fetchPost(no).then(extractHabits).catch(() => null)));
  const posts = fetched.filter(h => h && h.chars > 600).slice(0, SAMPLE_POSTS);
  if (!posts.length) return null;
  const per1000 = (k) => Math.round(posts.reduce((a, p) => a + (Array.isArray(p[k]) ? p[k].length : p[k]) / p.chars * 1000, 0) / posts.length * 10) / 10;
  return {
    posts: posts.length,
    highlights_per_1000: per1000('highlights'),
    headings_per_1000: per1000('headings'),
    dividers_per_1000: per1000('dividers'),
    images_per_1000: per1000('images'),
    highlight_examples: posts.flatMap(p => p.highlights.slice(0, 4)).slice(0, 14),
    heading_examples: posts.flatMap(p => p.headings.slice(0, 3)).slice(0, 8)
  };
}

// 실패하면 null (프롬프트는 기본 설명만 사용)
export async function getFormatHabits(ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    if (cache) {
      const hit = await cache.match(CACHE_KEY);
      if (hit) return hit.json();
    }
    const habits = await compute(ctx);
    if (habits && cache) {
      const put = cache.put(CACHE_KEY, new Response(JSON.stringify(habits), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_SEC}` }
      }));
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
    return habits;
  } catch (e) {
    console.warn('서식 습관 조회 실패:', e.message);
    return null;
  }
}
