// 설명 그림(도표 카드) — 종이 톤 인포그래픽을 canvas에 그려 PNG로 복사/저장
// spec: { type: 'cards'|'bars'|'steps'|'compare'|'table', title, unit, headline, note,
//         items: [{ icon, label, value, text }] }
(function (global) {
  const C = {
    bg: '#fbf9f4', ink: '#2b2824', sub: '#6b645a', faint: '#9a9184', line: '#e2dacb',
    card: '#f3eee3', cardEdge: '#e6dece', accent: '#7a5c3a', accentSoft: '#b08a5e', track: '#ece5d6',
    mark: '#fff3a8', callout: '#fff8d9', calloutEdge: '#efdc8c', iconBg: '#ffffff'
  };
  const SANS = '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const SERIF = '"Noto Serif KR", "Nanum Myeongjo", serif';
  const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  const W = 960, PAD = 56;
  const TYPES = ['cards', 'bars', 'steps', 'timeline', 'compare', 'table'];

  function wrap(ctx, text, maxW) {
    const words = String(text || '').split(/(\s+)/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur + w;
      if (ctx.measureText(next).width <= maxW || !cur.trim()) { cur = next; continue; }
      lines.push(cur.trim()); cur = w.trimStart();
      while (ctx.measureText(cur).width > maxW) {
        let i = cur.length;
        while (i > 1 && ctx.measureText(cur.slice(0, i)).width > maxW) i--;
        lines.push(cur.slice(0, i)); cur = cur.slice(i);
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    // 띄어쓰기 없는 긴 줄도 글자 단위로 자름
    return (lines.length ? lines : ['']).flatMap(l => {
      if (ctx.measureText(l).width <= maxW) return [l];
      const out = []; let s = l;
      while (s) { let i = s.length; while (i > 1 && ctx.measureText(s.slice(0, i)).width > maxW) i--; out.push(s.slice(0, i)); s = s.slice(i); }
      return out;
    });
  }
  const clampLines = (lines, n) => lines.length <= n ? lines : [...lines.slice(0, n - 1), lines[n - 1].replace(/.{1}$/, '…')];
  const fmtNum = (v) => (Math.round(v * 100) / 100).toLocaleString('ko-KR');
  // 금액은 한국식으로: 72210 만원 → "7억 2,210만원"
  function fmtValue(v, unit) {
    const u = String(unit || '').replace(/\s/g, '');
    const base = /^만원?$/.test(u) ? 1e4 : /^억원?$/.test(u) ? 1e8 : /^조원?$/.test(u) ? 1e12 : u === '원' ? 1 : null;
    if (base !== null && Math.abs(v * base) >= 1e8) {
      const won = v * base, jo = Math.trunc(won / 1e12), eok = Math.trunc((won % 1e12) / 1e8), man = Math.round(Math.abs(won % 1e8) / 1e4);
      return [jo ? `${jo}조` : '', eok ? `${Math.abs(eok).toLocaleString('ko-KR')}억` : '', man ? `${man.toLocaleString('ko-KR')}만` : ''].filter(Boolean).join(' ') + '원';
    }
    return `${fmtNum(v)}${unit || ''}`;
  }
  // "2021.7 준공", "해석 A: 2026.12.30", "2024년 3월" → { y, m, d, t(연 단위 실수) }
  function parseDate(s) {
    const m = String(s || '').match(/(\d{4})(?:\s*[.\-/년]\s*(\d{1,2}))?(?:\s*[.\-/월]\s*(\d{1,2}))?/);
    if (!m) return null;
    const y = +m[1], mo = m[2] ? Math.min(12, Math.max(1, +m[2])) : 1, d = m[3] ? Math.min(31, Math.max(1, +m[3])) : 1;
    return { y, m: mo, d, hasM: !!m[2], t: y + (mo - 1) / 12 + (d - 1) / 365 };
  }
  const MAX_ITEMS = { bars: 10, cards: 4, timeline: 8, steps: 6, compare: 2, table: 6 };

  function rr(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  }
  function card(c, x, y, w, h, fill = C.card, edge = C.cardEdge, r = 16) {
    rr(c, x, y, w, h, r); c.fillStyle = fill; c.fill();
    if (edge) { c.strokeStyle = edge; c.lineWidth = 1.5; c.stroke(); }
  }
  function iconBadge(c, cx, cy, r, icon, fallback) {
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = C.iconBg; c.fill();
    c.strokeStyle = C.cardEdge; c.lineWidth = 1.5; c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (icon) { c.font = `${Math.round(r * 1.05)}px ${EMOJI}`; c.fillText(icon, cx, cy + 1); }
    else { c.font = `700 ${Math.round(r * 0.8)}px ${SANS}`; c.fillStyle = C.accent; c.fillText(fallback || '', cx, cy + 1); }
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  }
  function text(c, s, x, y, font, color, align = 'left') {
    c.font = font; c.fillStyle = color; c.textAlign = align; c.fillText(s, x, y); c.textAlign = 'left';
  }

  function layout(ctx, spec) {
    const ops = [];
    let y = PAD;
    const innerW = W - PAD * 2;
    let type = TYPES.includes(spec.type) ? spec.type : 'table';
    if (type === 'timeline' && (spec.items || []).filter(it => parseDate(it.label)).length < 2) type = 'steps';
    const items = (spec.items || []).slice(0, MAX_ITEMS[type] || 6);
    const unit = spec.unit || '';
    const valueStr = (it) => (it.value === null || it.value === undefined || it.value === '') ? '' : fmtValue(Number(it.value), unit);

    // 제목 + 형광펜
    ctx.font = `700 36px ${SERIF}`;
    const titleLines = wrap(ctx, spec.title || '정리', innerW).slice(0, 2);
    titleLines.forEach((t, i) => {
      const tw = Math.min(ctx.measureText(t).width, innerW);
      const ty = y + 40 + i * 50;
      ops.push(c => { c.fillStyle = C.mark; c.fillRect(PAD - 6, ty - 15, tw + 12, 20); text(c, t, PAD, ty, `700 36px ${SERIF}`, C.ink); });
    });
    y += 40 + (titleLines.length - 1) * 50;
    if (spec.subtitle) {
      ctx.font = `400 19px ${SANS}`;
      const sl = clampLines(wrap(ctx, spec.subtitle, innerW), 2);
      const sy = y;
      ops.push(c => sl.forEach((t, j) => text(c, t, PAD, sy + 36 + j * 26, `400 19px ${SANS}`, C.sub)));
      y += 20 + sl.length * 26;
    }
    y += 40;

    if (type === 'cards') {
      const n = items.length || 1;
      const cols = n <= 3 ? n : (n === 4 ? 2 : 3);
      const gap = 20;
      const cw = (innerW - gap * (cols - 1)) / cols;
      const big = cols === 1 ? 64 : cols === 2 ? 54 : 44;
      // 행마다 높이를 맞춤
      for (let r = 0; r < Math.ceil(n / cols); r++) {
        const row = items.slice(r * cols, r * cols + cols);
        const metas = row.map(it => {
          const hasVal = !!valueStr(it);
          ctx.font = `700 ${hasVal ? 22 : 30}px ${SANS}`;
          const ll = clampLines(wrap(ctx, it.label, cw - 48), 2);
          ctx.font = `400 18px ${SANS}`;
          const tl = it.text ? clampLines(wrap(ctx, it.text, cw - 48), 3) : [];
          const h = 28 + 56 + 18 + (hasVal ? big + 10 : 0) + ll.length * (hasVal ? 30 : 38) + (tl.length ? 10 + tl.length * 27 : 0) + 26;
          return { it, hasVal, ll, tl, h };
        });
        const rowH = Math.max(...metas.map(m => m.h));
        const top = y;
        metas.forEach((m, i) => {
          const x = PAD + i * (cw + gap);
          ops.push(c => {
            card(c, x, top, cw, rowH);
            iconBadge(c, x + 24 + 28, top + 28 + 28, 28, m.it.icon, String(r * cols + i + 1));
            let yy = top + 28 + 56 + 18;
            if (m.hasVal) { yy += big; text(c, valueStr(m.it), x + 24, yy, `800 ${big}px ${SANS}`, C.accent); yy += 10; }
            const lf = m.hasVal ? `700 22px ${SANS}` : `700 30px ${SANS}`, lh = m.hasVal ? 30 : 38;
            m.ll.forEach(t => { yy += lh; text(c, t, x + 24, yy - 6, lf, C.ink); });
            if (m.tl.length) { yy += 10; m.tl.forEach(t => { yy += 27; text(c, t, x + 24, yy - 6, `400 18px ${SANS}`, C.sub); }); }
          });
        });
        y += rowH + gap;
      }
      y -= gap;
    } else if (type === 'bars') {
      // 순위형 가로 막대: 이름은 오른쪽 정렬, 값은 막대 끝에 (항목이 많으면 촘촘하게)
      const max = Math.max(...items.map(it => Math.abs(Number(it.value) || 0)), 1);
      const dense = items.length > 5;
      const hasIcon = items.some(it => it.icon);
      const iconW = hasIcon ? (dense ? 44 : 60) : 0;
      const lf = dense ? 19 : 22, vf = dense ? 21 : 25, barH = dense ? 26 : 32;
      ctx.font = `700 ${lf}px ${SANS}`;
      const labelW = Math.min(260, Math.max(120, ...items.map(it => ctx.measureText(it.label).width + 20)));
      ctx.font = `800 ${vf}px ${SANS}`;
      const valueW = Math.max(...items.map(it => ctx.measureText(valueStr(it) || '0').width)) + 20;
      const barW = innerW - iconW - labelW - valueW;
      items.forEach((it, i) => {
        ctx.font = `700 ${lf}px ${SANS}`;
        const ll = clampLines(wrap(ctx, it.label, labelW - 16), 2);
        ctx.font = `400 16px ${SANS}`;
        const tl = it.text && !dense ? clampLines(wrap(ctx, it.text, barW + valueW), 1) : [];
        const base = Math.max(dense ? 42 : 56, ll.length * (lf + 6) + 14);
        const rowH = base + (tl.length ? 22 : 0);
        const top = y, cy = top + base / 2;
        const v = Number(it.value) || 0;
        const bw = Math.max(10, barW * Math.abs(v) / max);
        const isMax = Math.abs(v) === max;
        ops.push(c => {
          if (hasIcon) iconBadge(c, PAD + iconW / 2 - 4, cy, dense ? 17 : 23, it.icon, String(i + 1));
          ll.forEach((t, j) => text(c, t, PAD + iconW + labelW - 16, cy + lf / 3 - (ll.length - 1) * (lf + 6) / 2 + j * (lf + 6), `700 ${lf}px ${SANS}`, C.ink, 'right'));
          const bx = PAD + iconW + labelW;
          rr(c, bx, cy - barH / 2, bw, barH, 4); c.fillStyle = isMax ? C.accent : C.accentSoft; c.fill();
          text(c, valueStr(it) || '0', bx + bw + 12, cy + vf / 3, `800 ${vf}px ${SANS}`, isMax ? C.accent : C.ink);
          if (tl.length) text(c, tl[0], bx, cy + barH / 2 + 20, `400 16px ${SANS}`, C.sub);
        });
        y += rowH + (dense ? 6 : 10);
      });
    } else if (type === 'timeline') {
      // 실제 간격의 시간 축: 핵심(key)은 위, 나머지는 아래. 핵심 두 개 사이 기간은 프로그램이 계산
      const pts = items.map(it => ({ it, d: parseDate(it.label) })).filter(p => p.d).sort((a, b) => a.d.t - b.d.t);
      const keys = pts.filter(p => p.it.key);
      pts.forEach((p, i) => { p.up = keys.length ? p.it.key : i % 2 === 0; });
      const t0 = Math.floor(pts[0].d.t), t1 = Math.max(t0 + 1, Math.floor(pts[pts.length - 1].d.t) + 1);
      const X = t => PAD + 24 + (t - t0) / (t1 - t0) * (innerW - 48);
      const BW = 230;
      // 글 상자 크기 재기
      pts.forEach(p => {
        ctx.font = `700 ${p.up ? 22 : 20}px ${SANS}`;
        p.ll = clampLines(wrap(ctx, p.it.label, BW), 2);
        ctx.font = `400 16px ${SANS}`;
        p.tl = p.it.text ? clampLines(wrap(ctx, p.it.text, BW), 2) : [];
        ctx.font = `700 ${p.up ? 22 : 20}px ${SANS}`;
        const w1 = Math.max(...p.ll.map(t => ctx.measureText(t).width));
        ctx.font = `400 16px ${SANS}`;
        const w2 = p.tl.length ? Math.max(...p.tl.map(t => ctx.measureText(t).width)) : 0;
        p.w = Math.max(w1, w2);
        p.h = p.ll.length * (p.up ? 28 : 26) + p.tl.length * 22 + 6;
        p.cx = Math.min(PAD + innerW - p.w / 2, Math.max(PAD + p.w / 2, X(p.d.t)));
      });
      // 겹치지 않게 줄 나누기
      const rowsOf = (side) => {
        const rows = [];
        side.forEach(p => {
          let r = rows.findIndex(row => row.every(q => Math.abs(q.cx - p.cx) > (q.w + p.w) / 2 + 16));
          if (r < 0) { rows.push([]); r = rows.length - 1; }
          rows[r].push(p); p.row = r;
        });
        return rows;
      };
      const upRows = rowsOf(pts.filter(p => p.up)), downRows = rowsOf(pts.filter(p => !p.up));
      const rowH = (rows) => rows.map(row => Math.max(...row.map(p => p.h)) + 18);
      const upH = rowH(upRows), downH = rowH(downRows);
      const axisY = y + upH.reduce((s, h) => s + h, 0) + 34;
      const span = t1 - t0, step = span <= 10 ? 1 : span <= 20 ? 2 : 5;
      const ticks = [];
      for (let yr = t0; yr <= t1; yr += step) ticks.push(yr);
      const tickPad = 44;
      pts.forEach(p => {
        if (p.up) p.top = axisY - 34 - upH.slice(0, p.row + 1).reduce((s, h) => s + h, 0) + 18;
        else p.top = axisY + tickPad + downH.slice(0, p.row).reduce((s, h) => s + h, 0) + 10;
      });
      // 그리는 순서: 축 → 연결선 → 점 → (종이색 바탕을 깐) 연도·글 — 연결선이 글 뒤로 지나가게
      ops.push(c => {
        c.strokeStyle = C.ink; c.lineWidth = 3; c.beginPath(); c.moveTo(PAD, axisY); c.lineTo(PAD + innerW, axisY); c.stroke();
        ticks.forEach(yr => { const x = X(yr); c.lineWidth = 2; c.beginPath(); c.moveTo(x, axisY - 7); c.lineTo(x, axisY + 7); c.stroke(); });
        pts.forEach(p => {
          const dx = X(p.d.t);
          c.strokeStyle = C.faint; c.lineWidth = 1.5; c.beginPath(); c.moveTo(dx, axisY);
          c.lineTo(dx, p.up ? p.top + p.h - 4 : p.top - 6); c.stroke();
        });
        pts.forEach(p => { c.beginPath(); c.arc(X(p.d.t), axisY, p.up ? 11 : 9, 0, Math.PI * 2); c.fillStyle = p.it.key ? C.accent : C.ink; c.fill(); });
        c.font = `400 16px ${SANS}`;
        ticks.forEach(yr => {
          const x = X(yr), w = c.measureText(String(yr)).width;
          c.fillStyle = C.bg; c.fillRect(x - w / 2 - 4, axisY + 14, w + 8, 22);
          text(c, String(yr), x, axisY + 30, `400 16px ${SANS}`, C.sub, 'center');
        });
        pts.forEach(p => {
          c.fillStyle = C.bg; c.fillRect(p.cx - p.w / 2 - 6, p.top + 2, p.w + 12, p.h);
          let yy = p.top;
          p.ll.forEach(t => { yy += p.up ? 28 : 26; text(c, t, p.cx, yy - 6, `700 ${p.up ? 22 : 20}px ${SANS}`, p.it.key ? C.accent : C.ink, 'center'); });
          p.tl.forEach(t => { yy += 22; text(c, t, p.cx, yy - 4, `400 16px ${SANS}`, C.sub, 'center'); });
        });
      });
      y = axisY + tickPad + downH.reduce((s, h) => s + h, 0) + 10;
      // 핵심 두 개 사이 기간
      if (keys.length === 2) {
        const [a, b] = keys.map(k => k.d).sort((p, q) => p.t - q.t);
        const months = (b.y * 12 + b.m) - (a.y * 12 + a.m);
        if (months > 0) {
          const label = `약 ${Math.floor(months / 12) ? Math.floor(months / 12) + '년 ' : ''}${months % 12 ? (months % 12) + '개월 ' : ''}차이`;
          const xa = X(a.t), xb = X(b.t), by = y + 30;
          ops.push(c => {
            c.strokeStyle = C.ink; c.lineWidth = 2; c.beginPath(); c.moveTo(xa + 4, by); c.lineTo(xb - 4, by); c.stroke();
            c.fillStyle = C.ink;
            c.beginPath(); c.moveTo(xa, by); c.lineTo(xa + 12, by - 7); c.lineTo(xa + 12, by + 7); c.closePath(); c.fill();
            c.beginPath(); c.moveTo(xb, by); c.lineTo(xb - 12, by - 7); c.lineTo(xb - 12, by + 7); c.closePath(); c.fill();
            text(c, label, (xa + xb) / 2, by - 14, `700 19px ${SANS}`, C.ink, 'center');
          });
          y = by + 16;
        }
      }
    } else if (type === 'steps' && items.length <= 4) {
      // 가로 흐름: 카드 → 화살표 → 카드
      const n = items.length || 1, arrowW = 36;
      const cw = (innerW - arrowW * (n - 1)) / n;
      const metas = items.map(it => {
        ctx.font = `700 23px ${SANS}`;
        const ll = clampLines(wrap(ctx, it.label, cw - 36), 2);
        ctx.font = `400 18px ${SANS}`;
        const tl = it.text ? clampLines(wrap(ctx, it.text, cw - 36), 4) : [];
        return { it, ll, tl, h: 24 + 64 + 20 + ll.length * 32 + (tl.length ? 8 + tl.length * 27 : 0) + 24 };
      });
      const rowH = Math.max(...metas.map(m => m.h));
      const top = y;
      metas.forEach((m, i) => {
        const x = PAD + i * (cw + arrowW);
        ops.push(c => {
          card(c, x, top, cw, rowH, i === n - 1 ? C.callout : C.card, i === n - 1 ? C.calloutEdge : C.cardEdge);
          iconBadge(c, x + cw / 2, top + 24 + 32, 32, m.it.icon, String(i + 1));
          // 단계 번호
          c.beginPath(); c.arc(x + cw / 2 + 26, top + 24 + 8, 13, 0, Math.PI * 2); c.fillStyle = C.accent; c.fill();
          text(c, String(i + 1), x + cw / 2 + 26, top + 24 + 14, `700 15px ${SANS}`, '#fff', 'center');
          let yy = top + 24 + 64 + 20;
          m.ll.forEach(t => { yy += 32; text(c, t, x + cw / 2, yy - 8, `700 23px ${SANS}`, C.ink, 'center'); });
          if (m.tl.length) { yy += 8; m.tl.forEach(t => { yy += 27; text(c, t, x + cw / 2, yy - 6, `400 18px ${SANS}`, C.sub, 'center'); }); }
          if (i < n - 1) {
            const ax = x + cw + 8, ay = top + rowH / 2;
            c.strokeStyle = C.accentSoft; c.lineWidth = 3; c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax + arrowW - 16, ay); c.stroke();
            c.fillStyle = C.accentSoft; c.beginPath(); c.moveTo(ax + arrowW - 12, ay); c.lineTo(ax + arrowW - 22, ay - 8); c.lineTo(ax + arrowW - 22, ay + 8); c.closePath(); c.fill();
          }
        });
      });
      y += rowH;
    } else if (type === 'steps') {
      // 세로 타임라인 (5~6단계)
      items.forEach((it, i) => {
        ctx.font = `400 18px ${SANS}`;
        const tl = it.text ? clampLines(wrap(ctx, it.text, innerW - 150), 2) : [];
        const rowH = 30 + 26 + tl.length * 26 + 24;
        const top = y, last = i === items.length - 1;
        ops.push(c => {
          if (!last) { c.strokeStyle = C.line; c.lineWidth = 3; c.beginPath(); c.moveTo(PAD + 28, top + 60); c.lineTo(PAD + 28, top + rowH + 12); c.stroke(); }
          iconBadge(c, PAD + 28, top + 30, 28, it.icon, String(i + 1));
          card(c, PAD + 76, top, innerW - 76, rowH, last ? C.callout : C.card, last ? C.calloutEdge : C.cardEdge, 14);
          text(c, `${i + 1}`, PAD + 100, top + 38, `800 20px ${SANS}`, C.accent);
          text(c, it.label, PAD + 130, top + 38, `700 22px ${SANS}`, C.ink);
          tl.forEach((t, j) => text(c, t, PAD + 130, top + 66 + j * 26, `400 18px ${SANS}`, C.sub));
        });
        y += rowH + 12;
      });
      y -= 12;
    } else if (type === 'compare' && items.length >= 2) {
      const [a, b] = items;
      const gap = 56, cw = (innerW - gap) / 2;
      const pts = (it) => String(it.text || '').split(/\s*(?:\/|·|;|\n)\s*/).map(s => s.trim()).filter(Boolean).slice(0, 5);
      const metas = [a, b].map(it => {
        ctx.font = `400 19px ${SANS}`;
        const lines = pts(it).map(p => clampLines(wrap(ctx, p, cw - 70), 2));
        const hasVal = !!valueStr(it);
        return { it, lines, hasVal, h: 24 + 56 + 16 + 36 + (hasVal ? 56 : 0) + 12 + lines.reduce((s, l) => s + l.length * 27 + 10, 0) + 18 };
      });
      const rowH = Math.max(...metas.map(m => m.h));
      const top = y;
      metas.forEach((m, i) => {
        const x = PAD + i * (cw + gap);
        ops.push(c => {
          card(c, x, top, cw, rowH, i === 1 ? C.callout : C.card, i === 1 ? C.calloutEdge : C.cardEdge);
          iconBadge(c, x + cw / 2, top + 24 + 28, 28, m.it.icon, i === 0 ? 'A' : 'B');
          let yy = top + 24 + 56 + 16 + 30;
          text(c, m.it.label, x + cw / 2, yy, `700 26px ${SANS}`, C.ink, 'center');
          if (m.hasVal) { yy += 54; text(c, valueStr(m.it), x + cw / 2, yy, `800 42px ${SANS}`, C.accent, 'center'); }
          yy += 22;
          c.fillStyle = C.line; c.fillRect(x + 28, yy - 6, cw - 56, 1.5);
          m.lines.forEach(l => {
            yy += 10;
            c.fillStyle = C.accentSoft; c.beginPath(); c.arc(x + 38, yy + 13, 4, 0, Math.PI * 2); c.fill();
            l.forEach(t => { yy += 27; text(c, t, x + 54, yy - 6, `400 19px ${SANS}`, C.ink); });
          });
        });
      });
      ops.push(c => {
        const cx = PAD + cw + gap / 2, cy = top + rowH / 2;
        c.beginPath(); c.arc(cx, cy, 24, 0, Math.PI * 2); c.fillStyle = C.ink; c.fill();
        text(c, 'VS', cx, cy + 7, `800 18px ${SANS}`, '#fff', 'center');
      });
      y += rowH;
    } else {
      // 표: 아이콘 + 이름 + 설명, 줄무늬 카드
      const labelW = 210;
      items.forEach((it, i) => {
        ctx.font = `400 19px ${SANS}`;
        const tl = clampLines(wrap(ctx, it.text || valueStr(it) || '', innerW - 64 - labelW - 24), 3);
        ctx.font = `700 21px ${SANS}`;
        const ll = clampLines(wrap(ctx, it.label, labelW - 16), 2);
        const rowH = Math.max(tl.length, ll.length) * 29 + 32;
        const top = y;
        ops.push(c => {
          card(c, PAD - 12, top, innerW + 24, rowH, i % 2 ? C.bg : C.card, C.cardEdge, 12);
          iconBadge(c, PAD + 18, top + rowH / 2, 20, it.icon, String(i + 1));
          ll.forEach((t, j) => text(c, t, PAD + 56, top + 36 + j * 29, `700 21px ${SANS}`, C.ink));
          tl.forEach((t, j) => text(c, t, PAD + 56 + labelW, top + 36 + j * 29, `400 19px ${SANS}`, C.ink));
        });
        y += rowH + 8;
      });
      y -= 8;
    }

    // 한 줄 정리
    if (spec.headline) {
      y += 28;
      ctx.font = `700 22px ${SANS}`;
      const hl = clampLines(wrap(ctx, spec.headline, innerW - 96), 2);
      const top = y, h = 34 + hl.length * 32;
      ops.push(c => {
        card(c, PAD, top, innerW, h, C.callout, C.calloutEdge, 14);
        c.font = `26px ${EMOJI}`; c.textBaseline = 'middle'; c.fillText('💡', PAD + 22, top + h / 2 + 1); c.textBaseline = 'alphabetic';
        hl.forEach((t, j) => text(c, t, PAD + 66, top + 17 + 24 + j * 32, `700 22px ${SANS}`, C.ink));
      });
      y += h;
    }
    if (spec.note) {
      y += 22;
      ctx.font = `400 16px ${SANS}`;
      const nl = clampLines(wrap(ctx, spec.note, innerW), 2);
      const ny = y;
      ops.push(c => nl.forEach((t, j) => text(c, t, PAD, ny + 14 + j * 24, `400 16px ${SANS}`, C.faint)));
      y += nl.length * 24;
    }
    return { ops, height: Math.ceil(y + PAD) };
  }

  async function draw(canvas, spec, scale = 2) {
    try { await Promise.all([document.fonts.load(`700 36px ${SERIF}`), document.fonts.load(`400 20px ${SANS}`), document.fonts.load(`700 20px ${SANS}`), document.fonts.load(`800 20px ${SANS}`)]); } catch (e) { /* 기본 글꼴로 */ }
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
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(canvas) })]);
  }

  async function download(canvas, name) {
    const url = URL.createObjectURL(await toBlob(canvas));
    const a = document.createElement('a');
    a.href = url; a.download = `${(name || '도표').replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // 편집창 텍스트 ↔ items ("🏠 이름 | 숫자 | 설명" 한 줄에 하나, 맨 앞 이모지는 아이콘)
  const ICON_RE = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)\s*/u;
  // 맨 앞 ★ = 핵심 항목 (타임라인에서 위쪽에 굵게, 두 개면 사이 기간 표시)
  function itemsToText(items) {
    return (items || []).map(it => [`${it.key ? '★ ' : ''}${it.icon ? it.icon + ' ' : ''}${it.label}`, it.value ?? '', it.text || ''].join(' | ')).join('\n');
  }
  function textToItems(text) {
    return String(text || '').split('\n').map(l => l.split('|').map(s => s.trim())).filter(p => p[0])
      .slice(0, 10).map(([first, value, ...rest]) => {
        let s = first, key = false;
        if (/^[★☆]/.test(s)) { key = true; s = s.replace(/^[★☆]\s*/, ''); }
        const m = s.match(ICON_RE);
        const icon = m ? m[1] : '';
        const label = m ? s.slice(m[0].length).trim() : s;
        const n = Number(String(value || '').replace(/,/g, ''));
        return { icon, key, label: label || icon, value: value !== '' && value !== undefined && isFinite(n) ? n : null, text: rest.join(' | ') || (value && !isFinite(n) ? value : '') };
      });
  }

  // 숫자 대조용 (Worker chart.js와 같은 규칙): 값·숫자가 글에 적힐 수 있는 모양들
  function valueForms(v, unit = '') {
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
  function tokenForms(tok) {
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
  // 항목의 숫자가 모두 text 안에 있는지 → 못 찾은 숫자 목록 (빈 배열이면 확인됨)
  function missingNumbers(it, unit, text) {
    const miss = [];
    const has = forms => forms.some(f => f && text.includes(f));
    if (typeof it.value === 'number' && !has(valueForms(it.value, unit))) miss.push(fmtValue(it.value, unit));
    for (const f of ['label', 'text']) for (const tok of String(it[f] || '').match(/\d[\d,.]*/g) || []) if (!has(tokenForms(tok))) miss.push(tok.replace(/[.,]$/, ''));
    return miss;
  }

  global.ChartCard = { draw, copyImage, download, itemsToText, textToItems, missingNumbers, fmtValue, TYPES };
})(window);
