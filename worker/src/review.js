// review: 캔버스 본문 첨삭 (논리·구조 / 내 문체 / 가독성), 문단 단위 수정안
// 설계: docs/REVIEW_DESIGN.md 4.2
//
// - 코멘트는 반드시 본문 인용(target)에 붙는다. 본문에서 위치를 못 찾으면 버린다.
// - 수정안(suggestion)은 target 길이의 2배 이하만 허용 (새 내용으로 부풀리기 방지)
// - 문체 수치(줄 길이, 어미 비율, 이모지)는 모델이 아니라 여기서 직접 계산

import { searchPastInsights, generateJson } from './lib.js';

// 필자 74편 기준선 (2026-11-18 재분석, 5,161문장)
//  어미: ~니다 49% · ~요 13%(~는데요 8%, 질문형 ~신가요/~을까요 포함) · 평서 반말 ~다 3% · 어미 없는 줄 35%
const BASELINE = { avgChars: 2358, minChars: 1187, maxChars: 4222, avgLine: 35, nida: 49, yo: 13, plainDa: 3 };
const MAX_COMMENTS = 10;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    structure: {
      type: 'OBJECT',
      properties: {
        intro: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['ok', 'weak', 'missing'] }, comment: { type: 'STRING' } }, required: ['status', 'comment'] },
        body: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['ok', 'weak', 'missing'] }, comment: { type: 'STRING' } }, required: ['status', 'comment'] },
        insight: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['ok', 'weak', 'missing'] }, comment: { type: 'STRING' } }, required: ['status', 'comment'] }
      },
      required: ['intro', 'body', 'insight']
    },
    comments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', enum: ['logic', 'structure', 'style', 'readability'] },
          severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          target: { type: 'STRING' },
          comment: { type: 'STRING' },
          suggestion: { type: 'STRING' }
        },
        required: ['category', 'severity', 'target', 'comment']
      }
    }
  },
  required: ['structure', 'comments']
};

// 첨삭 대상에서 제외할 줄: 해시태그 줄, URL, 연결 글 라벨
function isMetaLine(line) {
  const t = line.trim();
  return /^https?:\/\//.test(t) || /^(이전글|관련글)\s*:?\s*$/.test(t) || /^(#[^\s#]+\s*){2,}$/.test(t);
}

