// threads_draft: 발행한 블로그 글을 스레드(Threads)용 짧은 글 1~3개(타래)로 바꿈
// - 블로그 본문에 없는 내용은 만들지 않음
// - 게시물 하나 500자 이하 (스레드 제한). 블로그 링크는 마지막 게시물 끝에 프로그램이 붙임
import { generateJson, supabaseHeaders } from './lib.js';
import { isMetaLine, stripFormatMarks } from './style.js';
import { blogName } from './profile.js';
import { getPublishDates, publishedOf } from './published.js';

// 지난 글 올리기: threads_queue (SQL 009)
export const THREADS_TYPES = new Set(['threads_queue_get', 'threads_queue_build', 'threads_mark']);
export const THREADS_KEY_TYPES = new Set(['threads_queue_build', 'threads_mark']);   // 작업 키 필요

async function sb(env, path, init = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init, headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

const LIMIT = 500;
const MAX_POSTS = 8;
// 분량: 본문 길이에 맞춰 게시물 수를 정함 (짧게·보통·길게)
function lengthRule(len, textLen) {
  if (len === 'short') return 'posts는 1~2개. 가장 눈길 가는 한두 가지만 맛보기로 보여 주세요.';
  if (len === 'long') return 'posts는 4~7개. 글의 흐름(계기 → 과정 → 숫자·경험 → 배운 점)을 따라 핵심 내용을 충분히 풀어 쓰세요. 게시물마다 하나의 장면이나 요점을 담고, 각 게시물을 300~420자 정도로 채우세요. 다만 가장 중요한 결론이나 팁 하나는 블로그에서 보도록 남겨 두세요.';
  const n = textLen < 1500 ? '1~2' : textLen < 4000 ? '2~4' : '3~5';
  return `posts는 ${n}개 (블로그 본문 ${textLen}자 기준). 게시물마다 하나의 요점을 담고, 너무 짧게 끝내지 말고 각 게시물을 200~420자 정도로 채우세요.`;
}
const TONES = {
  polite: '가벼운 존댓말 ("~했어요", "~더라고요"). 블로그보다 짧고 편하게, 친구에게 근황을 말하듯',
  casual: '편한 반말 ("~했다", "~더라", "~인 듯"). 혼잣말이나 일기처럼 짧고 솔직하게'
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    posts: { type: 'ARRAY', items: { type: 'STRING' } },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
    image_hint: { type: 'STRING' }
  },
  required: ['posts']
};

