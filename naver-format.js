// 본문 표시 → 네이버 블로그(스마트에디터 ONE) 붙여넣기용 HTML
// 스튜디오(index.html)와 붙여넣기 테스트(paste-test.html)가 함께 쓴다.
//
// 본문 표시 (한 줄 = 네이버 문단 하나, 빈 줄 = 빈 문단)
//   ==문장==            노란 형광펜 (#fff8b2, 필자가 쓰는 색)
//   **문장**            굵게
//   ## 소제목           굵은 큰 글씨 (24)
//   ---                 가운데 구분선
//   이전글 : [제목](주소)  가운데 정렬 연결 글 줄 (관련글도 같음)
//   [제목](주소)        본문 속 링크
(function (global) {
  const HIGHLIGHT = '#fff8b2';

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const safeUrl = (url) => {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (e) { return null; }
  };

  const LINK_LINE = /^(이전글|관련글|다음글)\s*:\s*\[([^\]]+)\]\((\S+?)\)\s*$/;
  // 이미지 자리: [🖼️ 짤: 설명 | 검색: 검색어] / [🖼️ 사진: 설명] / [🖼️ 도표: 설명]
  const IMG_LINE = /^\[\u{1F5BC}️?\s*(짤|사진|도표|이미지)\s*:\s*([^|\]]*?)\s*(?:\|\s*검색\s*:\s*([^\]]*?)\s*)?\]$/u;
  const IMG_KIND = { '짤': 'reaction', '사진': 'personal', '도표': 'explain', '이미지': 'reaction' };

  // 본문의 이미지 자리 목록 [{kind, label, desc, search, line}]
  function imageSlots(text) {
    return String(text || '').split('\n').map((l, i) => {
      const m = l.trim().match(IMG_LINE);
      return m ? { kind: IMG_KIND[m[1]], label: m[1], desc: m[2].trim(), search: (m[3] || '').trim(), line: i } : null;
    }).filter(Boolean);
  }
  const URL_ONLY = /^https?:\/\/\S+$/;

  // 예전 초안 형식("이전글 :\n제목\nhttps://...")을 한 줄 표시로 정리
  function normalizeLegacy(text) {
    return String(text || '').replace(
      /^(이전글|관련글)\s*:\s*\n([^\n]+)\n(https?:\/\/\S+)\s*$/gm,
      (m, label, title, url) => `${label} : [${title.trim()}](${url})`);
  }

  // 줄 → 블록 [{type: 'p'|'empty'|'h'|'hr'|'link', ...}]
  function parse(text) {
    return normalizeLegacy(text).replace(/\r\n?/g, '\n').split('\n').map((raw) => {
      const line = raw.replace(/\s+$/, '');
      const t = line.trim();
      if (!t) return { type: 'empty' };
      if (/^(-{3,}|—{2,}|_{3,})$/.test(t)) return { type: 'hr' };
      const h = t.match(/^#{2,3}\s+(.+)$/);
      if (h) return { type: 'h', text: h[1] };
      const im = t.match(IMG_LINE);
      if (im) return { type: 'img', label: im[1], desc: im[2].trim(), search: (im[3] || '').trim(), raw: t };
      const l = t.match(LINK_LINE);
      if (l && safeUrl(l[3])) return { type: 'link', label: l[1], title: l[2], url: safeUrl(l[3]) };
      return { type: 'p', text: line };
    });
  }

  // 문장 안: 이스케이프 → 링크 → 굵게 → 형광펜
  function inline(text, opts = {}) {
    let s = esc(text);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
      const href = safeUrl(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${esc(href)}" target="_blank">${label}</a>` : label;
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/==([^=\n]+?)==/g, (m, inner) => opts.markClass
      ? `<span class="${opts.markClass}">${inner}</span>`
      : `<span style="background-color:${HIGHLIGHT};">${inner}</span>`);
    // 단독 주소 줄은 링크로
    if (URL_ONLY.test(text.trim()) && safeUrl(text.trim())) {
      s = `<a href="${esc(safeUrl(text.trim()))}" target="_blank">${esc(text.trim())}</a>`;
    }
    return s;
  }

  // 표시 기호를 지운 순수 텍스트 (글자 수, 첨삭, 일반 텍스트 붙여넣기용)
  function toPlain(text) {
    return parse(text).map((b) => {
      if (b.type === 'empty') return '';
      if (b.type === 'hr') return '';
      if (b.type === 'h') return stripInline(b.text);
      if (b.type === 'link') return `${b.label} : ${b.title}\n${b.url}`;
      if (b.type === 'img') return b.raw;
      return stripInline(b.text);
    }).join('\n').replace(/\n{3,}/g, '\n\n');
  }
  function stripInline(t) {
    return String(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/==([^=\n]+?)==/g, '$1');
  }

  // 구분선 바로 옆 빈 줄은 뺀다: 에디터가 구분선 위아래에 빈 줄을 스스로 하나씩 넣어서
  // 그대로 두면 간격이 두 배가 됨 (2026-11-20 붙여넣기 테스트)
  function trimAroundHr(blocks) {
    return blocks.filter((b, i) => !(b.type === 'empty' &&
      ((blocks[i - 1] && blocks[i - 1].type === 'hr') || (blocks[i + 1] && blocks[i + 1].type === 'hr'))));
  }

  // 방식 A: 일반 HTML (인라인 스타일). 테스트에서 형광펜·굵게·소제목·구분선·가운데 링크 모두 유지됨
  function toHtmlA(text) {
    return trimAroundHr(parse(text)).map((b) => {
      switch (b.type) {
        case 'empty': return '<p><br></p>';
        case 'hr': return '<hr>';
        case 'h': return `<p><span style="font-size:24px;"><b>${inline(b.text)}</b></span></p>`;
        case 'img': return `<p style="text-align:center;"><span style="color:#999999;">${esc(b.raw)}</span></p>`;
        case 'link': return `<p style="text-align:center;"><b>${esc(b.label)} :</b> <a href="${esc(b.url)}" target="_blank">${esc(b.title)}</a></p>`;
        default: return `<p>${inline(b.text)}</p>`;
      }
    }).join('');
  }

  // 방식 B: 네이버 발행 글과 같은 구조(se-component). 에디터가 자기 형식으로 알아보는지 확인용
  function toHtmlB(text) {
    const para = (inner, align = '') =>
      `<p class="se-text-paragraph se-text-paragraph-align-${align}" style="line-height:1.9;">${inner}</p>`;
    const span = (inner, fs = 'fs16', style = '') =>
      `<span style="${style}" class="se-fs-${fs} se-ff-">${inner}</span>`;
    const textComp = (paras) =>
      `<div class="se-component se-text se-l-default"><div class="se-component-content"><div class="se-section se-section-text se-l-default"><div class="se-module se-module-text">${paras}</div></div></div></div>`;
    const hrComp = '<div class="se-component se-horizontalLine se-l-default"><div class="se-component-content"><div class="se-section se-section-horizontalLine se-l-default se-section-align-center"><div class="se-module se-module-horizontalLine"><hr class="se-hr"></div></div></div></div>';

    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(textComp(buf.join(''))); buf = []; } };
    for (const b of parse(text)) {
      if (b.type === 'hr') { flush(); out.push(hrComp); continue; }
      if (b.type === 'empty') buf.push(para(span('​')));
      else if (b.type === 'img') buf.push(para(span(esc(b.raw)), 'center'));
      else if (b.type === 'h') buf.push(para(span(`<b>${inline(b.text)}</b>`, 'fs24')));
      else if (b.type === 'link') buf.push(para(
        span(`<b>${esc(b.label)} :</b>`) + span(' ') +
        span(`<a href="${esc(b.url)}" class="se-link" target="_blank">${esc(b.title)}</a>`), 'center'));
      else buf.push(para(inline(b.text).replace(/<span style="background-color:#fff8b2;">/g, `<span style="background-color:${HIGHLIGHT};" class="se-fs-fs16 se-ff-">`)));
    }
    flush();
    return `<div class="se-main-container">${out.join('')}</div>`;
  }

  // 화면 미리보기 (스튜디오 CSS 클래스 사용)
  function toPreview(text) {
    return parse(text).map((b) => {
      switch (b.type) {
        case 'empty': return '<p class="nv-empty">&nbsp;</p>';
        case 'hr': return '<hr class="nv-hr">';
        case 'h': return `<p class="nv-h">${inline(b.text, { markClass: 'nv-mark' })}</p>`;
        case 'img': return `<div class="nv-img"><span class="k">${esc(b.label)}</span> ${esc(b.desc)}${b.search ? ` <span class="s">검색어: ${esc(b.search)}</span>` : ''}</div>`;
        case 'link': return `<p class="nv-link"><b>${esc(b.label)} :</b> <a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title)}</a></p>`;
        default: {
          const gap = /^\[(✍️ 보충 필요|🖼️? ?이미지)/.test(b.text.trim());
          return `<p${gap ? ' class="nv-gap"' : ''}>${inline(b.text, { markClass: 'nv-mark' }).replace(/<a /g, '<a rel="noopener noreferrer" ')}</p>`;
        }
      }
    }).join('');
  }

  // 클립보드에 HTML + 텍스트를 함께. copy 이벤트 방식이 가공 없이 그대로 들어가서 우선 사용
  async function copyRich(html, plain) {
    let ok = false;
    const onCopy = (e) => {
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/plain', plain);
      e.preventDefault();
      ok = true;
    };
    document.addEventListener('copy', onCopy);
    try { document.execCommand('copy'); } catch (e) { /* 아래로 */ }
    document.removeEventListener('copy', onCopy);
    if (ok) return true;
    if (navigator.clipboard && global.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' })
      })]);
      return true;
    }
    throw new Error('clipboard unavailable');
  }

  global.NaverFormat = { HIGHLIGHT, imageSlots, parse, inline, toPlain, stripInline, toHtmlA, toHtmlB, toPreview, copyRich, normalizeLegacy };
})(window);
