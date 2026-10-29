import type { LocalBenefitInfo, LocalBenefitNotice } from './benefit-types';
import type { SubsidyRecord } from './subsidies';
import { regions } from './regions';

const SOURCE = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const DOWNLOAD = 'https://ev.or.kr/nportal/ps/comm/noticeFile/download.do';
const authorities = new Set(regions.filter(region => !region.children?.length && /^\d{4,5}$/.test(region.id)).map(region => region.id));
type LocalContext = { regionId: string; vehicleType: 'passenger' | 'cargo'; year: number };
export type LocalBenefitContext = LocalContext & { sourceStatus: string; checkedAt: string | null };

// This is the official page's FILE_DEFS mapping, not a guessed attachment order.
const NOTICE_FIELDS = [
  ['NOTICE_FILE_YN', 'A', '본공고'], ['NOTICE_FILE_YN02', 'A02', '본공고 2'], ['NOTICE_FILE_YN03', 'A03', '본공고 3'],
  ['NOTICE_FILE_YN04', 'A04', '본공고 4'], ['NOTICE_FILE_YN05', 'A05', '본공고 5'],
  ['NOTICE_FILE_YN1', 'B', '추경 1차'], ['NOTICE_FILE_YN12', 'B12', '추경 1차 2'], ['NOTICE_FILE_YN13', 'B13', '추경 1차 3'],
  ['NOTICE_FILE_YN14', 'B14', '추경 1차 4'], ['NOTICE_FILE_YN15', 'B15', '추경 1차 5'],
  ['NOTICE_FILE_YN2', 'C', '추경 2차'], ['NOTICE_FILE_YN22', 'C22', '추경 2차 2'], ['NOTICE_FILE_YN23', 'C23', '추경 2차 3'],
  ['NOTICE_FILE_YN24', 'C24', '추경 2차 4'], ['NOTICE_FILE_YN25', 'C25', '추경 2차 5'],
  ['NOTICE_FILE_YN3', 'D', '추경 3차'], ['NOTICE_FILE_YN32', 'D32', '추경 3차 2'], ['NOTICE_FILE_YN33', 'D33', '추경 3차 3'],
  ['NOTICE_FILE_YN34', 'D34', '추경 3차 4'], ['NOTICE_FILE_YN35', 'D35', '추경 3차 5'],
] as const;

function validContext(context: LocalContext): boolean {
  return authorities.has(context.regionId) && Number.isInteger(context.year) && context.year >= 2020 && context.year <= 2100
    && (context.vehicleType === 'passenger' || context.vehicleType === 'cargo');
}

export function localBenefitSourceUrl(context: LocalContext): string {
  if (!validContext(context)) return SOURCE;
  return `${SOURCE}?${new URLSearchParams({year1:String(context.year),car_type:context.vehicleType === 'passenger' ? '11' : '12',localDo_cd:'all',local_cd1:context.regionId})}`;
}

export function localNoticeAttachments(row: Record<string, unknown>, context: LocalContext): LocalBenefitNotice[] {
  if (!validContext(context) || row.LOCAL_CD !== context.regionId || Number(row.YEAR) !== context.year
      || row.NM !== (context.vehicleType === 'passenger' ? '전기승용' : '전기화물')) return [];
  return NOTICE_FIELDS.filter(([field]) => row[field] === 'Y').map(([,code,label]) => ({
    code, label,
    downloadUrl:`${DOWNLOAD}?${new URLSearchParams({year:String(context.year),local_cd:context.regionId,attach_gubun:code,model_gubun:'car',car_type:context.vehicleType === 'passenger' ? '11' : '12'})}`,
  }));
}

/** Plain text evidence only. A caller must render this as text, never as HTML. */
export function localNoticeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 96_000).replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 24_000);
}

