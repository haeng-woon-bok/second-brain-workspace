// 필자 문체 기준선 (style_profile)
// - my_insights 전체 본문에서 길이·줄 길이·어미 비율·습관 표현을 계산해 style_profile 테이블에 저장
// - Worker가 직접 계산 (파이프라인 키 권한과 무관하게 동작), 24시간마다 백그라운드 갱신
// - 실패하면 DEFAULT_PROFILE(2026-11-18 수동 분석값)로 동작

import { supabaseHeaders } from './lib.js';

export const DEFAULT_PROFILE = {
  source: 'default-2026-11-18',
  posts: 74,
  chars: { avg: 2358, min: 1187, max: 4222, p10: 1500, p90: 3300 },
  avg_line: 35,
  endings: { nida: 49, yo: 13, neundeyo: 8, plain_da: 3, question: 3 },
  habits: { prev_link: 0.6, reader: 0.5, personal: 0.35, emoji_per_post: 0 }
};

const REFRESH_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 10 * 60 * 1000;
let memo = { at: 0, profile: null };

// ---------- 문장/어미 분석 (review.js와 공유) ----------
export const cleanLine = (l) => String(l).replace(/[​﻿ ]/g, ' ').trim();

export function isMetaLine(line) {
  const t = line.trim();
  return /^https?:\/\//.test(t) || /^(www\.)?[a-z0-9-]+\.(com|net|kr|co\.kr|org)\b/i.test(t)
    || /^(이전글|관련글)\s*:?\s*$/.test(t) || /^(#[^\s#]+\s*){2,}$/.test(t);
}

export function splitSentences(text) {
  return String(text).split(/(?<=[.?!])\s+|\n/)
    .map(s => s.replace(/[\p{Extended_Pictographic}️\s*~]+$/gu, '').trim())
    .filter(s => s.length > 3);
}

export function classifyEnding(s) {
  if (/니다[.?!]?$|니까[.?!]?$/.test(s)) return 'nida';
  if (/요[.?!]?$/.test(s)) return 'yo';
  if (/다[.?!]?$/.test(s)) return 'plain_da';
  return 'none';
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

// posts: [{ content_final }]
export function computeProfile(posts) {
  const bodies = posts.map(p => String(p.content_final || '')).filter(b => b.trim().length > 200);
  if (bodies.length < 5) return null;

  const lengths = bodies.map(b => b.length);
  // 네이버 본문의 빈 줄은 zero-width space(​)로 채워져 있어 제거 후 계산
  const lines = bodies.flatMap(b => b.split('\n').map(cleanLine).filter(l => l.length > 1 && !isMetaLine(l)));
  const sentences = bodies.flatMap(b => splitSentences(b.split('\n').filter(l => !isMetaLine(l)).join('\n')));
  const ends = { nida: 0, yo: 0, plain_da: 0 };
  let neundeyo = 0, question = 0;
  for (const s of sentences) {
    const e = classifyEnding(s);
    if (e in ends) ends[e]++;
    if (/[는인은]데요[.?!]?$/.test(s)) neundeyo++;
    if (/\?$/.test(s) || /(신가요|을까요|시나요|셨나요|일까요)[.?!]?$/.test(s)) question++;
  }
  const n = sentences.length;
  const share = (re) => Math.round((bodies.filter(b => re.test(b)).length / bodies.length) * 100) / 100;
  const emoji = bodies.reduce((a, b) => a + (b.match(/\p{Extended_Pictographic}/gu) || []).length, 0);

  return {
    source: 'computed',
    posts: bodies.length,
    sentences: n,
    chars: {
      avg: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
      min: Math.min(...lengths), max: Math.max(...lengths),
      p10: percentile(lengths, 10), p90: percentile(lengths, 90)
    },
    avg_line: Math.round(lines.reduce((a, l) => a + l.length, 0) / (lines.length || 1)),
    endings: { nida: pct(ends.nida, n), yo: pct(ends.yo, n), neundeyo: pct(neundeyo, n), plain_da: pct(ends.plain_da, n), question: pct(question, n) },
    habits: {
      prev_link: share(/(이전글|관련글)\s*:/),
      reader: share(/여러분/),
      personal: share(/개인적으로|제 생각/),
      emoji_per_post: Math.round((emoji / bodies.length) * 10) / 10
    }
  };
}

// ---------- 저장/조회 ----------
async function fetchLatest(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/style_profile?select=created_at,profile&order=id.desc&limit=1`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`style_profile 조회 실패 HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function refreshProfile(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/my_insights?select=content_final&limit=1000`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`my_insights 조회 실패 HTTP ${res.status}`);
  const profile = computeProfile(await res.json());
  if (!profile) return null;
  profile.computed_at = new Date().toISOString();
  const ins = await fetch(`${env.SUPABASE_URL}/rest/v1/style_profile`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, post_count: profile.posts })
  });
  if (!ins.ok) throw new Error(`style_profile 저장 실패 HTTP ${ins.status}`);
  memo = { at: Date.now(), profile };
  return profile;
}

// 요청 경로에서 호출: 캐시 → DB 최신값 → (없으면 즉시 계산, 오래됐으면 백그라운드 갱신) → 실패 시 기본값
export async function getStyleProfile(env, ctx) {
  if (memo.profile && Date.now() - memo.at < CACHE_MS) return memo.profile;
  try {
    const row = await fetchLatest(env);
    if (!row) {
      const p = await refreshProfile(env);
      return p || DEFAULT_PROFILE;
    }
    memo = { at: Date.now(), profile: row.profile };
    if (Date.now() - new Date(row.created_at).getTime() > REFRESH_MS && ctx?.waitUntil) {
      ctx.waitUntil(refreshProfile(env).catch(e => console.warn('style_profile 갱신 실패:', e.message)));
    }
    return row.profile;
  } catch (e) {
    console.warn('style_profile 사용 불가, 기본값 사용:', e.message);
    return DEFAULT_PROFILE;
  }
}

// draft.js 프롬프트용 문체 설명
export function styleBaselineText(p = DEFAULT_PROFILE) {
  const e = p.endings, h = p.habits;
  return `
- (필자 글 ${p.posts}편 자동 분석 기준)
- 어미: 합쇼체 "~습니다/~ㅂ니다."가 기본(문장의 약 ${Math.round(e.nida)}%). 도입·전환에서는 "~했는데요./~인데요."(약 ${Math.round(e.neundeyo)}%), 독자에게는 "~신가요?/~을까요?"로 물음.
  평서 반말 "~한다./~이다./~있다."는 거의 쓰지 않음(${Math.round(e.plain_da)}%). 초안이 반말이어도 "~습니다"로 바꿀 것
- 줄: 한 줄은 평균 ${p.avg_line}자 정도로 짧게. 한 문장이 길면 의미 단위로 줄바꿈. 문단 사이에는 빈 줄
- 도입: "저는 ~했는데요." / "이전 글에서 ~" 처럼 필자의 개인 맥락으로 시작
- 연결 글: 글의 ${Math.round(h.prev_link * 100)}%에 "이전글 :" 또는 "관련글 :" 뒤에 과거 글 제목과 링크를 붙임
- 관점: "개인적으로", "제 생각에는" 으로 필자의 관점을 분명히 밝힘 (글의 ${Math.round(h.personal * 100)}%)
- 마무리: "여러분"에게 말을 건네며 끝냄 (글의 ${Math.round(h.reader * 100)}%)
- 이모지(글당 ${h.emoji_per_post}개), 마크다운 기호(#, **, -, >)는 본문에 쓰지 않음
- 필자: 두 아이(행운이, 행복이)를 둔 가장, 재개발·재테크·AI를 공부하며 기록하는 블로거`;
}
