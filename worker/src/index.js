// Cloudflare Worker: slack-second-brain
// 필요한 환경 변수: SUPABASE_URL, SUPABASE_KEY, GEMINI_API_KEY, SLACK_BOT_TOKEN

const GEMINI_MODEL = 'gemini-3.8-flash';
// 아카이브 목록에 필요한 컬럼만 조회 (embedding·본문 전체 제외 → 응답 크기 대폭 감소)
const ARCHIVE_COLUMNS = 'id,created_at,title,summary,tags,source_url';
const ARCHIVE_LIMIT = 200;

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
      if (!body.prompt || typeof body.prompt !== 'string') {
        return jsonResponse({ error: 'prompt가 비어 있습니다.' }, 400);
      }

      let contextStr = '';
      try {
        const pastInsights = await searchPastInsights(body.prompt, 3, env);
        pastInsights.forEach((item, idx) => {
          contextStr += `\n[과거 참고 글 ${idx + 1}] 제목: ${item.title}\n내용: ${(item.content_final || '').slice(0, 600)}\n`;
        });
      } catch (e) {}

      const draftPrompt = `블로그 에디터로서 다음 글을 3단 서사 구조로 완성해 주세요.\n[과거 참고 관점]${contextStr}\n[사용자 초안 및 뉴스]: ${body.prompt}`;

      try {
        const draft = await generateText(draftPrompt, env);
        return jsonResponse({ draft });
      } catch (e) {
        return jsonResponse({ error: e.message }, 502);
      }
    }

    return jsonResponse({ error: 'Invalid request' }, 400);
  }
};

function supabaseHeaders(env) {
  return { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` };
}

// 문서는 파이프라인에서 retrieval_document로 임베딩되므로, 검색 질의는 RETRIEVAL_QUERY로 맞춘다.
async function embedQuery(text, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.slice(0, 2000) }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: 768
      })
    }
  );
  const data = await res.json();
  return data.embedding?.values || [];
}

async function searchPastInsights(text, count, env) {
  const embedding = await embedQuery(text, env);
  if (embedding.length === 0) return [];
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_past_insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...supabaseHeaders(env) },
    body: JSON.stringify({ query_embedding: embedding, match_threshold: 0.1, match_count: count })
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// Gemini 응답이 비었거나(안전 필터 등) 오류면 예외를 던져 호출 측이 원인을 알 수 있게 한다.
async function generateText(prompt, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gemini API 오류 (HTTP ${res.status}): ${data.error?.message || '알 수 없음'}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'EMPTY';
    throw new Error(`Gemini 응답이 비어 있습니다 (사유: ${reason})`);
  }
  return text;
}

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
