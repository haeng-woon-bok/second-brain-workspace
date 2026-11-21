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

async function callGemini(body, env, timeoutMs) {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller?.signal }
    );
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

// 구글 검색을 붙인 생성: 답변 + 근거 페이지 목록 (도표용 자료 찾기)
export async function generateGrounded(prompt, env, { timeoutMs = 45000, temperature = 0.2 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature, maxOutputTokens: 4096 } }) }
    );
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`검색 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini 검색 오류 (HTTP ${res.status}): ${data.error?.message || '알 수 없음'}`);
  const cand = data.candidates?.[0] || {};
  const text = cand.content?.parts?.map(p => p.text || '').join('') || '';
  const meta = cand.groundingMetadata || {};
  const chunks = (meta.groundingChunks || []).map(c => ({ title: c.web?.title || '', url: c.web?.uri || '' }));
  // 답변 문장 뒤에 근거 번호 [1][2]를 붙여, 다음 단계가 어느 출처의 사실인지 알 수 있게
  let annotated = text;
  for (const s of (meta.groundingSupports || [])) {
    const seg = s.segment?.text;
    const idx = (s.groundingChunkIndices || []).filter(i => chunks[i]?.url).map(i => `[${i + 1}]`).join('');
    if (seg && idx && annotated.includes(seg)) annotated = annotated.replace(seg, `${seg} ${idx}`);
  }
  return { text: annotated, chunks, queries: meta.webSearchQueries || [] };
}

// 자유 텍스트 생성 (Slack 봇용)
export async function generateText(prompt, env) {
  return callGemini({ contents: [{ parts: [{ text: prompt }] }] }, env);
}

// JSON 스키마를 강제한 생성
export async function generateJson(prompt, schema, env, { temperature = 0.6, timeoutMs } = {}) {
  const text = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  }, env, timeoutMs);
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
