// threads_draft: 발행한 블로그 글을 스레드(Threads)용 짧은 글 1~3개(타래)로 바꿈
// - 블로그 본문에 없는 내용은 만들지 않음
// - 게시물 하나 500자 이하 (스레드 제한). 블로그 링크는 마지막 게시물 끝에 프로그램이 붙임
import { generateJson } from './lib.js';
import { isMetaLine, stripFormatMarks } from './style.js';
import { blogName } from './profile.js';

const LIMIT = 500;
const MAX_POSTS = 4;
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

export async function handleThreadsDraft(body, env) {
  const title = String(body.title || '').trim().slice(0, 200);
  const text = plainBody(body.body).slice(0, 8000);
  const tone = TONES[body.tone] ? body.tone : 'polite';
  const url = /^https?:\/\/\S+$/.test(String(body.blog_url || '').trim()) ? String(body.blog_url).trim().slice(0, 300) : '';
  if (text.length < 50) return { status: 400, json: { error: '스레드로 바꿀 블로그 본문이 너무 짧습니다 (50자 이상).' } };

  const linkLine = url ? `\n\n전체 글은 블로그에서 👉 ${url}` : '';
  const prompt = `블로거 "${blogName()}"가 방금 발행한 블로그 글을 스레드(Threads)에 올릴 짧은 글로 바꿉니다.
스레드를 보는 사람이 "오, 이거 뭐지?" 하고 블로그까지 와 보고 싶게 만드는 것이 목적입니다.

# 규칙
- [블로그 본문]에 있는 사실·경험·숫자만 씁니다. 없는 내용, 과장, 확인되지 않은 수치를 만들지 마세요.
- 말투: ${TONES[tone]}
- posts는 1~3개. 내용이 짧으면 1개로 충분합니다. 여러 개면 타래로 이어지는 순서대로.
- 각 게시물은 ${LIMIT - 80}자 이내. 첫 게시물의 첫 줄은 시선을 끄는 한 문장(질문이나 의외의 사실).
- 한 줄은 짧게, 줄바꿈을 자주. 블로그 서식 기호(==, **, ##, ---)나 목록 기호는 쓰지 마세요. 이모지는 게시물당 0~2개.
- 마지막 게시물은 블로그로 이어지는 한 문장으로 끝내세요 (링크는 프로그램이 붙이니 주소는 쓰지 마세요).
- hashtags는 0~2개 ("#"으로 시작, 띄어쓰기 없이). 게시물 본문에는 넣지 마세요.
- image_hint: 블로그 글의 사진 중 스레드에 같이 올리면 좋을 장면을 한 줄로 (없으면 빈 문자열).

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
  posts = posts.flatMap(p => p.length > LIMIT ? splitLong(p, LIMIT) : [p]);
  const last = posts.length - 1;
  if (posts[last].length + tail.length > LIMIT) posts.push(tail.trim());
  else posts[last] += tail;
  posts = posts.slice(0, MAX_POSTS);

  return {
    status: 200,
    json: {
      posts: posts.map(p => ({ text: p, chars: [...p].length })),
      limit: LIMIT,
      tone,
      has_link: !!url,
      image_hint: String(out.image_hint || '').trim().slice(0, 100)
    }
  };
}
