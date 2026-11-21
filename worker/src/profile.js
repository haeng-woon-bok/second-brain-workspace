// 이 Worker가 맡은 블로그 (배포마다 하나): wrangler.toml의 [vars] BLOG_ID, BLOG_NAME
// 내 환경은 값이 없으면 기존 값 그대로. 테스터 환경은 [env.tester.vars]로 지정.
// Worker 하나는 블로그 하나만 맡으므로, 요청마다 env에서 읽어 모듈 값으로 둔다.
const OWNER = { blogId: 'dad_luckyhappy', blogName: '행운복의 재테크' };
let current = OWNER;

export function initProfile(env) {
  const id = String((env && env.BLOG_ID) || '').trim();
  current = id && /^[A-Za-z0-9_-]{2,40}$/.test(id)
    ? { blogId: id, blogName: String(env.BLOG_NAME || id).trim().slice(0, 40) }
    : OWNER;
}

export const blogId = () => current.blogId;
export const blogName = () => current.blogName;
// 원래 주인(행운복의 재테크) 환경인지 — 사람이 직접 분석해 둔 문체 설명은 이 환경에서만 씀
export const isOwner = () => current.blogId === OWNER.blogId;
export const profileInfo = () => ({ blog_id: current.blogId, blog_name: current.blogName });
