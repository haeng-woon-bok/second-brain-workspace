// image_chart: 본문의 "[🖼️ 도표: ...]" 자리에 넣을 설명 그림의 내용(스펙)
// 그림은 웹(canvas)이 그린다. 여기서는 본문·메모에 실제로 있는 숫자와 순서만 뽑는다.
import { generateJson } from './lib.js';
import { stripFormatMarks } from './style.js';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: { type: 'STRING', enum: ['bars', 'steps', 'table'] },
    title: { type: 'STRING' },
    unit: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
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

// 숫자가 본문·메모에 실제로 있는지 (2.5 → "2.5", 1200 → "1200" 또는 "1,200")
function numberInSource(v, source) {
  if (typeof v !== 'number' || !isFinite(v)) return false;
  const plain = String(v);
  const comma = v.toLocaleString('en-US');
  return source.includes(plain) || source.includes(comma);
}

export function sanitizeChart(out, source) {
  let type = ['bars', 'steps', 'table'].includes(out && out.type) ? out.type : 'table';
  const items = (Array.isArray(out && out.items) ? out.items : [])
    .map(it => ({
      label: cut(it && it.label, 14),
      value: it && numberInSource(it.value, source) ? it.value : null,
      text: cut(it && it.text, 40)
    }))
    .filter(it => it.label)
    .slice(0, 6);
  // 막대인데 근거 있는 숫자가 2개 미만이면 표로
  if (type === 'bars' && items.filter(it => it.value !== null).length < 2) type = 'table';
  if (type === 'bars') items.forEach(it => { if (it.value === null) it.value = 0; });
  return {
    type,
    title: cut(out && out.title, 30) || '정리',
    unit: cut(out && out.unit, 6),
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

  const prompt = `블로그 글 중간에 넣을 설명 그림 한 장의 내용을 정리합니다. 그림은 프로그램이 그리니 내용만 JSON으로 주세요.

# 절대 규칙
- [본문]과 [메모]에 실제로 있는 숫자, 이름, 순서만 씁니다. 없는 숫자를 만들거나 계산·추정하지 마세요.
- 숫자를 쓸 때는 본문에 적힌 그대로의 숫자와 단위를 씁니다 (예: 본문이 "10%"면 value 10, unit "%").

# 형식 고르기
- bars: 항목마다 본문에 숫자가 있을 때 (비율, 금액, 기간 비교). value에 숫자, unit에 단위
- steps: 순서가 있는 일정·절차 (계약 → 중도금 → 잔금). label은 단계 이름, text는 한 줄 설명
- table: 숫자가 없거나 섞여 있을 때의 비교·정리. label과 text
- items는 2~6개. label 12자 이내, text 30자 이내. title은 그림 제목 20자 이내.
- note는 출처나 기준이 본문에 있으면 한 줄로 (없으면 빈 문자열)

# 이 그림에 담을 것
${slot}

# [본문]
${text}

# [메모]
${memo || '(없음)'}`;

  const out = await generateJson(prompt, SCHEMA, env, { temperature: 0.2 });
  return { status: 200, json: { chart: sanitizeChart(out, source) } };
}
