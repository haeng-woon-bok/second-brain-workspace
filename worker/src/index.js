// Cloudflare Worker: slack-second-brain
// 필요한 환경 변수: SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, SLACK_BOT_TOKEN
// 바인딩: AI_LIMITER (Rate Limiting, wrangler.toml)

import { supabaseHeaders, searchPastInsights, generateText } from './lib.js';
import { handleWebDraft } from './draft.js';

// 아카이브 목록에 필요한 컬럼만 조회 (embedding·본문 전체 제외 → 응답 크기 대폭 감소)
const ARCHIVE_COLUMNS = 'id,created_at,title,summary,tags,source_url';
const ARCHIVE_LIMIT = 200;

// Gemini를 호출하는 웹 요청 타입 (Rate Limiting 대상)
const AI_TYPES = new Set(['web_draft', 'review', 'research']);

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
      ctx.waitUntil(processSlackDraftRequest(body.event.text.replace(/<@[A-Z0-9]+>/g, '').trim(), body.event.channel, body.event.ts, env));
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

      try {
        const sbRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/my_insights?select=${ARCHIVE_COLUMNS}&order=id.desc&limit=${ARCHIVE_LIMIT}`,
          { headers: supabaseHeaders(env) }
        );
        if (sbRes.ok) archives = await sbRes.json();
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
          }
        }
      } catch (e) {}

      return jsonResponse({ news: latestNews, briefing: latestBriefing, archives, indices: latestIndices });
    }

    if (body.type === 'web_draft') {
      try {
        const { status, json } = await handleWebDraft(body, env);
        return jsonResponse(json, status);
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    return jsonResponse({ error: 'Invalid request' }, 400);
  }
};

async function processSlackDraftRequest(prompt, channel, threadTs, env) {
  const postToSlack = (text) => fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, thread_ts: threadTs, text })
  });

  try {
    let contextStr = '';
    const pastInsights = await searchPastInsights(prompt, 3, env);
    pastInsights.forEach((item, idx) => {
      contextStr += `\n--- [과거 참고 글 ${idx + 1}] ---\n제목: ${item.title}\n내용: ${(item.content_final || '').slice(0, 800)}\n`;
    });

    const draftPrompt = `블로그 에디터로서 다음 초안을 다듬어주세요.\n[과거 참고자료]${contextStr}\n[사용자 초안]${prompt}`;
    const generatedDraft = await generateText(draftPrompt, env);
    await postToSlack(`📝 *요청하신 글감 초안:*\n\n${generatedDraft}`);
  } catch (err) {
    await postToSlack(`⚠️ 오류 발생: ${err.message}`);
  }
}
