// image_chart: 본문의 "[🖼️ 도표: ...]" 자리에 넣을 설명 그림의 내용(스펙)
// - mode 'research'(기본): 구글 검색으로 실제 자료(뉴스·기관)를 찾아 숫자·날짜를 채우고 출처를 붙인다
// - mode 'body': 본문·메모에 있는 내용만
// 그림은 웹(canvas)이 그린다. 숫자는 본문·메모·검색 결과에 실제로 있는 것만 남기고,
// 출처 기사 원문과의 최종 대조는 웹이 source_fetch로 기사를 받아 한다 (Worker CPU 절약).
import { generateJson, generateGrounded } from './lib.js';
import { stripFormatMarks } from './style.js';

const TYPES = ['cards', 'bars', 'steps', 'timeline', 'compare', 'table'];
const MAX_ITEMS = { bars: 10, cards: 4, timeline: 8, steps: 6, compare: 2, table: 6 };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: TYPES },
    title: { type: 'STRING' },
    subtitle: { type: 'STRING' },
    unit: { type: 'STRING' },
    headline: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          icon: { type: 'STRING' },
          label: { type: 'STRING' },
          value: { type: 'NUMBER', nullable: true },
          text: { type: 'STRING' },
          key: { type: 'BOOLEAN' },
          src: { type: 'INTEGER' }
        },
        required: ['label']
      }
    },
    note: { type: 'STRING' }
  },
  required: ['type', 'title', 'items']
};

const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ICON_RE = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*$/u;

