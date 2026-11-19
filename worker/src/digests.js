// 과거 글 요약·키워드 (post_digests 테이블, SQL 005)
// 처음 요청될 때 Gemini로 만들어 저장하고, 이후에는 저장된 값을 그대로 쓴다.
import { supabaseHeaders, generateJson, GEMINI_MODEL } from './lib.js';

const MAX_IDS = 12;          // 한 번에 조회할 글 수
const MAX_GENERATE = 6;      // 한 번에 새로 만들 요약 수 (Gemini 1회)

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER' },
      summary: { type: 'STRING' },
      keywords: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['id', 'summary', 'keywords']
  }
};

function cleanText(s) {
  return String(s || '').replace(/[\u200B\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function sb(env, path, init = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...supabaseHeaders(env), ...(init.headers || {}) }
  });
}

export function sanitizeDigest(row) {
  const summary = String(row.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const keywords = [...new Set((Array.isArray(row.keywords) ? row.keywords : [])
    .map(k => String(k).replace(/^#/, '').replace(/\s+/g, '').trim())
    .filter(k => k && k.length <= 20))].slice(0, 5);
  return { summary, keywords };
}

async function generateDigests(posts, env) {
  const body = posts.map(p => `<<글 id=${p.id}>>\n제목: ${p.title}\n${cleanText(p.content_final).slice(0, 2500)}`).join('\n\n');
  const prompt = `아래는 한 블로거가 쓴 과거 글들입니다. 글마다 다음을 만드세요.
- summary: 이 글에서 필자가 한 이야기와 필자의 관점·결론을 2~3문장으로 요약. 존댓말 평서문("~했습니다")이 아니라 "~함", "~라고 봄" 같은 메모체로. 글에 없는 내용은 쓰지 말 것.
- keywords: 나중에 이 글을 다시 찾을 때 쓸 핵심 키워드 3~5개 (명사, 띄어쓰기 없이, # 없이)
id는 입력의 id를 그대로 쓰세요.

${body}`;
  const out = await generateJson(prompt, SCHEMA, env, { temperature: 0.3, timeoutMs: 25000 });
  const ids = new Set(posts.map(p => p.id));
  return (Array.isArray(out) ? out : [])
    .filter(r => ids.has(Number(r.id)))
    .map(r => ({ post_id: Number(r.id), ...sanitizeDigest(r), model: GEMINI_MODEL }))
    .filter(r => r.summary);
}

// { ids: [...] } → { digests: { [id]: {summary, keywords} }, pending: [아직 못 만든 id] }
export async function handlePostDigests(body, env) {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS);
  if (!ids.length) return { status: 400, json: { error: 'ids가 필요합니다.' } };

  const res = await sb(env, `post_digests?select=post_id,summary,keywords&post_id=in.(${ids.join(',')})`);
  if (res.status === 404 || res.status === 400) {
    // 테이블이 아직 없음 (SQL 005 미적용) → 요약 없이 동작
    return { status: 200, json: { digests: {}, pending: [], unavailable: true } };
  }
  if (!res.ok) throw new Error(`post_digests 조회 실패 (HTTP ${res.status})`);
  const digests = {};
  for (const r of await res.json()) digests[r.post_id] = { summary: r.summary, keywords: r.keywords || [] };

  const missing = ids.filter(id => !digests[id]);
  let pending = missing.slice(MAX_GENERATE);
  const toMake = missing.slice(0, MAX_GENERATE);
  if (toMake.length) {
    const pr = await sb(env, `my_insights?select=id,title,content_final&id=in.(${toMake.join(',')})`);
    const posts = pr.ok ? await pr.json() : [];
    if (posts.length) {
      try {
        const rows = await generateDigests(posts, env);
        if (rows.length) {
          const ins = await sb(env, 'post_digests', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(rows)
          });
          if (!ins.ok) console.warn('post_digests 저장 실패', ins.status, await ins.text());
        }
        for (const r of rows) digests[r.post_id] = { summary: r.summary, keywords: r.keywords };
      } catch (e) {
        console.warn('요약 생성 실패:', e.message);
      }
    }
    pending = pending.concat(toMake.filter(id => !digests[id]));
  }
  return { status: 200, json: { digests, pending } };
}
