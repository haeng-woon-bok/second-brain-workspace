// web_draft: 사용자의 자유 초안 → "내 블로그 스타일" 글 + 해시태그
// 설계: docs/REVIEW_DESIGN.md 4.1
//
// 원칙
//  - 내용은 초안(+선택 뉴스)에서만. 빈 곳은 [✍️ 보충 필요: ...] 자리표시
//  - 형식은 내 과거 글 74편 기준선 + 유사 글 2편 문체 샘플
//  - 문단마다 origin(draft/bridge) 표시 → AI 추가 비율 계산

import { searchPastInsights, generateJson, normalize, supabaseHeaders } from './lib.js';
import { DEFAULT_PROFILE, getStyleProfile, styleBaselineText } from './style.js';
import { getFormatHabits } from './formatting.js';
import { getPublishDates, publishedOf } from './published.js';

// 필자 서식 습관 기본값 (2026-11-20, 최근 글 6편 측정: 1000자당 형광펜 3.5 / 소제목 1.3 / 구분선 1.5)
const DEFAULT_HABITS = { highlights_per_1000: 3.5, headings_per_1000: 1.3, dividers_per_1000: 1.5, highlight_examples: [], heading_examples: [] };

function formatRulesText(habits, maxChars) {
  const h = habits || DEFAULT_HABITS;
  const n = (per) => Math.max(1, Math.round(per * maxChars / 1000 * 0.8));
  const hl = (h.highlight_examples || []).slice(0, 10).map(t => `- ${t}`).join('\n');
  const hd = (h.heading_examples || []).slice(0, 6).map(t => `- ${t}`).join('\n');
  return `- 형광펜: 독자의 시선이 이어지길 바라는 핵심 구절을 text 안에서 ==구절== 로 감싸세요.
  한 문장 안의 구절만(문장 경계를 넘지 말 것). 결론·전환·숫자·독자에게 던지는 질문 같은 흐름의 고비에. 연달아 칠하지 말 것.
  글 전체에 ${n(h.highlights_per_1000)}개 안팎(필자 평균 1000자당 ${h.highlights_per_1000}개).
- 굵게(**...**)는 거의 쓰지 않습니다. 쓰지 마세요.
- 소제목: 글이 여러 묶음으로 나뉘면 각 묶음 첫 문단의 heading에 소제목(25자 이내)을 넣으세요. text에는 넣지 마세요.
  필자 평균 1000자당 ${h.headings_per_1000}개. 본문이 1200자 미만이면 소제목 없이.
- 구분선: 흐름이 바뀌는 문단(새 소제목 앞, insight 시작, outro 시작)은 divider_before=true. 글 전체에 ${n(h.dividers_per_1000)}개 안팎. 첫 문단에는 넣지 마세요.${hl ? `
[필자가 실제로 형광펜을 칠한 구절]
${hl}` : ''}${hd ? `
[필자의 실제 소제목]
${hd}` : ''}`;
}

