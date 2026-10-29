import type { BenefitPolicy } from './benefit-types';
import { decodePolicyEntities, extractHwpxText, MAX_POLICY_ZIP_BYTES, parseBenefitPolicyText } from './benefit-policy-parser';
import { freshRequestHeaders, freshRequestOptions, readBoundedText, UpstreamGate } from './upstream';

const ORIGIN = 'https://ev.or.kr';
const GUIDE_URL = `${ORIGIN}/nportal/infoGarden/initGuideAction.do`;
const POLICY_TIMEOUT = 18_000;
const PER_PAGE = 50;
const MAX_PAGES = 4;
const gate = new UpstreamGate(1, 4);
const pending = new Map<number, Promise<BenefitPolicy>>();
const currentYear = () => Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()));
const currentDate = () => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date());
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const unavailable = (year: number, details: Partial<BenefitPolicy> = {}): BenefitPolicy => ({
  year, revision: '추가 지원 지침 확인 필요', checkedAt: null, sourceUrl: GUIDE_URL,
  documentUrl: null, fingerprint: null, sourceStatus: 'unavailable', rules: [],
  sharedFunding: false, additivePercentages: false, fixedAfterPercentages: false,
  message: '최신 공식 지침을 확인할 수 없어 추가 지원금을 합산하지 않습니다.',
  ...details,
});
function fail(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function post(path: string, data: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...freshRequestOptions, method: 'POST', body: new URLSearchParams(data), signal,
    headers: { ...freshRequestHeaders, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });
  fail(response.ok, '공식 지침 목록 응답 오류');
  const result: unknown = JSON.parse(await readBoundedText(response, 1024 * 1024));
  fail(record(result), '공식 지침 목록 형식 오류');
  return result;
}
async function readBinary(response: Response, limit: number): Promise<Uint8Array> {
  fail(response.ok && response.body, `공식 지침 첨부파일 응답 오류 (${response.status})`);
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel(); throw new Error('공식 지침 파일 크기 초과');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      fail(length <= limit, '공식 지침 파일 크기 초과'); chunks.push(chunk.value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Deadline cancellation may already have closed it. */ }
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}
type Article = { id: number; title: string; fileId: string; published: string };
async function latestArticle(year: number, signal: AbortSignal): Promise<Article> {
  const candidates: Article[] = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const result = await post('/nportal/infoGarden/selectBBSList.ajax', {
      BLBD_ID: 'guide', spageNo: String(page), srecordCountPerPage: String(PER_PAGE), spageSize: '10',
      searchType: 'conAndtit', searchValue: '전기자동차 보급사업 보조금 업무처리지침', searchYear: String(year),
    }, signal);
    fail(Array.isArray(result.list) && result.list.length <= PER_PAGE && record(result.page), '공식 지침 목록 구조 변경');
    const total = Number(result.page._listCount), actualPage = Number(result.page._pageNo);
    fail(Number.isInteger(total) && total >= 0 && total <= PER_PAGE * MAX_PAGES && actualPage === page, '공식 지침 페이지 범위 오류');
    const reportedPages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page === 1) pages = reportedPages;
    else fail(reportedPages === pages, '조회 중 지침 목록이 바뀌었습니다.');
    for (const value of result.list) {
      fail(record(value) && typeof value.TITL === 'string', '공식 지침 행 형식 오류');
      const title = decodePolicyEntities(value.TITL).normalize('NFKC').trim();
      const normalized = title.replace(/\s+/g, '');
      if (!normalized.startsWith(`${year}년전기자동차보급사업보조금업무처리지침`) || /(?:\(안\)|개정안|의견수렴|행정예고|수소|이륜|충전)/.test(normalized)) continue;
      const id = Number(value.ARTC_ID), published = value.INS_DT, fileId = value.FILE_ID;
      fail(Number.isSafeInteger(id) && id > 0 && typeof published === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(published) && Number.isFinite(Date.parse(published)) && new Date(published).toISOString().slice(0, 10) === published && published <= currentDate(), '공식 지침 게시 날짜 오류');
      fail(typeof fileId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(fileId), '공식 지침 첨부 식별자 오류');
      fail(!candidates.some(a => a.id === id), '공식 지침 게시글 중복');
      candidates.push({ id, title, fileId, published });
    }
  }
  fail(candidates.length > 0, '올해 확정된 자동차 지침을 찾을 수 없습니다.');
  return candidates.sort((a, b) => b.published.localeCompare(a.published) || b.id - a.id)[0];
}
async function loadPolicy(year: number): Promise<BenefitPolicy> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('공식 지침 조회 제한시간 초과', 'TimeoutError')), POLICY_TIMEOUT);
  const details: Partial<BenefitPolicy> = {};
  try {
    return await gate.run(async () => {
      const article = await latestArticle(year, controller.signal);
      details.revision = article.title;
      details.sourceUrl = `${ORIGIN}/nportal/board/generalView.do?ARTC_ID=${article.id}&boardType=guide`;
      const supportedTitle = new RegExp(`^${year}년전기자동차보급사업보조금업무처리지침(?:개정)?(?:\\(['’]?(?:\\d{2}|${year})\\.\\d{1,2}\\.\\d{1,2}\\.\\))?$`);
      fail(supportedTitle.test(article.title.replace(/\s+/g, '')), '최신 지침 제목의 상태를 확인해야 합니다.');
      const attachment = await post('/nportal/infoGarden/selectFileList.ajax', { FILE_ID: article.fileId }, controller.signal);
      fail(Array.isArray(attachment.list) && attachment.list.length > 0 && attachment.list.length <= 16, '공식 첨부파일 목록 형식 오류');
      const files = attachment.list.filter((value): value is Record<string, unknown> => {
        if (!record(value) || typeof value.FILE_NAME !== 'string') return false;
        const name = decodePolicyEntities(value.FILE_NAME).normalize('NFKC');
        return name.includes(`${year}년`) && name.includes('전기자동차') && name.includes('업무처리지침') && /\.hwpx$/i.test(name) && !/(?:수소|이륜|\(안\)|개정안)/.test(name);
      });
      fail(files.length === 1, '최신 지침의 첨부 형식 또는 파일 수가 바뀌었습니다.');
      const file = files[0], mask = file.FILE_MASK, size = Number(file.FILE_SIZE);
      fail(typeof mask === 'string' && /^[A-Za-z0-9]{16,128}$/.test(mask) && Number.isSafeInteger(size) && size > 0 && size <= MAX_POLICY_ZIP_BYTES, '공식 지침 첨부파일 정보 오류');
      details.documentUrl = `${ORIGIN}/nportal/file/downloadJfile.do?FILE_MASK=${mask}`;
      // The official Java download endpoint returns HTTP 500 when User-Agent is
      // absent (Workers omit it by default). Identify this app without spoofing a browser.
      const response = await fetch(details.documentUrl, {
        ...freshRequestOptions, redirect: 'follow', signal: controller.signal,
        headers: { ...freshRequestHeaders, 'User-Agent': 'EVSubsidyFinder/1.0' },
      });
      const bytes = await readBinary(response, MAX_POLICY_ZIP_BYTES);
      fail(bytes.length === size, `공식 지침 첨부파일 크기가 목록과 다릅니다 (${bytes.length}/${size}).`);
      details.fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), x => x.toString(16).padStart(2, '0')).join('');
      fail(!controller.signal.aborted, '공식 지침 조회 제한시간 초과');
      const parsed = parseBenefitPolicyText(extractHwpxText(bytes), year);
      fail(!controller.signal.aborted && currentYear() === year, '공식 지침의 조회 연도가 바뀌었습니다.');
      return {
        year, revision: article.title, checkedAt: new Date().toISOString(), sourceUrl: details.sourceUrl!,
        documentUrl: details.documentUrl!, fingerprint: details.fingerprint!, sourceStatus: 'live', ...parsed,
      };
    }, controller.signal);
  } catch (error) {
    console.warn('Official additional-support policy refresh failed', error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown upstream failure');
    return unavailable(year, details);
  } finally {
    clearTimeout(timer); controller.abort();
  }
}

/** Every sequential lookup discovers and verifies the current official document again. */
export function getBenefitPolicy(year: number): Promise<BenefitPolicy> {
  if (!Number.isInteger(year) || year !== currentYear()) return Promise.resolve(unavailable(year));
  const shared = pending.get(year); if (shared) return shared;
  const request = loadPolicy(year).finally(() => { if (pending.get(year) === request) pending.delete(year); });
  pending.set(year, request); return request;
}
export const getBenefitPolicyRuntimeState = () => ({ pending: pending.size, ...gate.state });
