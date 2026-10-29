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
    ['local-program', '지자체 별도 사업 관련 공고', /EV\s*드림|지역\s*할인|지방비|시비|도비|군비|구비/],
    ['conditions', '신청·중복 조건 관련 공고', /별도\s*공고|중복\s*(?:지원|불가)|소급\s*지급/],
  ] as const;
  return definitions.flatMap(([id,label,pattern]) => {
    const match = pattern.exec(text);
    if (!match) return [];
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    let lineEnd = text.indexOf('\n', match.index);
    if (lineEnd < 0) lineEnd = text.length;
    const start = Math.max(lineStart, match.index - 60);
    const end = Math.min(lineEnd, match.index + 180);
    return [{id,label,excerpt:`${start > lineStart ? '…' : ''}${text.slice(start,end).trim()}${end < lineEnd ? '…' : ''}`}];
  });
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
  return {...result,checkedAt:context.checkedAt,sourceStatus:'live',noticeText,notices,signals:localBenefitSignals(noticeText)};
}