// 같은 연재의 직전 글 (제목 앞부분이 5자 이상 같으면 연재로 봄, 그중 가장 최근 발행)
const titleKey = (t) => String(t || '').replace(/&[a-z#0-9]+;/gi, '').replace(/[^\p{L}\p{N}]/gu, '');
export function findSeriesPrev(title, archives, dates) {
  const k = titleKey(title);
  if (k.length < 5) return null;
  let best = null;
  for (const a of archives) {
    const ak = titleKey(a.title);
    if (!a.source_url || !ak || ak === k) continue;
    let i = 0;
    while (i < k.length && i < ak.length && k[i] === ak[i]) i++;
    if (i < 5) continue;
    const pub = publishedOf(a, dates) || String(a.created_at || '').slice(0, 10);
    if (!best || i > best.prefix || (i === best.prefix && pub > best.pub)) best = { ...a, prefix: i, pub };
  }
  return best;
}

async function fetchArchiveTitles(env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/my_insights?select=id,title,source_url,created_at&limit=1000`, { headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`my_insights HTTP ${res.status}`);
  return res.json();
}

const decodeTitle = (t) => String(t || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[\[\]]/g, '');

// 한 줄 안에서 짝이 안 맞는 ==, ** 는 지움 (문장 단위 줄바꿈 뒤 깨진 표시 정리)
export function fixMarks(line) {
  let s = String(line);
  if (((s.match(/==/g) || []).length) % 2) s = s.replace(/==/g, '');
  if (((s.match(/\*\*/g) || []).length) % 2) s = s.replace(/\*\*/g, '');
  return s.replace(/====/g, '');
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    paragraphs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          section: { type: 'STRING', enum: ['intro', 'body', 'insight', 'outro'] },
          heading: { type: 'STRING' },
          divider_before: { type: 'BOOLEAN' },
          text: { type: 'STRING' },
          origin: { type: 'STRING', enum: ['draft', 'bridge'] },
          draft_quote: { type: 'STRING' }
        },
        required: ['section', 'text', 'origin']
      }
    },
    related_posts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING', enum: ['이전글', '관련글'] },
          ref: { type: 'STRING' },
          after_paragraph: { type: 'INTEGER' }
        },
        required: ['label', 'ref', 'after_paragraph']
      }
    },
    gaps: { type: 'ARRAY', items: { type: 'STRING' } },
    hashtags: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['title', 'paragraphs', 'hashtags']
};

const GAP_MARK = '[✍️ 보충 필요';

// 메모 안의 "#태그"를 꼭 넣을 해시태그로 분리 (네이버처럼 "#금리 #재개발"로 쓰면 됨)
// 공백/줄 시작 뒤의 #만 태그로 본다 (C# 같은 단어 보호). 태그만 있던 줄은 메모에서 지운다.
export function splitMemoHashtags(memo) {
  const tags = [];
  const cleaned = String(memo || '').replace(/(^|[ \t\n,])#([^\s#.,!?()[\]{}"']{1,30})/g, (m, pre, tag) => {
    if (/^\d+$/.test(tag)) return m;            // "#1" 같은 숫자는 태그가 아님
    tags.push('#' + tag);
    return pre === ',' ? '' : pre;
  });
  const text = cleaned.split('\n').map(l => l.replace(/[ \t,]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { memo: text, tags: [...new Set(tags)].join(' ') };
}

// 요청 정규화: 신규(title/memo/tags/news) + 구형(prompt 문자열) 모두 지원
export function readDraftRequest(body) {
  if (typeof body.memo === 'string' || typeof body.title === 'string') {
    const news = body.news && typeof body.news === 'object' ? body.news : null;
    const split = splitMemoHashtags(body.memo);
    return {
      title: String(body.title || '').trim(),
      memo: split.memo,
      tags: [String(body.tags || '').trim(), split.tags].filter(Boolean).join(' '),
      news: news && news.title ? {
        title: String(news.title || ''), summary: String(news.summary || ''), link: String(news.link || '')
      } : null
    };
  }
  // 구형: "[참고 뉴스]: ...\n[제목]: ...\n[초안]: ..."
  const p = String(body.prompt || '');
  const pick = (label) => (p.match(new RegExp(`\\[${label}\\]:\\s*([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]:|$)`)) || [])[1]?.trim() || '';
  const newsTitle = pick('참고 뉴스');
  const split = splitMemoHashtags(pick('초안') || p);
  return {
    title: pick('제목'),
    memo: split.memo,
    tags: split.tags,
    news: newsTitle && newsTitle !== '없음' ? { title: newsTitle, summary: pick('참고 뉴스 요약'), link: '' } : null
  };
}

function buildPrompt(req, styleSamples, candidates, maxChars, profile = DEFAULT_PROFILE, habits = null, seriesPrev = null) {
  const samples = styleSamples.map((s, i) =>
    `<<문체 샘플 ${i + 1}: ${s.title}>>\n${(s.content_final || '').slice(0, 1200)}`).join('\n\n');
  const cands = candidates.map((c, i) => `P${i + 1}. ${c.title}`).join('\n') || '(없음)';
  const news = req.news
    ? `제목: ${req.news.title}\n요약: ${req.news.summary || '(없음)'}`
    : '(선택한 뉴스 없음)';

  return `당신은 블로거 "행운복의 재테크"(dad_luckyhappy)의 편집 보조입니다.
필자가 생각나는 대로 쓴 [초안]을, 필자가 평소 쓰는 블로그 글의 구조와 문체로 정리합니다.
당신은 글을 새로 쓰는 작가가 아니라, 필자의 생각을 정리하는 편집자입니다.

# 절대 규칙
1. [초안]과 [참고 뉴스]에 없는 사실, 수치, 날짜, 사례, 고유명사, 경험담을 새로 만들지 마세요.
2. 논리 전개상 필요한데 초안에 없는 내용은 지어내지 말고, 그 자리에 "[✍️ 보충 필요: 무엇을 쓰면 좋은지]"를 한 줄로 넣으세요. 같은 내용을 gaps 배열에도 넣으세요.
3. 각 문단의 origin:
   - "draft": 초안 내용을 다듬은 문단. draft_quote에 근거가 된 초안 원문을 **글자 그대로 복사**해 넣으세요(10~60자).
   - "bridge": 초안에 없는, 문단 연결이나 형식적인 도입·마무리 문장. 문단당 2문장 이하로 짧게.
4. 본문 전체 길이는 ${maxChars}자를 넘지 마세요. 초안이 짧으면 글도 짧아야 합니다. 분량을 채우려고 늘리지 마세요.
5. 초안에 있는 필자의 주장과 결론을 바꾸거나 약하게 만들지 마세요.

# 구조 (필자의 3단 서사)
- intro: 필자의 개인 맥락으로 시작 (왜 이 글을 쓰게 됐는지)
- body: 초안의 근거, 경험, 뉴스 내용
- insight: 필자의 관점과 판단 ("개인적으로 ~")
- outro: 여러분에게 건네는 한두 줄
문단 수는 초안 분량에 맞게 3~8개.

# 필자의 문체 기준 (과거 글 74편 분석)
${styleBaselineText(profile)}

# 서식 (필자가 네이버 블로그에서 쓰는 방식)
${formatRulesText(habits, maxChars)}

# 연결 글 (related_posts)
아래 후보 중 이 글과 실제로 관련 있는 것만 0~2개 고르고, ref에 번호(예: "P1")를 넣으세요.
after_paragraph는 그 링크를 넣을 문단 번호(0부터)입니다. 관련 없으면 빈 배열로 두세요.${seriesPrev ? `
같은 연재의 직전 글 「${decodeTitle(seriesPrev.title)}」은 도입 문단 뒤에 "이전글"로 자동으로 들어가니 고르지 마세요. 도입에서 "이전 글에서 ~" 처럼 이어 받으면 좋습니다.` : ''}
${cands}

# 해시태그
필자가 입력한 뷰 태그(${req.tags || '없음'})를 먼저 포함하고, 본문 핵심 키워드로 채워 **반드시 총 8~12개**.
hashtags 배열의 원소 하나에 태그 하나씩. "#"으로 시작, 띄어쓰기 없이. 예: ["#금리", "#재개발", "#분담금"]

# 제목
필자가 입력한 제목이 있으면 그대로 쓰고, 없으면 초안 내용으로 짓되 과장하지 마세요.

# 필자의 실제 글 (문체만 참고. 내용은 가져오지 마세요)
${samples || '(샘플 없음)'}

# [참고 뉴스]
${news}

# [필자가 입력한 제목]
${req.title || '(없음)'}

# [초안]
${req.memo}`;
}

// 모델이 ["#a','#b"] 처럼 한 문자열에 여러 태그를 넣는 경우가 있어 토큰 단위로 다시 분리
// - 사용자 입력: 공백/쉼표가 태그 구분자 ("#금리 재개발" → 2개)
// - 모델 출력: 원소 안의 쉼표·따옴표·'#'이 구분자, 공백은 태그 내부 띄어쓰기로 보고 제거 ("# 조합원 이야기" → #조합원이야기)
export function cleanHashtags(list, userTags) {
  const fromUser = String(userTags || '').split(/[\s,]+/);
  const fromModel = (Array.isArray(list) ? list : [list])
    .flatMap(t => String(t ?? '').split(/[,'"`\[\]()]+|(?=#)/));
  const all = [...fromUser, ...fromModel]
    .map(t => '#' + t.replace(/[#\s]+/g, ''))
    .filter(t => t.length > 1);
  return [...new Set(all)].slice(0, 12);
}

// 필자 글처럼 한 문장씩 줄바꿈 (평균 줄 길이 35자 기준선)
export function breakSentences(text) {
  return String(text)
    .split('\n')
    .map(line => line.replace(/([.?!])\s+(?=\S)/g, '$1\n'))
    .join('\n');
}

// 생성 결과 검증 + 최종 텍스트 조립
export function assembleDraft(req, out, candidates, seriesPrev = null) {
  const sources = normalize([req.memo, req.news?.title, req.news?.summary].filter(Boolean).join(' ').replace(/==|\*\*/g, ''));

  const paragraphs = (Array.isArray(out.paragraphs) ? out.paragraphs : [])
    .filter(p => p && typeof p.text === 'string' && p.text.trim())
    .map(p => {
      let origin = p.origin === 'draft' ? 'draft' : 'bridge';
      const quote = normalize(p.draft_quote);
      // 인용이 초안에 실제로 없으면 AI 추가분으로 재분류
      if (origin === 'draft' && (quote.length < 4 || !sources.includes(quote))) origin = 'bridge';
      const text = breakSentences(p.text.trim()).split('\n')
        .map(l => fixMarks(l).replace(/^\s*#{1,6}\s+/, '').replace(/^\s*-{3,}\s*$/, ''))
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const heading = String(p.heading || '').replace(/==|\*\*|#|\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      return { section: p.section || 'body', text, origin, heading, divider: !!p.divider_before };
    })
    .filter(p => p.text);

  // 연결 글: 같은 연재의 직전 글은 도입 뒤 "이전글"로 고정, 나머지는 RAG 후보 안의 것만 (지어낸 링크 차단)
  const related = [];
  if (seriesPrev && seriesPrev.source_url) {
    related.push({ label: '이전글', title: decodeTitle(seriesPrev.title), url: seriesPrev.source_url, after_paragraph: 0, series: true });
  }
  for (const r of (Array.isArray(out.related_posts) ? out.related_posts : [])) {
    const idx = parseInt(String(r.ref || '').replace(/\D/g, ''), 10) - 1;
    const c = candidates[idx];
    if (!c || !c.source_url || related.some(x => x.url === c.source_url)) continue;
    const after = Math.min(Math.max(parseInt(r.after_paragraph, 10) || 0, 0), Math.max(paragraphs.length - 1, 0));
    related.push({ label: r.label === '이전글' ? '이전글' : '관련글', title: decodeTitle(c.title), url: c.source_url, after_paragraph: after });
    if (related.length >= (seriesPrev ? 3 : 2)) break;
  }

  const hashtags = cleanHashtags(out.hashtags, req.tags);
  const title = req.title || String(out.title || '').trim();

  // 본문 표시: ---(구분선), ## 소제목, ==형광펜==, "이전글 : [제목](주소)" → 웹에서 네이버 서식으로 복사
  const blocks = [];
  paragraphs.forEach((p, i) => {
    if (p.divider && i > 0) blocks.push('---');
    if (p.heading) blocks.push(`## ${p.heading}`);
    blocks.push(p.text);
    related.filter(r => r.after_paragraph === i)
      .forEach(r => blocks.push(`${r.label} : [${r.title}](${r.url})`));
  });

  const bodyText = blocks.join('\n\n');
  const draft = [title, bodyText, hashtags.join(' ')].filter(Boolean).join('\n\n');

  const plainLen = (t) => t.replace(/==|\*\*/g, '').length;
  const totalChars = paragraphs.reduce((n, p) => n + plainLen(p.text), 0) || 1;
  const bridgeChars = paragraphs.filter(p => p.origin === 'bridge').reduce((n, p) => n + plainLen(p.text), 0);
  const gapCount = (draft.match(/\[✍️ 보충 필요/g) || []).length;

  return {
    draft,
    meta: {
      ai_ratio: Math.round((bridgeChars / totalChars) * 100) / 100,
      gap_count: gapCount,
      gaps: (Array.isArray(out.gaps) ? out.gaps : [])
        .map(g => String(g).replace(/^\s*\[?✍️?\s*보충 필요\s*:\s*/, '').replace(/\]\s*$/, '').trim())
        .filter(Boolean).slice(0, 8),
      hashtags,
      related_posts: related,
      paragraphs: paragraphs.map(p => ({ section: p.section, origin: p.origin, chars: plainLen(p.text) })),
      format: {
        highlights: (bodyText.match(/==[^=\n]+?==/g) || []).length,
        headings: paragraphs.filter(p => p.heading).length,
        dividers: blocks.filter(b => b === '---').length
      },
      body_chars: bodyText.length,
      memo_chars: req.memo.length
    }
  };
}

// opts.timeoutMs: Slack 경로처럼 시간 제한이 있는 곳에서 Gemini 호출을 끊기 위함
export async function handleWebDraft(body, env, ctx, opts = {}) {
  const req = readDraftRequest(body);
  if (!req.memo) {
    return { status: 400, json: { error: '초안 메모가 비어 있습니다.' } };
  }

  const query = [req.title, req.memo, req.news?.title].filter(Boolean).join('\n');
  // Slack 경로(시간 제한)에서는 네이버 조회를 건너뜀
  const naverOk = !opts.timeoutMs;
  const [pastResult, profile, habits, archives, dates] = await Promise.all([
    searchPastInsights(query, 4, env).catch(() => []),
    getStyleProfile(env, ctx),
    naverOk ? getFormatHabits(ctx) : null,
    req.title ? fetchArchiveTitles(env).catch(() => []) : [],
    naverOk && req.title ? getPublishDates(ctx) : {}
  ]);
  const past = pastResult || [];
  const seriesPrev = findSeriesPrev(req.title, archives || [], dates || {});

  const styleSamples = past.slice(0, 2);
  const candidates = past.filter(p => p.source_url && (!seriesPrev || p.source_url !== seriesPrev.source_url));
  const maxChars = Math.min(4200, Math.max(400, Math.round(req.memo.length * 2.5)));

  const out = await generateJson(buildPrompt(req, styleSamples, candidates, maxChars, profile, habits, seriesPrev), SCHEMA, env, { timeoutMs: opts.timeoutMs });
  const result = assembleDraft(req, out, candidates, seriesPrev);
  result.meta.max_chars = maxChars;
  return { status: 200, json: result };
}

export { GAP_MARK };
