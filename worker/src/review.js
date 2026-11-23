// review: 캔버스 본문 첨삭 (논리·구조 / 내 문체 / 가독성), 문단 단위 수정안
// 설계: docs/REVIEW_DESIGN.md 4.2
//
// - 코멘트는 반드시 본문 인용(target)에 붙는다. 본문에서 위치를 못 찾으면 버린다.
// - 수정안(suggestion)은 target 길이의 2배 이하만 허용 (새 내용으로 부풀리기 방지)
// - 문체 수치(줄 길이, 어미 비율, 이모지)는 모델이 아니라 여기서 직접 계산

import { searchPastInsights, generateJson } from './lib.js';
import { DEFAULT_PROFILE, getStyleProfile, isMetaLine, splitSentences, classifyEnding, cleanLine, stripFormatMarks } from './style.js';
import { blogId, blogName, isOwner } from './profile.js';

// 필자 기준선: style_profile(자동 계산, 24시간마다 갱신)에서 가져옴. 없으면 DEFAULT_PROFILE
const toBaseline = (p = DEFAULT_PROFILE) => ({
  avgChars: p.chars.avg, minChars: p.chars.min, maxChars: p.chars.max, p10: p.chars.p10 || p.chars.min,
  avgLine: p.avg_line, nida: p.endings.nida, yo: p.endings.yo, plainDa: p.endings.plain_da,
  emojiPerPost: p.habits?.emoji_per_post ?? 0, posts: p.posts
});
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