/** A mention is not an award, an active program, or proof of any monetary amount. */
export function localBenefitSignals(value: string): LocalBenefitInfo['signals'] {
  const text = localNoticeText(value);
  const definitions = [
    ['children', '다자녀 관련 공고', /다자녀|(?:[234]|두|세|네)\s*자녀/],
    ['youth', '청년·생애 첫차 관련 공고', /청년|생애\s*(?:최초|첫)/],
    ['smallBusiness', '소상공인 관련 공고', /소상공인/],
    ['delivery', '택배 관련 공고', /택배/],
    ['taxi', '택시 관련 공고', /택시/],
    // The UI selects both low-income rule IDs; this is a common evidence subject,
    // not an inference that a passenger rule applies to the current vehicle type.
    ['lowIncomePassenger', '기초·차상위 관련 공고', /기초\s*(?:생활\s*)?수급|차상위|저소득(?:층)?/],
    ['farmer', '농업인 관련 공고', /농업인|농업\s*경영체|농민/],
    ['local-program', '지방비 관련 공고', /EV\s*드림|아이\s*조아|지역\s*할인|(?:제조|수입|제작)사\s*(?:추가\s*)?할인|지방비|시비|도비|군비|구비(?!\s*서류)/i],
    ['conditions', '신청·중복 조건 관련 공고', /별도\s*공고|중복|동시\s*지원|차감|감액|공제|마감|종료|소진|해당\s*없음|소급\s*지급/],
  ] as const;
  type Signal = LocalBenefitInfo['signals'][number];
  type Kind = NonNullable<Signal['kind']>;
  type Candidate = Signal & { kind: Kind; score: number; order: number };
  const restriction = /중복[^.\n]{0,28}(?:불가|금지|제한)|동시\s*지원[^.\n]{0,20}(?:불가|금지)|택\s*(?:일|1)/;
  const deduction = /차감|감액|공제/;
  // These are mentions of a closure or a condition, not a claim that it is closed now.
  const closure = /마감|종료|소진|해당\s*없음|접수\s*중단|지원\s*중단|미시행/;
  const namedProgram = /EV\s*드림|아이\s*조아|지역\s*할인|(?:제조|수입|제작)사\s*(?:추가\s*)?할인/i;
  const benefit = /(?:추가|별도)\s*(?:보조금|지원)|가산|추가금|지원\s*비율|(?:지원|할인)\s*(?:금액|단가)|\d+(?:[,.]\d+)?\s*(?:만\s*원|%|퍼센트)/;
  const genericPriority = /우선\s*(?:지원|순위|배정)|별도\s*배정|배정\s*(?:물량|대수)|구비\s*서류/;
  const rank: Record<Kind,number> = { restriction:600,deduction:500,closure:400,program:300,benefit:200,general:0 };
  const candidates: Candidate[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    for (const [id,defaultLabel,pattern] of definitions) {
      // Retain the strongest two excerpts for each subject while scanning every line.
      // Input is capped at 24,000 characters, and no source text or URL becomes an award.
      const matches = line.matchAll(new RegExp(pattern.source, pattern.flags.includes('i') ? 'gi' : 'g'));
      for (const match of matches) {
        const index = match.index ?? 0;
        const start = Math.max(0,index - 70);
        const end = Math.min(line.length,index + 190);
        const snippet = line.slice(start,end).trim();
        if (!snippet) continue;
        const kind: Kind = restriction.test(snippet) ? 'restriction' : deduction.test(snippet) ? 'deduction'
          : closure.test(snippet) ? 'closure' : namedProgram.test(snippet) ? 'program' : benefit.test(snippet) ? 'benefit' : 'general';
        const label = id === 'local-program' && namedProgram.test(snippet) ? '지자체 별도 사업 관련 공고'
          : id === 'conditions' && kind === 'restriction' ? '중복·신청 제한 관련 공고'
          : id === 'conditions' && kind === 'deduction' ? '보조금 차감 관련 공고'
          : id === 'conditions' && kind === 'closure' ? '마감·예산 조건 관련 공고' : defaultLabel;
        const excerpt = `${start ? '…' : ''}${snippet}${end < line.length ? '…' : ''}`;
        const candidate: Candidate = { id,label,excerpt,kind,score:rank[kind] + (benefit.test(snippet) ? 20 : 0)
          + (namedProgram.test(snippet) ? 10 : 0) - (genericPriority.test(snippet) ? 15 : 0),order:offset + index };
        if (candidates.some(item => item.id === id && item.excerpt === excerpt)) continue;
        candidates.push(candidate);
        const sameSubject = candidates.filter(item => item.id === id).sort((a,b) => b.score - a.score || a.order - b.order);
        for (const discarded of sameSubject.slice(2)) candidates.splice(candidates.indexOf(discarded),1);
      }
    }
    offset += line.length + 1;
  }
  const counts: Partial<Record<Kind,number>> = {};
  const limits: Record<Kind,number> = { restriction:3,deduction:3,closure:3,program:3,benefit:5,general:2 };
  const seenExcerpts = new Set<string>();
  return candidates.sort((a,b) => b.score - a.score || a.order - b.order).filter(candidate => {
    if (seenExcerpts.has(candidate.excerpt)) return false;
    const count = counts[candidate.kind] ?? 0;
    if (count >= limits[candidate.kind]) return false;
    seenExcerpts.add(candidate.excerpt);
    counts[candidate.kind] = count + 1;
    return true;
  }).slice(0,10).map(({id,label,excerpt,kind}) => ({id,label,excerpt,kind}));
}