export function computeStyleStats(body) {
  const lines = String(body).split('\n').map(l => l.trim()).filter(l => l && !isMetaLine(l));
  const text = lines.join('\n');
  // 어미 판별 전에 문장 끝 이모지·기호 제거 ("봐요. 😀" → "봐요.")
  const sentences = text.split(/(?<=[.?!])\s+|\n/)
    .map(s => s.replace(/[\p{Extended_Pictographic}️\s*~]+$/gu, '').trim())
    .filter(s => s.length > 3);
  const ends = { nida: 0, yo: 0, plainDa: 0 };
  for (const s of sentences) {
    if (/니다[.?!]?$|니까[.?!]?$/.test(s)) ends.nida++;
    else if (/요[.?!]?$/.test(s)) ends.yo++;
    else if (/다[.?!]?$/.test(s)) ends.plainDa++;
  }
  const n = sentences.length || 1;
  const avgLine = lines.length ? Math.round(lines.reduce((a, l) => a + l.length, 0) / lines.length) : 0;
  const longLines = lines.filter(l => l.length > 60).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).filter(e => e !== '✍').length;
  const markdown = (text.match(/^\s*(#{1,6}\s|[-*]\s|>\s)|\*\*[^*\n]+\*\*/gm) || []).length;
  const gaps = (String(body).match(/\[✍️ 보충 필요/g) || []).length;

  const notes = [];
  if (text.length < BASELINE.minChars) notes.push(`본문 ${text.length.toLocaleString()}자: 평소 글(평균 ${BASELINE.avgChars.toLocaleString()}자, 최소 ${BASELINE.minChars.toLocaleString()}자)보다 짧습니다.`);
  if (text.length > BASELINE.maxChars) notes.push(`본문 ${text.length.toLocaleString()}자: 평소 가장 긴 글(${BASELINE.maxChars.toLocaleString()}자)보다 깁니다.`);
  if (avgLine > 45) notes.push(`평균 줄 길이 ${avgLine}자: 평소(${BASELINE.avgLine}자)보다 깁니다. 의미 단위로 줄을 바꿔 보세요.`);
  if (longLines) notes.push(`60자가 넘는 줄 ${longLines}개`);
  const pct = (k) => Math.round(ends[k] / n * 100);
  if (pct('plainDa') > 10) notes.push(`반말 평서형(~한다/~이다) 문장 ${ends.plainDa}개 (${pct('plainDa')}%): 평소 글은 ${BASELINE.plainDa}%뿐이고 "~습니다"가 기본입니다.`);
  if (pct('yo') > 30) notes.push(`"~요"로 끝나는 문장 ${pct('yo')}%: 평소(${BASELINE.yo}%, 주로 "~는데요"와 질문)보다 많습니다.`);
  if (emoji) notes.push(`이모지 ${emoji}개: 평소 글 본문에는 이모지를 쓰지 않습니다.`);
  if (markdown) notes.push(`마크다운 기호 ${markdown}곳: 네이버 블로그에 그대로 보이니 지워 주세요.`);
  if (gaps) notes.push(`아직 채우지 않은 [✍️ 보충 필요] ${gaps}곳`);

  return {
    chars: text.length, lines: lines.length, avg_line: avgLine, long_lines: longLines,
    endings: { nida: pct('nida'), yo: pct('yo'), plain_da: pct('plainDa') },
    emoji, markdown, gaps, notes
  };
}

// 모델이 인용한 target을 본문의 정확한 부분 문자열로 복원 (공백·줄바꿈 차이 허용)
export function locateTarget(body, target) {
  const t = String(target || '').trim();
  if (t.length < 4) return null;
  if (body.includes(t)) return t;
  const words = t.split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return null;
  const m = body.match(new RegExp(words.join('\\s+')));
  return m ? m[0] : null;
}

export function validateComments(body, rawComments) {
  const seen = new Set();
  const out = [];
  for (const c of (Array.isArray(rawComments) ? rawComments : [])) {
    if (!c || !c.comment) continue;
    const target = locateTarget(body, c.target);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    let suggestion = typeof c.suggestion === 'string' ? c.suggestion.trim() : '';
    // 수정안이 원문과 같거나, 원문의 2배를 넘게 부풀리면 수정안만 버린다
    if (!suggestion || suggestion === target.trim() || suggestion.length > target.length * 2 + 20) suggestion = null;
    out.push({
      category: ['logic', 'structure', 'style', 'readability'].includes(c.category) ? c.category : 'readability',
      severity: ['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'low',
      target,
      comment: String(c.comment).trim(),
      suggestion
    });
  }
  out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return out.slice(0, MAX_COMMENTS).map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

function buildPrompt(req, samples, stats) {
  const sampleText = samples.map((s, i) => `<<필자 글 ${i + 1}: ${s.title}>>\n${(s.content_final || '').slice(0, 900)}`).join('\n\n');
  return `당신은 블로거 "행운복의 재테크"(dad_luckyhappy)의 첨삭 편집자입니다.
필자가 쓴 [본문]을 읽고 문제가 있는 곳에 코멘트를 답니다. 글을 새로 쓰지 말고, 지적과 문단 단위 수정안만 제시하세요.

# 볼 것 (이 3가지만)
1. logic / structure (논리·구조)
   - 비약, 과한 일반화("무조건", "절대"), 근거와 결론이 맞지 않는 곳
   - [원래 초안]에 없던 주장이나 의견이 본문에 들어가 있으면 반드시 지적 (필자가 직접 쓴 것인지 확인 요청)
   - 3단 서사: intro(개인 맥락) → body(근거·경험) → insight(필자의 관점·판단). 빠지거나 약한 단계
   - 문단 순서가 어색하거나 같은 말을 반복하는 곳
2. style (필자 문체 일관성)
   - 필자는 합쇼체 "~습니다/~ㅂ니다"가 기본. "~는데요/~인데요"(도입·전환)와 독자 질문 "~신가요?/~을까요?"는 필자 말투가 맞음
   - 평서 반말 "~한다./~이다./~있다."는 거의 쓰지 않음(3%) → 이런 문장은 style로 지적. 이모지·마크다운 기호도 쓰지 않음
   - 도입은 "저는 ~했는데요."처럼 개인 맥락, 마무리는 "여러분"에게 건네는 말
   - 아래 [필자 글]과 말투가 크게 다른 문단
3. readability (가독성)
   - 너무 긴 문장, 모호한 지시어("이것", "그런"), 중복 표현, 한 문단에 주제가 여러 개

# 규칙
- target에는 [본문]의 문장이나 문단을 **글자 그대로** 복사하세요. 한 글자라도 바꾸면 코멘트가 버려집니다.
- suggestion은 target을 대체할 문단 단위 수정안입니다. target 길이의 2배를 넘기지 말고, [본문]과 [원래 초안]에 없는 사실·수치·경험을 새로 넣지 마세요. 지적만 하고 고칠 필요가 없으면 suggestion을 빈 문자열로 두세요.
- 해시태그 줄, URL, "이전글 :"/"관련글 :" 줄, "[✍️ 보충 필요: ...]" 표시는 첨삭하지 마세요.
- 코멘트는 중요한 것부터 최대 ${MAX_COMMENTS}개. 문제가 없으면 적게 다세요. 칭찬용 코멘트는 달지 마세요.
- structure의 각 comment는 한 문장으로.

# 자동 측정 결과 (참고)
본문 ${stats.chars}자, 평균 줄 길이 ${stats.avg_line}자(필자 평균 ${BASELINE.avgLine}자), 어미 비율 ~니다 ${stats.endings.nida}% / ~요 ${stats.endings.yo}% / 반말 ~다 ${stats.endings.plain_da}% (필자 평균 ${BASELINE.nida}% / ${BASELINE.yo}% / ${BASELINE.plainDa}%)

# [필자 글] (문체 기준)
${sampleText || '(없음)'}

# [원래 초안] (필자가 처음 쓴 메모)
${req.memo || '(없음)'}

# [제목]
${req.title || '(없음)'}

# [본문]
${req.body}`;
}

export async function handleReview(body, env) {
  const req = {
    title: String(body.title || '').trim(),
    body: String(body.body || ''),
    memo: String(body.memo || '').trim()
  };
  if (req.body.trim().length < 50) {
    return { status: 400, json: { error: '첨삭할 본문이 너무 짧습니다 (50자 이상).' } };
  }
  if (req.body.length > 12000) {
    return { status: 400, json: { error: '본문이 너무 깁니다 (12,000자 이하).' } };
  }

  const stats = computeStyleStats(req.body);
  let samples = [];
  try {
    samples = (await searchPastInsights([req.title, req.body.slice(0, 1500)].join('\n'), 2, env));
  } catch (e) {}

  const out = await generateJson(buildPrompt(req, samples, stats), SCHEMA, env, { temperature: 0.3 });

  const structure = {};
  for (const k of ['intro', 'body', 'insight']) {
    const s = out.structure?.[k] || {};
    structure[k] = {
      status: ['ok', 'weak', 'missing'].includes(s.status) ? s.status : 'weak',
      comment: String(s.comment || '').trim()
    };
  }

  const comments = validateComments(req.body, out.comments);
  return {
    status: 200,
    json: {
      structure,
      comments,
      style: stats,
      // 위치를 못 찾았거나 개수 제한으로 버린 코멘트 수 (품질 점검용)
      dropped: Math.max(0, (Array.isArray(out.comments) ? out.comments.length : 0) - comments.length)
    }
  };
}