// 첨삭 대상에서 제외할 줄(해시태그 줄, URL, 연결 글 라벨)은 style.js isMetaLine
export function computeStyleStats(body, profile = DEFAULT_PROFILE) {
  const BASELINE = toBaseline(profile);
  const lines = stripFormatMarks(String(body).split('\n').filter(l => !isMetaLine(l)).join('\n'))
    .split('\n').map(cleanLine).filter(l => l.length > 1 && !isMetaLine(l));
  const text = lines.join('\n');
  // 어미 판별 전에 문장 끝 이모지·기호 제거 ("봐요. 😀" → "봐요.")
  const sentences = splitSentences(text);
  const ends = { nida: 0, yo: 0, plainDa: 0 };
  for (const s of sentences) {
    const e = classifyEnding(s);
    if (e === 'nida') ends.nida++;
    else if (e === 'yo') ends.yo++;
    else if (e === 'plain_da') ends.plainDa++;
  }
  const n = sentences.length || 1;
  const avgLine = lines.length ? Math.round(lines.reduce((a, l) => a + l.length, 0) / lines.length) : 0;
  const longLines = lines.filter(l => l.length > 60).length;
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) || []).filter(e => e !== '✍').length;
  // 네이버 서식 표시(##, **, ==, ---)는 허용. 그 밖의 마크다운(# 제목, - 목록, > 인용)만 셈
  const markdown = (String(body).match(/^\s*(#\s|#{4,6}\s|[-*]\s|>\s)/gm) || []).length;
  const gaps = (String(body).match(/\[✍️ 보충 필요/g) || []).length;

  const notes = [];
  if (text.length < BASELINE.minChars) notes.push(`본문 ${text.length.toLocaleString()}자: 평소 글(평균 ${BASELINE.avgChars.toLocaleString()}자, 최소 ${BASELINE.minChars.toLocaleString()}자)보다 짧습니다.`);
  else if (text.length < BASELINE.p10) notes.push(`본문 ${text.length.toLocaleString()}자: 평소 글 대부분(${BASELINE.p10.toLocaleString()}자 이상)보다 짧은 편입니다.`);
  if (text.length > BASELINE.maxChars) notes.push(`본문 ${text.length.toLocaleString()}자: 평소 가장 긴 글(${BASELINE.maxChars.toLocaleString()}자)보다 깁니다.`);
  if (avgLine > 45) notes.push(`평균 줄 길이 ${avgLine}자: 평소(${BASELINE.avgLine}자)보다 깁니다. 의미 단위로 줄을 바꿔 보세요.`);
  if (longLines) notes.push(`60자가 넘는 줄 ${longLines}개`);
  const pct = (k) => Math.round(ends[k] / n * 100);
  // 비율 경고는 문장이 충분할 때만 (짧은 글은 1~2문장으로 비율이 크게 튐)
  const enough = sentences.length >= 12;
  if (isOwner()) {
    if (ends.plainDa >= 3 && (pct('plainDa') > 10 || !enough)) notes.push(`반말 평서형(~한다/~이다) 문장 ${ends.plainDa}개 (${pct('plainDa')}%): 평소 글은 ${BASELINE.plainDa}%뿐이고 "~습니다"가 기본입니다.`);
    if (enough && pct('yo') > 30) notes.push(`"~요"로 끝나는 문장 ${pct('yo')}%: 평소(${BASELINE.yo}%, 주로 "~는데요"와 질문)보다 많습니다.`);
  } else {
    // 다른 블로거: 그 사람 평소 비율보다 20%p 넘게 많은 어미만 알려 줌 (짧은 글은 평소 15% 미만인 어미가 3문장 이상일 때만)
    const LABEL = { nida: '합쇼체(~습니다)', yo: '해요체(~요)', plainDa: '반말 평서형(~한다/~이다)' };
    const base = { nida: BASELINE.nida, yo: BASELINE.yo, plainDa: BASELINE.plainDa };
    const top = Object.keys(base).sort((a, b) => base[b] - base[a])[0];
    for (const k of Object.keys(base)) {
      const over = enough ? pct(k) > base[k] + 20 : (ends[k] >= 3 && base[k] < 15);
      if (ends[k] && over) notes.push(`${LABEL[k]} 문장 ${ends[k]}개 (${pct(k)}%): 평소 글은 ${base[k]}%이고, 가장 많이 쓰는 어미는 ${LABEL[top]}(${base[top]}%)입니다.`);
    }
  }
  if (emoji > Math.max(0, Math.round(BASELINE.emojiPerPost))) notes.push(`이모지 ${emoji}개: 평소 글은 글당 ${BASELINE.emojiPerPost}개 수준입니다.`);
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

function buildPrompt(req, samples, stats, profile = DEFAULT_PROFILE) {
  const BASELINE = toBaseline(profile);
  const sampleText = samples.map((s, i) => `<<필자 글 ${i + 1}: ${s.title}>>\n${(s.content_final || '').slice(0, 900)}`).join('\n\n');
  return `당신은 블로거 "${blogName()}"(${blogId()})의 첨삭 편집자입니다.
필자가 쓴 [본문]을 읽고 문제가 있는 곳에 코멘트를 답니다. 글을 새로 쓰지 말고, 지적과 문단 단위 수정안만 제시하세요.

# 볼 것 (이 3가지만)
1. logic / structure (논리·구조)
   - 비약, 과한 일반화("무조건", "절대"), 근거와 결론이 맞지 않는 곳
   - [원래 초안]에 없던 주장이나 의견이 본문에 들어가 있으면 반드시 지적 (필자가 직접 쓴 것인지 확인 요청)
   - 3단 서사: intro(개인 맥락) → body(근거·경험) → insight(필자의 관점·판단). 빠지거나 약한 단계
   - 문단 순서가 어색하거나 같은 말을 반복하는 곳
2. style (필자 문체 일관성)
${isOwner() ? `   - 필자는 합쇼체 "~습니다/~ㅂ니다"가 기본. "~는데요/~인데요"(도입·전환)와 독자 질문 "~신가요?/~을까요?"는 필자 말투가 맞음
   - 평서 반말 "~한다./~이다./~있다."는 거의 쓰지 않음(3%) → 이런 문장은 style로 지적. 이모지도 쓰지 않음` : `   - 아래 "자동 측정 결과"의 필자 평균 어미 비율과 [필자 글]의 말투가 기준입니다. 필자가 평소 잘 쓰지 않는 어미·말투로 쓴 문장을 style로 지적
   - 이모지·느낌표 같은 표현도 [필자 글]에 비해 지나치게 많거나 적으면 지적`}
   - 본문의 ==문장==(노란 형광펜), **문장**(굵게), "## "(소제목), "---"(구분선), "관련글 : [제목](주소)"는 네이버 서식 표시이니 기호 자체를 지적하지 마세요.
     형광펜이 한 문단에 너무 많거나 핵심이 아닌 곳에 칠해졌으면 readability로 지적해도 됩니다.
${isOwner() ? '   - 도입은 "저는 ~했는데요."처럼 개인 맥락, 마무리는 "여러분"에게 건네는 말' : '   - 도입과 마무리 방식이 [필자 글]과 크게 다르면 지적'}
   - 아래 [필자 글]과 말투가 크게 다른 문단
3. readability (가독성)
   - 너무 긴 문장, 모호한 지시어("이것", "그런"), 중복 표현, 한 문단에 주제가 여러 개

# 규칙
- target에는 [본문]의 문장이나 문단을 **글자 그대로** 복사하세요(==, ** 같은 서식 표시 포함). 한 글자라도 바꾸면 코멘트가 버려집니다.
- suggestion에서도 원래 문장에 있던 서식 표시는 유지하세요.
- suggestion은 target을 대체할 문단 단위 수정안입니다. target 길이의 2배를 넘기지 말고, [본문]과 [원래 초안]에 없는 사실·수치·경험을 새로 넣지 마세요. 지적만 하고 고칠 필요가 없으면 suggestion을 빈 문자열로 두세요.
- 해시태그 줄, URL, "이전글 :"/"관련글 :" 줄, "[✍️ 보충 필요: ...]" 표시, "[🖼️ 짤/사진/도표: ...]" 이미지 자리 표시는 첨삭하지 마세요.
- 코멘트는 중요한 것부터 최대 ${MAX_COMMENTS}개. 문제가 없으면 적게 다세요. 칭찬용 코멘트는 달지 마세요.
- structure의 각 comment는 한 문장으로.

${req.previous.length ? `# 지난 첨삭에서 필자가 이미 처리한 지적 (다시 달지 마세요)
같은 문장에 같은 취지의 지적을 반복하지 말고, 아직 다루지 않은 문제만 새로 찾으세요.
${req.previous.map(p => `- [${p.decision === 'accepted' ? '수락해 고침' : '필자가 넘김'}] "${p.target.slice(0, 120)}" — ${p.comment.slice(0, 120)}`).join('\n')}

` : ''}# 자동 측정 결과 (참고)
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

export async function handleReview(body, env, ctx) {
  const req = {
    title: String(body.title || '').trim(),
    body: String(body.body || ''),
    memo: String(body.memo || '').trim(),
    // 지난 첨삭에서 수락·무시한 지적 (재첨삭 때 반복 방지)
    previous: (Array.isArray(body.previous) ? body.previous : []).slice(0, 20).map(p => ({
      target: String(p?.target || '').slice(0, 600),
      comment: String(p?.comment || '').slice(0, 300),
      decision: p?.decision === 'accepted' ? 'accepted' : 'dismissed',
      suggestion: String(p?.suggestion || '').slice(0, 1200)
    })).filter(p => p.target)
  };
  if (req.body.trim().length < 50) {
    return { status: 400, json: { error: '첨삭할 본문이 너무 짧습니다 (50자 이상).' } };
  }
  if (req.body.length > 12000) {
    return { status: 400, json: { error: '본문이 너무 깁니다 (12,000자 이하).' } };
  }

  const profile = await getStyleProfile(env, ctx);
  const stats = computeStyleStats(req.body, profile);
  let samples = [];
  try {
    samples = (await searchPastInsights([req.title, req.body.slice(0, 1500)].join('\n'), 2, env));
  } catch (e) {}

  const out = await generateJson(buildPrompt(req, samples, stats, profile), SCHEMA, env, { temperature: 0.3 });

  const structure = {};
  for (const k of ['intro', 'body', 'insight']) {
    const s = out.structure?.[k] || {};
    structure[k] = {
      status: ['ok', 'weak', 'missing'].includes(s.status) ? s.status : 'weak',
      comment: String(s.comment || '').trim()
    };
  }

  // 필자가 넘긴 문장, 이미 수락해 고친 문장에 또 달린 지적은 뺌
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const seen = new Set(req.previous.flatMap(p => [p.decision === 'dismissed' ? norm(p.target) : '', p.decision === 'accepted' ? norm(p.suggestion) : '']).filter(Boolean));
  const all = validateComments(req.body, out.comments);
  const comments = all.filter(c => !seen.has(norm(c.target)));
  return {
    status: 200,
    json: {
      structure,
      comments,
      style: stats,
      baseline_source: profile.source === 'computed'
        ? `필자 글 ${profile.posts}편 자동 분석 (${profile.computed_at ? new Date(profile.computed_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '-'})`
        : '기본값 (74편 수동 분석)',
      // 위치를 못 찾았거나 개수 제한으로 버린 코멘트 수 (품질 점검용)
      dropped: Math.max(0, (Array.isArray(out.comments) ? out.comments.length : 0) - all.length),
      skipped_repeats: all.length - comments.length
    }
  };
}
