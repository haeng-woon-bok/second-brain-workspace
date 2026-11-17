// 공통 헬퍼: Supabase / Gemini 호출

export const GEMINI_MODEL = 'gemini-3.8-flash';

export function supabaseHeaders(env) {
  return { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` };
}

// 문서는 파이프라인에서 retrieval_document로 임베딩되므로, 검색 질의는 RETRIEVAL_QUERY로 맞춘다.
export async function embedQuery(text, env) {
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

// match_past_insights: id, title, content_final, view_tags, created_at, similarity, source_url
export async function searchPastInsights(text, count, env) {
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

async function callGemini(body, env) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
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

// 자유 텍스트 생성 (Slack 봇용)
export async function generateText(prompt, env) {
  return callGemini({ contents: [{ parts: [{ text: prompt }] }] }, env);
}

// JSON 스키마를 강제한 생성
export async function generateJson(prompt, schema, env, { temperature = 0.6 } = {}) {
  const text = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  }, env);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini JSON 응답을 해석하지 못했습니다');
  }
}

// 비교용 정규화: 공백·줄바꿈 차이와 따옴표 종류를 무시
export function normalize(s) {
  return String(s || '')
    .replace(/[​ ]/g, ' ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
