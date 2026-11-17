// 초안 저장 API (설계 docs/REVIEW_DESIGN.md 3단계)
// 모든 요청은 X-Work-Key 헤더가 Worker Secret WORK_KEY와 일치해야 한다.
//
// type: drafts_list | draft_get | draft_save | draft_archive | review_decision
// review 요청에 draft_id가 있으면 첨삭 결과를 draft_reviews에 저장 (saveReview)

import { supabaseHeaders } from './lib.js';

export const DRAFT_TYPES = new Set(['drafts_list', 'draft_get', 'draft_save', 'draft_archive', 'review_decision']);

const LIMITS = { title: 300, memo: 20000, body: 30000, tags: 500 };

// ---------- 작업 키 ----------
async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
}

// 반환: 'ok' | 'not_configured' | 'invalid'
// 콘솔/파이프로 Secret을 넣을 때 섞이는 줄바꿈·BOM 제거
const cleanKey = (s) => String(s || '').replace(/^﻿/, '').trim();

export async function checkWorkKey(request, env) {
  const expected = cleanKey(env.WORK_KEY);
  if (!expected) return 'not_configured';
  const given = cleanKey(request.headers.get('X-Work-Key'));
  if (!given) return 'invalid';
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  const equal = crypto.subtle.timingSafeEqual
    ? crypto.subtle.timingSafeEqual(a, b)
    : a.every((v, i) => v === b[i]);
  return equal ? 'ok' : 'invalid';
}

// ---------- Supabase REST ----------
async function sb(env, path, { method = 'GET', body, prefer } = {}) {
  const headers = { ...supabaseHeaders(env), 'Content-Type': 'application/json' };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.hint)) || `HTTP ${res.status}`;
    const err = new Error(`DB 오류: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clip(v, max) {
  return String(v ?? '').slice(0, max);
}

export function sanitizeDraft(input) {
  const out = {};
  for (const k of ['title', 'memo', 'body', 'tags']) {
    if (input[k] !== undefined) out[k] = clip(input[k], LIMITS[k]);
  }
  if (input.news !== undefined) {
    const n = input.news;
    out.news = n && typeof n === 'object' && n.title
      ? { title: clip(n.title, 300), summary: clip(n.summary, 1000), link: clip(n.link, 1000) }
      : null;
  }
  if (input.status !== undefined && ['writing', 'reviewed', 'published'].includes(input.status)) out.status = input.status;
  if (input.ai_ratio !== undefined) {
    const r = Number(input.ai_ratio);
    out.ai_ratio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : null;
  }
  if (input.published_url !== undefined) {
    const u = String(input.published_url || '');
    out.published_url = /^https?:\/\//.test(u) ? clip(u, 500) : null;
  }
  return out;
}

// ---------- handlers ----------
export async function handleDraftRequest(body, env) {
  switch (body.type) {
    case 'drafts_list': {
      const rows = await sb(env,
        'drafts?select=id,title,memo,status,ai_ratio,updated_at,created_at&status=neq.archived&order=updated_at.desc&limit=50');
      return { status: 200, json: { drafts: rows.map(r => ({ ...r, memo: (r.memo || '').slice(0, 80) })) } };
    }

    case 'draft_get': {
      const id = toId(body.id);
      if (!id) return { status: 400, json: { error: 'id가 필요합니다.' } };
      const [rows, reviews] = await Promise.all([
        sb(env, `drafts?select=*&id=eq.${id}`),
        sb(env, `draft_reviews?select=id,created_at,result,decisions&draft_id=eq.${id}&order=created_at.desc&limit=5`)
      ]);
      if (!rows.length) return { status: 404, json: { error: '초안을 찾을 수 없습니다.' } };
      return { status: 200, json: { draft: rows[0], reviews } };
    }

    case 'draft_save': {
      const fields = sanitizeDraft(body.draft || {});
      const id = toId(body.id);
      const now = new Date().toISOString();

      if (!id) {
        const rows = await sb(env, 'drafts', { method: 'POST', body: { ...fields, updated_at: now }, prefer: 'return=representation' });
        return { status: 200, json: { id: rows[0].id, updated_at: rows[0].updated_at, created: true } };
      }

      // 낙관적 잠금: 클라이언트가 마지막으로 본 updated_at과 다르면 409 (다른 기기에서 수정됨)
      let filter = `drafts?id=eq.${id}`;
      if (body.base_updated_at && !body.force) filter += `&updated_at=eq.${encodeURIComponent(body.base_updated_at)}`;
      const rows = await sb(env, filter, { method: 'PATCH', body: { ...fields, updated_at: now }, prefer: 'return=representation' });
      if (rows.length) return { status: 200, json: { id, updated_at: rows[0].updated_at, created: false } };

      const current = await sb(env, `drafts?select=*&id=eq.${id}`);
      if (!current.length) return { status: 404, json: { error: '초안을 찾을 수 없습니다.' } };
      return { status: 409, json: { error: '다른 곳에서 먼저 수정된 초안입니다.', draft: current[0] } };
    }

    case 'draft_archive': {
      const id = toId(body.id);
      if (!id) return { status: 400, json: { error: 'id가 필요합니다.' } };
      await sb(env, `drafts?id=eq.${id}`, { method: 'PATCH', body: { status: 'archived', updated_at: new Date().toISOString() } });
      return { status: 200, json: { id, archived: true } };
    }

    case 'review_decision': {
      const id = toId(body.review_id);
      if (!id) return { status: 400, json: { error: 'review_id가 필요합니다.' } };
      const decisions = {};
      for (const [k, v] of Object.entries(body.decisions || {})) {
        if (/^c\d{1,2}$/.test(k) && (v === 'accepted' || v === 'dismissed')) decisions[k] = v;
      }
      await sb(env, `draft_reviews?id=eq.${id}`, { method: 'PATCH', body: { decisions } });
      return { status: 200, json: { review_id: id } };
    }
  }
  return { status: 400, json: { error: 'Invalid request' } };
}

// 첨삭 결과 저장 (review 응답에 review_id 추가). 실패해도 첨삭 자체는 성공으로 둔다.
export async function saveReview(env, draftId, bodySnapshot, result) {
  const id = toId(draftId);
  if (!id) return null;
  const rows = await sb(env, 'draft_reviews', {
    method: 'POST',
    body: { draft_id: id, body_snapshot: clip(bodySnapshot, LIMITS.body), result },
    prefer: 'return=representation'
  });
  // updated_at은 건드리지 않는다 (클라이언트의 낙관적 잠금 기준값이 어긋나지 않도록)
  await sb(env, `drafts?id=eq.${id}&status=eq.writing`, { method: 'PATCH', body: { status: 'reviewed' } });
  return rows[0]?.id ?? null;
}