// 블로그 서식·이미지 자리·연결 글·해시태그 줄을 뺀 본문
function plainBody(body) {
  const lines = String(body || '').split('\n').filter(l => !isMetaLine(l) && !/^#\S/.test(l.trim()));
  return stripFormatMarks(lines.join('\n')).replace(/\[✍️[^\]]*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 너무 긴 게시물은 문장 경계에서 나눔
function splitLong(text, max) {
  const out = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?。…~])\s+|\n+/)) {
    if (!s.trim()) continue;
    const next = cur ? `${cur}\n${s.trim()}` : s.trim();
    if (next.length <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = s.trim().slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

export async function handleThreadsDraft(body, env, ctx) {
  let title = String(body.title || '').trim().slice(0, 200);
  let raw = body.body;
  let url = /^https?:\/\/\S+$/.test(String(body.blog_url || '').trim()) ? String(body.blog_url).trim().slice(0, 300) : '';
  let pastDate = '';
  // 지난 글: DB에 있는 본문·주소·발행일로
  const postId = Number(body.post_id);
  if (Number.isInteger(postId) && postId > 0) {
    const res = await sb(env, `my_insights?select=id,title,content_final,source_url,created_at&id=eq.${postId}`);
    const row = res.ok ? (await res.json())[0] : null;
    if (!row) return { status: 404, json: { error: '글을 찾을 수 없습니다.' } };
    title = String(row.title || '').slice(0, 200);
    raw = row.content_final || '';
    url = row.source_url || url;
    pastDate = publishedOf(row, await getPublishDates(ctx)) || String(row.created_at || '').slice(0, 10);
  }
  const text = plainBody(raw).slice(0, 12000);
  const tone = TONES[body.tone] ? body.tone : 'polite';
  const len = ['short', 'normal', 'long'].includes(body.length) ? body.length : 'normal';
  if (text.length < 50) return { status: 400, json: { error: '스레드로 바꿀 블로그 본문이 너무 짧습니다 (50자 이상).' } };
  // 한 달 안에 쓴 글은 "지난 글" 말머리 없이
  if (pastDate && (Date.now() - Date.parse(pastDate)) / 864e5 < 30) pastDate = '';
  const pastRule = pastDate ? `
- 이 글은 ${pastDate}에 쓴 **지난 글**입니다. 첫 게시물 첫 줄에서 예전에 쓴 글이라는 것을 자연스럽게 밝히세요 (예: "${pastDate.slice(0, 7).replace('-', '년 ')}월에 블로그에 썼던 이야기인데요").
- 시세·금리·뉴스처럼 시점이 중요한 내용은 "당시에는"처럼 그때 기준임을 분명히 하고, 지금도 그렇다고 단정하지 마세요.` : '';

  const linkLine = url ? `\n\n전체 글은 블로그에서 👉 ${url}` : '';
  const prompt = `블로거 "${blogName()}"가 방금 발행한 블로그 글을 스레드(Threads)에 올릴 짧은 글로 바꿉니다.
스레드를 보는 사람이 "오, 이거 뭐지?" 하고 블로그까지 와 보고 싶게 만드는 것이 목적입니다.

# 규칙
- [블로그 본문]에 있는 사실·경험·숫자만 씁니다. 없는 내용, 과장, 확인되지 않은 수치를 만들지 마세요.
- 말투: ${TONES[tone]}
- ${lengthRule(len, text.length)} 여러 개면 타래로 이어지는 순서대로, 앞 게시물을 읽고 다음 게시물이 궁금해지도록.
- 각 게시물은 ${LIMIT - 80}자 이내. 첫 게시물의 첫 줄은 시선을 끄는 한 문장(질문이나 의외의 사실).
- 한 줄은 짧게, 줄바꿈을 자주. 블로그 서식 기호(==, **, ##, ---)나 목록 기호는 쓰지 마세요. 이모지는 게시물당 0~2개.
- 마지막 게시물은 블로그로 이어지는 한 문장으로 끝내세요 (링크는 프로그램이 붙이니 주소는 쓰지 마세요).
- hashtags는 0~2개 ("#"으로 시작, 띄어쓰기 없이). 게시물 본문에는 넣지 마세요.
- image_hint: 블로그 글의 사진 중 스레드에 같이 올리면 좋을 장면을 한 줄로 (없으면 빈 문자열).${pastRule}

# [블로그 제목]
${title || '(없음)'}

# [블로그 본문]
${text}`;

  const out = await generateJson(prompt, SCHEMA, env, { temperature: 0.6 });
  const tags = (Array.isArray(out.hashtags) ? out.hashtags : [])
    .map(t => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 1).slice(0, 2);
  let posts = (Array.isArray(out.posts) ? out.posts : [])
    .map(p => String(p || '').replace(/https?:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean);
  if (!posts.length) throw new Error('스레드 글을 만들지 못했습니다. 다시 시도해 주세요.');

  // 해시태그·링크를 마지막 게시물에 붙인 뒤 글자 수 맞추기
  const tail = (tags.length ? `\n\n${tags.join(' ')}` : '') + linkLine;
  posts = posts.flatMap(p => p.length > LIMIT ? splitLong(p, LIMIT) : [p]).slice(0, MAX_POSTS);
  const last = posts.length - 1;
  if (posts[last].length + tail.length > LIMIT) posts.push(tail.trim());
  else posts[last] += tail;

  return {
    status: 200,
    json: {
      posts: posts.map(p => ({ text: p, chars: [...p].length })),
      limit: LIMIT,
      tone,
      has_link: !!url,
      blog_url: url,
      title,
      past_date: pastDate || null,
      image_hint: String(out.image_hint || '').trim().slice(0, 100)
    }
  };
}

// ---------- 지난 글 올리기 순서 ----------
const BUCKETS = ['evergreen', 'series', 'dated'];
const QUEUE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER' },
      bucket: { type: 'STRING', enum: BUCKETS },
      series: { type: 'STRING' },
      priority: { type: 'INTEGER' },
      reason: { type: 'STRING' }
    },
    required: ['id', 'bucket', 'priority']
  }
};

async function tableMissing(res) {
  if (res.ok) return false;
  const t = await res.clone().text();
  return /threads_queue/.test(t) || res.status === 404;
}

