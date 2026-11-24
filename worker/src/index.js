// Cloudflare Worker: slack-second-brain
// 필요한 환경 변수: SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, SLACK_BOT_TOKEN
// 바인딩: AI_LIMITER (Rate Limiting, wrangler.toml)

import { supabaseHeaders } from './lib.js';
import { handleWebDraft } from './draft.js';
import { handleReview } from './review.js';
import { DRAFT_TYPES, checkWorkKey, handleDraftRequest, saveReview } from './drafts.js';
import { NEWS_TYPES, handleNewsRequest, kstDate } from './news.js';
import { handlePostDigests } from './digests.js';
import { getPublishDates, sortByPublished } from './published.js';
import { IMAGE_TYPES, MARK_TYPES, handleImageRequest } from './images.js';
import { initProfile, profileInfo } from './profile.js';
import { handleThreadsDraft } from './threads.js';

// 아카이브 목록에 필요한 컬럼만 조회 (embedding·본문 전체 제외 → 응답 크기 대폭 감소)
const ARCHIVE_COLUMNS = 'id,created_at,title,summary,tags,source_url';
const ARCHIVE_LIMIT = 200;

// Gemini를 호출하는 웹 요청 타입 (Rate Limiting 대상)
const AI_TYPES = new Set(['web_draft', 'review', 'research', 'related_posts', 'post_digests', 'threads_draft']);