// 값이 글에 적힐 수 있는 모양들 (72210 만원 → "72210", "72,210", "7억2210", "7억 2,210", "7.2억" …)
export function valueForms(v, unit = '') {
  const forms = new Set();
  if (typeof v !== 'number' || !isFinite(v)) return [];
  forms.add(String(v)); forms.add(v.toLocaleString('en-US'));
  const u = String(unit).replace(/\s/g, '');
  const base = /^만원?$/.test(u) ? 1e4 : /^억원?$/.test(u) ? 1e8 : /^조원?$/.test(u) ? 1e12 : u === '원' ? 1 : null;
  if (base !== null) {
    const won = v * base;
    if (Math.abs(won) >= 1e8) {
      const eok = Math.trunc(won / 1e8), man = Math.round(Math.abs(won % 1e8) / 1e4);
      if (man) for (const m of [String(man), man.toLocaleString('en-US')]) for (const sp of ['', ' ']) forms.add(`${eok}억${sp}${m}`);
      else forms.add(`${eok}억`);
      const e = won / 1e8;
      forms.add(`${Math.round(e * 10) / 10}억`); forms.add(`${Math.round(e * 100) / 100}억`);
    } else if (Math.abs(won) >= 1e4) {
      const man = won / 1e4;
      forms.add(`${man}만`); forms.add(`${man.toLocaleString('en-US')}만`);
    }
  }
  return [...forms];
}
// 이름·설명 속 숫자 하나가 글에 적힐 수 있는 모양 (2021.7 → "2021년 7월", "2021.07" …)
export function tokenForms(tok) {
  const t = tok.replace(/[.,]$/, '');
  const forms = new Set([t, t.replace(/,/g, '')]);
  const d = t.match(/^(\d{4})\.(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (d) {
    const [, y, m, dd] = d, m2 = m.padStart(2, '0');
    forms.add(`${y}년 ${+m}월`); forms.add(`${y}.${m2}`); forms.add(`${y}-${m2}`); forms.add(`${y}. ${+m}`);
    if (dd) { const d2 = dd.padStart(2, '0'); forms.add(`${y}년 ${+m}월 ${+dd}일`); forms.add(`${y}.${m2}.${d2}`); forms.add(`${y}-${m2}-${d2}`); forms.add(`${+m}월 ${+dd}일`); }
  }
  return [...forms];
}
const numTokens = (s) => String(s || '').match(/\d[\d,.]*/g) || [];
const found = (forms, src) => forms.some(f => f && src.includes(f));

// 항목 하나의 숫자 확인: 'ok'(본문·메모에 있음) / 'search'(검색 결과에만 있음, 웹이 기사 원문과 다시 대조) / 지어낸 숫자는 지움
function checkItem(it, unit, own, searched) {
  let where = 'ok';
  const see = (forms) => found(forms, own) ? 'ok' : found(forms, searched) ? 'search' : null;
  if (it.value !== null) {
    const w = see(valueForms(it.value, unit));
    if (!w) it.value = null; else if (w === 'search') where = 'search';
  }
  for (const field of ['label', 'text']) {
    for (const tok of numTokens(it[field])) {
      const w = see(tokenForms(tok));
      if (!w) { if (field === 'label') return null; it.text = ''; break; }
      if (w === 'search') where = 'search';
    }
  }
  it.check = where;
  return it;
}

export function sanitizeChart(out, own, searched = '', sourceNumbers = []) {
  const sourceNs = new Set(sourceNumbers);
  let type = TYPES.includes(out && out.type) ? out.type : 'table';
  const unit = cut(out && out.unit, 6);
  const textMax = type === 'compare' ? 90 : 40;
  let items = (Array.isArray(out && out.items) ? out.items : [])
    .map(it => {
      const icon = cut(it && it.icon, 8);
      const src = Number.isInteger(it && it.src) && sourceNs.has(it.src) ? it.src : 0;
      return {
        icon: ICON_RE.test(icon) ? icon : '',
        label: cut(it && it.label, type === 'timeline' || type === 'bars' ? 24 : 14),
        value: it && typeof it.value === 'number' && isFinite(it.value) ? it.value : null,
        text: cut(it && it.text, textMax),
        key: !!(it && it.key),
        src
      };
    })
    .filter(it => it.label)
    .map(it => checkItem(it, unit, own, searched))
    .filter(Boolean);
  // 막대인데 숫자가 2개 미만이면 카드·표로
  if (type === 'bars') {
    const withVal = items.filter(it => it.value !== null);
    if (withVal.length >= 2) items = withVal; else type = items.length <= 4 ? 'cards' : 'table';
  }
  if (type === 'compare' && items.length !== 2) type = 'table';
  if (type === 'timeline' && items.filter(it => /\d{4}/.test(it.label)).length < 2) type = 'steps';
  items = items.slice(0, MAX_ITEMS[type] || 6);
  const headline = cut(out && out.headline, 50);
  const headOk = numTokens(headline).every(t => found(tokenForms(t), own) || found(tokenForms(t), searched));
  return {
    type,
    title: cut(out && out.title, 30) || '정리',
    subtitle: cut(out && out.subtitle, 50),
    unit,
    headline: headline && headOk ? headline : '',
    items,
    note: cut(out && out.note, 80)
  };
}

function researchPrompt(slot, title, text) {
  return `블로그 글에 넣을 정보 그래픽 한 장을 만들려고 합니다. 그래픽에 들어갈 실제 자료를 웹에서 찾아 주세요.

# 그래픽 주제
${slot}

# 글 제목과 앞부분 (맥락)
${title || '(제목 없음)'}
${text.slice(0, 1200)}

# 찾을 것
- 언론 기사, 정부·지자체·공공기관 발표에서 확인되는 숫자·날짜·순위·금액
- 비교·순위 자료면 항목을 빠짐없이 (예: 상위 10개 단지와 금액), 일정이면 날짜를 정확히
- 최근 자료 우선, 기준 시점과 출처(언론사·기관, 날짜)를 함께
- 찾은 사실만 한 줄에 하나씩 쓰고, 찾지 못한 것은 추측하지 마세요.`;
}

function chartPrompt(slot, title, text, memo, research) {
  const src = research && research.sources.length
    ? `# [검색 자료] (문장 끝 [번호]는 출처 번호)
${research.text}

# [출처 목록]
${research.sources.map(s => `[${s.n}] ${s.title}`).join('\n')}
`
    : '';
  return `블로그 글 중간에 넣을 정보 그래픽(신문 그래픽처럼) 한 장의 내용을 정리합니다. 그림은 프로그램이 그리니 내용만 JSON으로 주세요.
독자가 그림만 보고도 핵심을 알 수 있게, 짧은 단어와 정확한 숫자·날짜 위주로 정리하세요.

# 절대 규칙
- 숫자·날짜·이름은 [본문], [메모]${src ? ', [검색 자료]' : ''}에 실제로 있는 것만 씁니다. 없는 숫자를 만들거나 추정하지 마세요.
- 숫자는 적힌 그대로의 값과 단위로 (예: "7억2210만원"이면 value 72210, unit "만원" / "10%"면 value 10, unit "%").
${src ? '- [검색 자료]에서 가져온 항목은 src에 출처 번호를 넣으세요. [본문]·[메모]에서 가져왔으면 src는 0.\n- 본문보다 [검색 자료]에 더 구체적인 숫자·날짜가 있으면 그것을 쓰세요. 그래픽의 목적은 본문에 없는 정확한 자료를 보여 주는 것입니다.\n' : ''}
# 형식 고르기 (자료에 가장 잘 맞는 것 하나)
- bars: 같은 단위 숫자의 순위·비교 (예: 단지별 부담금 상위 10개). 큰 순서로, 최대 10개
- timeline: 날짜가 있는 사건·일정 2~8개. label에 날짜를 꼭 넣기 (예: "2021.7 준공", "해석 A: 2026.12.30"). 가장 중요한 1~2개는 key: true
- cards: 핵심 숫자 2~4개를 크게. 단위가 같으면 value와 unit, 다르면 value는 비우고 label에 "5년", "2억"처럼
- steps: 날짜 없는 절차·순서
- compare: 둘을 견줄 때 (전/후, A안/B안). items 정확히 2개, text에 특징 2~4개를 " / "로 구분
- table: 그 밖의 항목 정리

# 문구
- title: 그림이 말하는 결론을 18자 이내로 (예: "부과기한, 두 가지 해석"). 주제 이름만 쓰지 말 것
- subtitle: 무엇에 대한 자료인지 한 줄 30자 이내 (예: "서초구 반포현대 사례 · 국토부 11월 법률해석 예정")
- 항목 label 14자 이내 (bars·timeline은 24자), text 30자 이내 (compare는 80자). icon은 bars·timeline에서는 비워도 됨
- headline: 그림 아래 한 줄 정리 40자 이내. 자료가 보여 주는 사실만 (없는 판단·숫자 금지). 없으면 빈 문자열
- note: 비워 두세요 (출처 줄은 프로그램이 만듭니다)

# 이 그림에 담을 것
${slot}

# [제목]
${title || '(없음)'}

# [본문]
${text}

# [메모]
${memo || '(없음)'}

${src}`;
}

export async function handleImageChart(body, env) {
  const slot = cut(body.slot, 80);
  const title = cut(body.title, 100);
  const text = stripFormatMarks(String(body.body || '')).slice(0, 6000);
  const memo = String(body.memo || '').slice(0, 3000);
  const mode = body.mode === 'body' ? 'body' : 'research';
  if (!slot) return { status: 400, json: { error: '도표 설명이 비어 있습니다.' } };

  let research = null;
  if (mode === 'research') {
    try {
      const r = await generateGrounded(researchPrompt(slot, title, text), env, { timeoutMs: 75000 });
      // 영상·SNS는 숫자 대조가 안 되므로 출처에서 뺌 (번호는 검색 자료의 [번호]와 맞추려고 그대로 둠)
      const sources = r.chunks.slice(0, 10).map((c, i) => ({ n: i + 1, title: cut(c.title, 60), url: c.url }))
        .filter(s => s.url && !/youtube|youtu\.be|tiktok|instagram|facebook|blog\.naver|tistory/i.test(s.title));
      research = { text: r.text.slice(0, 7000), sources, queries: r.queries.slice(0, 5) };
    } catch (e) {
      research = { text: '', sources: [], queries: [], error: e.message };
    }
  }

  const out = await generateJson(chartPrompt(slot, title, text, memo, research), SCHEMA, env, { temperature: 0.2 });
  const own = `${title}\n${text}\n${memo}`;
  const chart = sanitizeChart(out, own, research ? research.text : '', research ? research.sources.map(s => s.n) : []);
  // 출처 줄: 실제로 쓴 출처만 (웹이 기사 원문을 받은 뒤 언론사 이름·날짜로 다시 씀)
  const used = research ? [...new Set(chart.items.map(it => it.src).filter(Boolean))] : [];
  if (used.length) chart.note = `자료: ${used.map(n => research.sources.find(s => s.n === n)?.title).filter(Boolean).join(' · ')}`;
  return {
    status: 200,
    json: {
      chart,
      research: research && { sources: research.sources, queries: research.queries, error: research.error || '', used }
    }
  };
}

// 출처 기사 받아 오기: 구글 검색 근거 링크(grounding-api-redirect)만 따라가서 원문 HTML을 그대로 넘김
// (아무 주소나 대신 받아 주는 통로가 되지 않도록 그 링크만 허용, CPU를 쓰지 않게 본문은 손대지 않음)
const GROUNDING = /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9_\-=%]+$/;
export async function handleSourceFetch(body) {
  const url = String(body.url || '');
  if (!GROUNDING.test(url)) return { status: 400, json: { error: '검색 출처 링크만 받을 수 있습니다.' } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'ko-KR,ko;q=0.9' } });
    const type = res.headers.get('Content-Type') || '';
    if (!res.ok || !/text\/html|application\/xhtml/.test(type)) return { status: 502, json: { error: `기사를 받지 못했습니다 (HTTP ${res.status})`, final_url: res.url } };
    return { status: 200, binary: res.body, contentType: type, headers: { 'X-Final-Url': res.url } };
  } catch (e) {
    return { status: 502, json: { error: e.name === 'AbortError' ? '기사 응답이 8초 안에 오지 않았습니다' : e.message } };
  } finally {
    clearTimeout(timer);
  }
}