export async function handleThreadsQueue(body, env, ctx) {
  if (body.type === 'threads_queue_get') {
    const res = await sb(env, 'threads_queue?select=post_id,bucket,series,priority,reason,posted_at&limit=2000');
    if (await tableMissing(res)) return { status: 200, json: { ready: false, queue: [] } };
    if (!res.ok) throw new Error(`threads_queue HTTP ${res.status}`);
    return { status: 200, json: { ready: true, queue: await res.json() } };
  }

  if (body.type === 'threads_mark') {
    const id = Number(body.post_id);
    if (!Number.isInteger(id) || id <= 0) return { status: 400, json: { error: 'post_id가 필요합니다.' } };
    const row = { post_id: id, posted_at: body.posted === false ? null : new Date().toISOString(), updated_at: new Date().toISOString() };
    const res = await sb(env, 'threads_queue?on_conflict=post_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row) });
    if (await tableMissing(res)) return { status: 503, json: { error: '스레드 기록 표가 아직 없습니다 (SQL 009 실행 필요).', code: 'table_missing' } };
    if (!res.ok) throw new Error(`올림 표시 저장 실패 (HTTP ${res.status})`);
    return { status: 200, json: { mark: (await res.json())[0] } };
  }

  // threads_queue_build: 아직 분류하지 않은 글(또는 rebuild면 전부)을 AI가 한 번에 분류
  const [qRes, pRes, dRes, dates] = await Promise.all([
    sb(env, 'threads_queue?select=post_id,bucket&limit=2000'),
    sb(env, 'my_insights?select=id,title,source_url,created_at&limit=1000'),
    sb(env, 'post_digests?select=post_id,summary&limit=2000'),
    getPublishDates(ctx)
  ]);
  if (await tableMissing(qRes)) return { status: 503, json: { error: '스레드 기록 표가 아직 없습니다 (SQL 009 실행 필요).', code: 'table_missing' } };
  const done = new Set((await qRes.json()).filter(r => r.bucket).map(r => r.post_id));
  const digests = new Map((dRes.ok ? await dRes.json() : []).map(d => [d.post_id, d.summary]));
  const posts = (pRes.ok ? await pRes.json() : [])
    .filter(p => p.source_url && (body.rebuild || !done.has(p.id)))
    .map(p => ({ id: p.id, title: p.title, date: publishedOf(p, dates) || String(p.created_at).slice(0, 10), summary: String(digests.get(p.id) || '').slice(0, 160) }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 150);
  if (!posts.length) return { status: 200, json: { classified: 0 } };

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `블로그 지난 글들을 스레드(Threads)에 하루 한 편씩 다시 소개하려고 합니다. 오늘은 ${today}입니다.
각 글을 아래 셋 중 하나로 분류하고, 먼저 올릴 순서를 정해 주세요.

- evergreen: 지금 읽어도 의미 있는 글 (경험담, 정리 글, 전략, 후기, 개인 이야기)
- series: 같은 주제가 여러 편으로 이어지는 연재의 한 편 (제목에 "#1", "1편", "마무리", 같은 이야기의 연속 등). series에 연재 이름을 짧게
- dated: 그날의 뉴스·시세·지수 반응처럼 시점이 지나 지금 올리면 오해를 줄 수 있는 글

priority: 1(가장 먼저 올리면 좋은 글, 반응이 좋을 만한 강한 이야기) ~ 5(나중에). dated는 대부분 4~5.
reason: 15자 이내 이유.
모든 글에 대해 하나씩, id를 그대로 써서 JSON 배열로만 답하세요.

# 글 목록 (id | 발행일 | 제목 | 요약)
${posts.map(p => `${p.id} | ${p.date} | ${p.title} | ${p.summary}`).join('\n')}`;

  const out = await generateJson(prompt, QUEUE_SCHEMA, env, { temperature: 0.2 });
  const valid = new Set(posts.map(p => p.id));
  const now = new Date().toISOString();
  const rows = (Array.isArray(out) ? out : [])
    .filter(r => valid.has(Number(r.id)) && BUCKETS.includes(r.bucket))
    .map(r => ({
      post_id: Number(r.id), bucket: r.bucket,
      series: r.bucket === 'series' ? String(r.series || '').trim().slice(0, 40) || null : null,
      priority: Math.min(5, Math.max(1, Math.round(Number(r.priority) || 3))),
      reason: String(r.reason || '').trim().slice(0, 40) || null,
      updated_at: now
    }));
  if (rows.length) {
    // posted_at은 보내지 않으므로 이미 올린 기록은 그대로 남음
    const res = await sb(env, 'threads_queue?on_conflict=post_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
    if (!res.ok) throw new Error(`분류 저장 실패 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return { status: 200, json: { classified: rows.length, asked: posts.length } };
}