export default {
  async fetch(request, env, ctx) {
    initProfile(env);   // 이 Worker가 맡은 블로그 (BLOG_ID / BLOG_NAME)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Work-Key',
    };
    const jsonResponse = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST') return new Response('OK', { status: 200 });

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    if (body.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (body.event && body.event.type === 'app_mention') {
      if (request.headers.get('x-slack-retry-num')) return new Response('OK', { status: 200 });
      ctx.waitUntil(processSlackDraftRequest(body.event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), body.event.channel, body.event.ts, env, ctx));
      return new Response('OK', { status: 200 });
    }

    // Rate Limiting: IP당 분당 10회 (Gemini 호출 요청만)
    if (AI_TYPES.has(body.type) && env.AI_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.AI_LIMITER.limit({ key: `${body.type}:${ip}` });
      if (!success) return jsonResponse({ error: '요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.' }, 429);
    }

    if (body.type === 'get_init_data') {
      let archives = [];
      let latestNews = null;
      let latestBriefing = null;
      let latestIndices = null;
      let latestDate = null;
      let latestItems = null;
      let latestThemes = null;
      // 네이버 발행일은 다른 조회와 동시에 (6시간 캐시)
      const publishDatesPromise = getPublishDates(ctx);

      try {
        const sbRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/my_insights?select=${ARCHIVE_COLUMNS}&order=id.desc&limit=${ARCHIVE_LIMIT}`,
          { headers: supabaseHeaders(env) }
        );
        if (sbRes.ok) archives = sortByPublished(await sbRes.json(), await publishDatesPromise);
      } catch (e) {}

      try {
        const newsRes = await fetch(`${env.SUPABASE_URL}/rest/v1/daily_news?select=*&order=id.desc&limit=1`, {
          headers: supabaseHeaders(env)
        });
        if (newsRes.ok) {
          const newsRows = await newsRes.json();
          if (newsRows.length > 0) {
            const rawPayload = newsRows[0].sector_news || {};
            latestNews = rawPayload.news || rawPayload;
            latestBriefing = rawPayload.briefing || null;
            latestIndices = rawPayload.indices || null;
            latestItems = rawPayload.items || null;
            latestThemes = rawPayload.themes || null;
            latestDate = kstDate(newsRows[0].created_at);
          }
        }
      } catch (e) {}

      return jsonResponse({ news: latestNews, briefing: latestBriefing, archives, indices: latestIndices, items: latestItems, themes: latestThemes, news_date: latestDate, profile: profileInfo() });
    }

    if (body.type === 'post_digests') {
      try {
        const { status, json } = await handlePostDigests(body, env);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (NEWS_TYPES.has(body.type)) {
      try {
        const { status, json } = await handleNewsRequest(body, env, ctx);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (IMAGE_TYPES.has(body.type)) {
      // ★·숨기기·복사 횟수 저장은 작업 키가 맞을 때만
      if (MARK_TYPES.has(body.type)) {
        const auth = await checkWorkKey(request, env);
        if (auth === 'not_configured') return jsonResponse({ error: '서버에 작업 키(WORK_KEY)가 아직 설정되지 않았습니다.', code: 'work_key_not_configured' }, 503);
        if (auth !== 'ok') {
          if (env.AI_LIMITER) {
            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            const { success } = await env.AI_LIMITER.limit({ key: `auth:${ip}` });
            if (!success) return jsonResponse({ error: '요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.' }, 429);
          }
          return jsonResponse({ error: '작업 키가 올바르지 않습니다.', code: 'work_key_invalid' }, 401);
        }
      }
      try {
        const r = await handleImageRequest(body, env, ctx);
        if (r.binary) return new Response(r.binary, { status: 200, headers: { ...corsHeaders, 'Content-Type': r.contentType, 'Cache-Control': 'private, max-age=3600' } });
        return jsonResponse(r.json, r.status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (body.type === 'threads_draft') {
      try {
        const { status, json } = await handleThreadsDraft(body, env);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (body.type === 'web_draft') {
      try {
        const { status, json } = await handleWebDraft(body, env, ctx);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (body.type === 'review') {
      try {
        const { status, json } = await handleReview(body, env, ctx);
        // 초안 id가 있고 작업 키가 맞으면 첨삭 결과를 이력으로 저장
        if (status === 200 && body.draft_id && (await checkWorkKey(request, env)) === 'ok') {
          try {
            json.review_id = await saveReview(env, body.draft_id, body.body, json);
          } catch (e) {
            json.review_save_error = e.message;
          }
        }
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    if (DRAFT_TYPES.has(body.type)) {
      const auth = await checkWorkKey(request, env);
      if (auth === 'not_configured') {
        return jsonResponse({ error: '서버에 작업 키(WORK_KEY)가 아직 설정되지 않았습니다.', code: 'work_key_not_configured' }, 503);
      }
      if (auth !== 'ok') {
        // 키 추측 방지: 실패한 시도도 IP당 분당 10회로 제한
        if (env.AI_LIMITER) {
          const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
          const { success } = await env.AI_LIMITER.limit({ key: `auth:${ip}` });
          if (!success) return jsonResponse({ error: '요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.' }, 429);
        }
        return jsonResponse({ error: '작업 키가 올바르지 않습니다.', code: 'work_key_invalid' }, 401);
      }
      try {
        const { status, json } = await handleDraftRequest(body, env);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, e.status === 401 || e.status === 403 ? 500 : 502);
      }
    }

    return jsonResponse({ error: 'Invalid request' }, 400);
  }
};

const STUDIO_URL = 'https://haeng-woon-bok.github.io/second-brain-workspace/';
// waitUntil은 응답 후 약 30초까지만 보장되므로 Gemini 호출은 22초에서 끊는다
const SLACK_GEMINI_TIMEOUT_MS = 22000;

// Slack 멘션도 웹 ✨ 버튼과 같은 로직(내 초안 기반 + 내 문체)으로 정리
export function formatSlackDraft(result) {
  const m = result.meta || {};
  const pct = Math.round((m.ai_ratio || 0) * 100);
  const head = `📝 *내 문체로 정리한 초안* · AI가 덧붙인 문장 ${pct}%` + (m.gap_count ? ` · ✍️ 보충 필요 ${m.gap_count}곳` : '');
  const gaps = (m.gaps || []).length ? `\n\n*보충할 곳*\n${m.gaps.map(g => `• ${g}`).join('\n')}` : '';
  const foot = `\n\n_첨삭까지 이어서 하려면 웹 스튜디오에 붙여 넣으세요: ${STUDIO_URL}_`;
  return `${head}\n\n${result.draft}${gaps}${foot}`;
}

async function processSlackDraftRequest(prompt, channel, threadTs, env, ctx) {
  const postToSlack = (text) => fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, thread_ts: threadTs, text })
  });

  if (!prompt) {
    await postToSlack('✍️ 사용법: `@봇 생각나는 대로 쓴 초안` 을 보내면 내 블로그 문체로 정리해 드립니다. 초안에 없는 내용은 지어내지 않고 [✍️ 보충 필요]로 표시합니다.');
    return;
  }

  try {
    const { status, json } = await handleWebDraft({ memo: prompt }, env, ctx, { timeoutMs: SLACK_GEMINI_TIMEOUT_MS });
    if (status !== 200) throw new Error(json.error || `HTTP ${status}`);
    await postToSlack(formatSlackDraft(json));
  } catch (err) {
    await postToSlack(`⚠️ 초안 정리 실패: ${err.message}\n긴 초안은 웹 스튜디오에서 시도해 주세요: ${STUDIO_URL}`);
  }
}
