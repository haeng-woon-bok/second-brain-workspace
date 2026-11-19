// 설명 그림(도표 카드) — 종이 톤으로 canvas에 그려 PNG로 복사/저장
// spec: { type: 'bars'|'steps'|'table', title, unit, items: [{label, value, text}], note }
(function (global) {
  const C = {
    bg: '#fbf9f4', ink: '#2b2824', sub: '#6b645a', faint: '#9a9184', line: '#e2dacb',
    track: '#efe9dd', bar: '#7a5c3a', barTop: '#a0784a', mark: '#fff8b2'
  };
  const SANS = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const SERIF = '"Noto Serif KR", "Nanum Myeongjo", serif';
  const W = 960, PAD = 56;

  function wrap(ctx, text, maxW) {
    const words = String(text || '').split(/(\s+)/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur + w;
      if (ctx.measureText(next).width <= maxW || !cur.trim()) { cur = next; continue; }
      lines.push(cur.trim()); cur = w.trimStart();
      // 띄어쓰기 없이 긴 단어는 글자 단위로 자름
      while (ctx.measureText(cur).width > maxW) {
        let i = cur.length;
        while (i > 1 && ctx.measureText(cur.slice(0, i)).width > maxW) i--;
        lines.push(cur.slice(0, i)); cur = cur.slice(i);
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.length ? lines : [''];
  }

  const fmtNum = (v) => (Math.round(v * 100) / 100).toLocaleString('ko-KR');

  // 그리기 명령을 모아 높이를 먼저 계산한 뒤 한 번에 그림
  function layout(ctx, spec) {
    const ops = [];
    let y = PAD;
    const innerW = W - PAD * 2;

    // 제목 + 형광펜 밑줄
    ctx.font = `700 34px ${SERIF}`;
    const titleLines = wrap(ctx, spec.title || '정리', innerW);
    titleLines.forEach((t, i) => {
      const tw = Math.min(ctx.measureText(t).width, innerW);
      const ty = y + 38 + i * 48;
      ops.push(c => { c.fillStyle = C.mark; c.fillRect(PAD - 4, ty - 14, tw + 8, 18); });
      ops.push(c => { c.font = `700 34px ${SERIF}`; c.fillStyle = C.ink; c.fillText(t, PAD, ty); });
    });
    y += 38 + (titleLines.length - 1) * 48 + 36;

    const items = (spec.items || []).slice(0, 6);
    if (spec.type === 'bars') {
      const max = Math.max(...items.map(it => Math.abs(Number(it.value) || 0)), 1);
      const labelW = 190, valueW = 130, barW = innerW - labelW - valueW;
      items.forEach((it) => {
        ctx.font = `600 22px ${SANS}`;
        const ll = wrap(ctx, it.label, labelW - 16).slice(0, 2);
        const rowH = Math.max(56, ll.length * 28 + 20);
        const cy = y + rowH / 2;
        const v = Number(it.value) || 0;
        const bw = Math.max(4, barW * Math.abs(v) / max);
        const isMax = Math.abs(v) === max;
        ops.push(c => {
          c.font = `600 22px ${SANS}`; c.fillStyle = C.ink;
          ll.forEach((t, i) => c.fillText(t, PAD, cy + 8 - (ll.length - 1) * 14 + i * 28));
          c.fillStyle = C.track; c.fillRect(PAD + labelW, cy - 14, barW, 28);
          c.fillStyle = isMax ? C.bar : C.barTop; c.fillRect(PAD + labelW, cy - 14, bw, 28);
          c.font = `700 22px ${SANS}`; c.fillStyle = C.ink;
          c.fillText(`${fmtNum(v)}${spec.unit || ''}`, PAD + labelW + Math.min(bw, barW) + 12 > PAD + labelW + barW ? PAD + labelW + barW + 12 : PAD + labelW + Math.min(bw, barW) + 12, cy + 8);
        });
        if (it.text) {
          ctx.font = `400 17px ${SANS}`;
          const tl = wrap(ctx, it.text, barW)[0];
          ops.push(c => { c.font = `400 17px ${SANS}`; c.fillStyle = C.sub; c.fillText(tl, PAD + labelW, cy + 38); });
          y += 22;
        }
        y += rowH + 8;
      });
    } else if (spec.type === 'steps') {
      items.forEach((it, i) => {
        ctx.font = `400 19px ${SANS}`;
        const tl = it.text ? wrap(ctx, it.text, innerW - 80).slice(0, 2) : [];
        const rowH = 44 + tl.length * 28 + 18;
        const top = y;
        const last = i === items.length - 1;
        ops.push(c => {
          if (!last) { c.strokeStyle = C.line; c.lineWidth = 2; c.beginPath(); c.moveTo(PAD + 20, top + 42); c.lineTo(PAD + 20, top + rowH + 2); c.stroke(); }
          c.fillStyle = C.bar; c.beginPath(); c.arc(PAD + 20, top + 20, 20, 0, Math.PI * 2); c.fill();
          c.fillStyle = C.bg; c.font = `700 19px ${SANS}`; c.textAlign = 'center'; c.fillText(String(i + 1), PAD + 20, top + 27); c.textAlign = 'left';
          c.fillStyle = C.ink; c.font = `700 24px ${SANS}`; c.fillText(it.label, PAD + 60, top + 29);
          c.fillStyle = C.sub; c.font = `400 19px ${SANS}`;
          tl.forEach((t, j) => c.fillText(t, PAD + 60, top + 62 + j * 28));
        });
        y += rowH;
      });
    } else {
      const labelW = 200;
      items.forEach((it, i) => {
        ctx.font = `400 20px ${SANS}`;
        const tl = wrap(ctx, it.text || '', innerW - labelW - 16).slice(0, 3);
        ctx.font = `700 21px ${SANS}`;
        const ll = wrap(ctx, it.label, labelW - 16).slice(0, 2);
        const rowH = Math.max(tl.length, ll.length) * 30 + 30;
        const top = y;
        ops.push(c => {
          if (i === 0) { c.fillStyle = C.ink; c.fillRect(PAD, top, innerW, 2); }
          c.fillStyle = C.ink; c.font = `700 21px ${SANS}`;
          ll.forEach((t, j) => c.fillText(t, PAD + 4, top + 36 + j * 30));
          c.fillStyle = C.ink; c.font = `400 20px ${SANS}`;
          tl.forEach((t, j) => c.fillText(t, PAD + labelW, top + 36 + j * 30));
          c.fillStyle = C.line; c.fillRect(PAD, top + rowH, innerW, 1);
        });
        y += rowH;
      });
    }

    if (spec.note) {
      y += 24;
      ctx.font = `400 16px ${SANS}`;
      const nl = wrap(ctx, spec.note, innerW).slice(0, 2);
      const ny = y;
      ops.push(c => { c.font = `400 16px ${SANS}`; c.fillStyle = C.faint; nl.forEach((t, j) => c.fillText(t, PAD, ny + 16 + j * 24)); });
      y += nl.length * 24;
    }
    return { ops, height: Math.ceil(y + PAD) };
  }

  async function draw(canvas, spec, scale = 2) {
    try { await Promise.all([document.fonts.load(`700 34px ${SERIF}`), document.fonts.load(`400 20px ${SANS}`), document.fonts.load(`700 20px ${SANS}`)]); } catch (e) { /* 기본 글꼴로 */ }
    const probe = canvas.getContext('2d');
    const { ops, height } = layout(probe, spec);
    canvas.width = W * scale;
    canvas.height = height * scale;
    canvas.style.aspectRatio = `${W} / ${height}`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, height);
    ops.forEach(op => { ctx.save(); op(ctx); ctx.restore(); });
  }

  const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('PNG 변환 실패')), 'image/png'));

  async function copyImage(canvas) {
    if (!navigator.clipboard || !global.ClipboardItem) throw new Error('이미지 복사를 지원하지 않는 브라우저입니다');
    // 사파리 대응: Promise를 그대로 넘김
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(canvas) })]);
  }

  async function download(canvas, name) {
    const url = URL.createObjectURL(await toBlob(canvas));
    const a = document.createElement('a');
    a.href = url; a.download = `${(name || '도표').replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // 편집창 텍스트 ↔ items ("라벨 | 값 | 설명" 한 줄에 하나)
  function itemsToText(items) {
    return (items || []).map(it => [it.label, it.value ?? '', it.text || ''].join(' | ')).join('\n');
  }
  function textToItems(text) {
    return String(text || '').split('\n').map(l => l.split('|').map(s => s.trim())).filter(p => p[0])
      .slice(0, 6).map(([label, value, ...rest]) => {
        const n = Number(String(value || '').replace(/,/g, ''));
        return { label, value: value !== '' && isFinite(n) ? n : null, text: rest.join(' | ') || (value && !isFinite(n) ? value : '') };
      });
  }

  global.ChartCard = { draw, copyImage, download, itemsToText, textToItems };
})(window);