export function localBenefitInfo(record: SubsidyRecord | undefined, context: LocalBenefitContext): LocalBenefitInfo {
  const result: LocalBenefitInfo = {
    regionId:context.regionId,vehicleType:context.vehicleType,year:context.year,
    checkedAt:null,sourceStatus:'unavailable',sourceUrl:localBenefitSourceUrl(context),
    noticeText:'',notices:[],signals:[],monetaryVerification:'local-notice-required',
  };
  const now = Date.now();
  const currentYear = Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date(now)));
  const checked = Date.parse(context.checkedAt ?? '');
  let source: URL;
  try { source = new URL(record?.sourceUrl ?? ''); } catch { return result; }
  if (!validContext(context) || context.year !== currentYear || !record || context.sourceStatus !== 'live' || record.verification === 'stale'
      || record.regionId !== context.regionId || record.vehicleType !== context.vehicleType || record.year !== context.year
      || context.checkedAt !== record.checkedAt || !Number.isFinite(checked) || now - checked > 30 * 60_000 || checked > now + 5 * 60_000
      || source.origin !== 'https://ev.or.kr' || source.pathname !== '/nportal/buySupprt/initSubsidyPaymentCheckAction.do'
      || !record.checks.some(check => check.id === 'region' && check.passed) || !record.checks.some(check => check.id === 'year' && check.passed)) return result;
  const noticeText = localNoticeText(record.notice);
  const allowedNotices = new Map<string,string>(NOTICE_FIELDS.map(([,code,label]) => [code,label]));
  const seen = new Set<string>();
  const notices = (record.noticeAttachments ?? []).flatMap(notice => {
    const label = allowedNotices.get(notice.code);
    if (!label || seen.has(notice.code)) return [];
    const expected = `${DOWNLOAD}?${new URLSearchParams({year:String(context.year),local_cd:context.regionId,attach_gubun:notice.code,model_gubun:'car',car_type:context.vehicleType === 'passenger' ? '11' : '12'})}`;
    if (notice.downloadUrl !== expected) return [];
    seen.add(notice.code);
    return [{code:notice.code,label,downloadUrl:expected}];
  });
  // checkedAt verifies the current official notice index / ETC only. Attachment links
  // and snippets do not establish that every attachment's monetary rules were reviewed.
  return {...result,checkedAt:context.checkedAt,sourceStatus:'live',noticeText,notices,signals:localBenefitSignals(noticeText)};
}
