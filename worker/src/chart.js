// image_chart: 본문의 "[🖼️ 도표: ...]" 자리에 넣을 설명 그림의 내용(스펙)
// 그림은 웹(canvas)이 그린다. 여기서는 본문·메모에 실제로 있는 숫자와 순서만 뽑는다.
import { generateJson } from './lib.js';
import { stripFormatMarks } from './style.js';

const TYPES = ['cards', 'bars', 'steps', 'compare', 'table'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: TYPES },
    title: { type: 'STRING' },
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
          text: { type: 'STRING' }
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

// 숫자가 본문·메모에 실제로 있는지 (2.5 → "2.5", 1200 → "1200" 또는 "1,200")
function numberInSource(v, source) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  const plain = String(v);
  const comma = v.toLocaleString('en-US');
  return source.includes(plain) || source.includes(comma);
}
// 문장 속 숫자가 모두 본문·메모에 있는지 (없는 숫자를 지어낸 한 줄 정리는 버림)
function numbersAllInSource(text, source) {
  const nums = String(text).match(/\d[\d,.]*/g) || [];
  const src = source.replace(/,/g, '');
  return nums.every(n => src.includes(n.replace(/,/g, '').replace(/\.$/, '')));
}

export function sanitizeChart(out, source) {
  let type = TYPES.includes(out && out.type) ? out.type : 'table';
  const textMax = type === 'compare' ? 90 : 40;
  const items = (Array.isArray(out && out.items) ? out.items : [])
    .map(it => {
      const icon = cut(it && it.icon, 8);
      return {
        icon: ICON_RE.test(icon) ? icon : '',
        label: cut(it && it.label, 14),
        value: it && numberInSource(it.value, source) ? it.value : null,
        text: cut(it && it.text, textMax)
      };
    })
    // 이름·설명 속 숫자도 본문·메모에 있어야 함 (없으면 설명은 비우고, 이름이 그렇다면 항목을 뺌)
    .map(it => ({ ...it, text: numbersAllInSource(it.text, source) ? it.text : '' }))
    .filter(it => it.label && numbersAllInSource(it.label, source))
    .slice(0, 6);
  // 막대인데 근거 있는 숫자가 2개 미만이면 카드로
  if (type === 'bars' && items.filter(it => it.value !== null).length < 2) type = items.length <= 4 ? 'cards' : 'table';
  if (type === 'bars') items.forEach(it => { if (it.value === null) it.value = 0; });
  if (type === 'compare' && items.length !== 2) type = 'table';
  const headline = cut(out && out.headline, 50);
  return {
    type,
    title: cut(out && out.title, 30) || '정리',
    unit: cut(out && out.unit, 6),
    headline: headline && numbersAllInSource(headline, source) ? headline : '',
    items,
    note: cut(out && out.note, 60)
  };
}

export async function handleImageChart(body, env) {
  const slot = cut(body.slot, 80);
  const text = stripFormatMarks(String(body.body || '')).slice(0, 6000);
  const memo = String(body.memo || '').slice(0, 3000);
  if (!slot) return { status: 400, json: { error: '도표 설명이 비어 있습니다.' } };
  const source = `${text}\n${memo}`;

  const prompt = `블로그 글 중간에 넣을 설명 그림(인포그래픽) 한 장의 내용을 정리합니다. 그림은 프로그램이 그리니 내용만 JSON으로 주세요.
독자가 글자를 읽지 않고 한눈에 핵심을 알 수 있게, 짧은 단어와 숫자 위주로 정리하세요.

# 절대 규칙
- [본문]과 [메모]에 실제로 있는 숫자, 이름, 순서만 씁니다. 없는 숫자를 만들거나 계산·추정하지 마세요.
- 숫자를 쓸 때는 본문에 적힌 그대로의 숫자와 단위를 씁니다 (예: 본문이 "10%"면 value 10, unit "%").

# 형식 고르기 (내용에 가장 잘 맞는 것 하나)
- cards: 핵심 숫자나 키워드 2~4개를 큰 글씨로 보여 줄 때 (예: 매수가·매도가·기간). 단위가 모두 같으면 value와 unit, 항목마다 단위가 다르면 value는 비우고 label에 "5년", "2억"처럼 숫자와 단위를 함께 쓰고 text에 무엇인지 적기
- bars: 같은 단위의 숫자 3개 이상을 크기로 비교할 때. value에 숫자, unit에 단위
- steps: 순서가 있는 일정·절차 (계약 → 중도금 → 잔금). label은 단계 이름, text는 한 줄 설명
- compare: 둘을 견줄 때 (전/후, A안/B안, 매수/매도). items는 정확히 2개, text에 특징 2~4개를 " / "로 구분
- table: 위 어디에도 안 맞는 항목 정리. label과 text

# 각 항목
- icon: 항목 뜻을 나타내는 이모지 1개 (예: 🏠 집, 💰 돈, 📅 날짜, 📈 상승, 📉 하락, 🏦 은행·대출, 📝 계약, 👶 아이, ✅ 완료)
- label 10자 이내, text 30자 이내 (compare는 80자 이내). title은 그림 제목 18자 이내.
- headline: 그림 아래에 넣을 한 줄 정리 40자 이내. 본문이 말하는 결론을 그대로 요약 (본문에 없는 판단·숫자 금지)
- note는 출처나 기준이 본문에 있으면 한 줄로 (없으면 빈 문자열)

# 이 그림에 담을 것
${slot}

# [본문]
${text}

# [메모]
${memo || '(없음)'}`;

  const out = await generateJson(prompt, SCHEMA, env, { temperature: 0.3 });
  return { status: 200, json: { chart: sanitizeChart(out, source) } };
}
