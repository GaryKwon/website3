import { fetchOfficialData, type OfficialDataset } from './official-source';
import passengerSnapshot from './data/official-passenger.json';
import cargoSnapshot from './data/official-cargo.json';
import { regions } from './regions';
import { BoundedCache } from './cache';
import { readBoundedText } from './upstream';
import { localNoticeAttachments } from './local-benefit-source';
import type { LocalBenefitNotice } from './benefit-types';

export type VehicleType = 'passenger' | 'cargo';
export type Check = { id: string; label: string; passed: boolean };
export type SubsidyRecord = {
  regionId: string; province: string; region: string; vehicleType: VehicleType;
  announced: number | null; received: number | null; selected: number | null;
  delivered: number | null; remaining: number | null; available: number | null;
  status: 'open' | 'closed' | 'unknown'; statusReason: string | null;
  deadline: string | null; notice: string; phone: string | null;
  verification: 'verified' | 'review' | 'stale'; checks: Check[];
  categories: { name: string; announced: number | null; selected: number | null; available: number | null; remaining: number | null }[];
  sourceUrl: string; checkedAt: string; year: number;
  noticeAttachments?: LocalBenefitNotice[];
};
export type SubsidyResponse = {
  records: SubsidyRecord[]; checkedAt: string | null; attemptedAt: string;
  sourceUrl: string; year: number; sourceStatus: 'live' | 'cached' | 'unavailable';
  message?: string; fingerprint?: string;
};
export const SOURCE_URL = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const STALE_AFTER = 30 * 60_000;
type SubsidyBaseline=Pick<OfficialDataset,'rows'>;
type CacheEntry={dataset:OfficialDataset;baseline?:SubsidyBaseline};
const memory=new BoundedCache<string,CacheEntry>(2,30*60_000,6*1024*1024);
const inFlight = new Map<string, Promise<SubsidyResponse>>();

export function plainText(value: unknown): string {
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '').trim().slice(0, 24000);
}

export function countParts(value: unknown): (number | null)[] {
  return String(value ?? '').split(/<br\s*\/?\s*>/gi).map(s => {
    const text = plainText(s).replace(/[(),\s]/g, '');
    if (!/^[-+]?\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  });
}

const numeric = (v: unknown): number | null => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const primary = (v: unknown) => countParts(v)[0] ?? null;
const nonnegative = (v: number | null) => v !== null && v >= 0;

function deadlineOf(data: OfficialDataset, id: string): string | null {
  const finish = data.finishRows?.find(r => String(r.LOCAL_CD) === id);
  if (finish?.FIN_DAY) return `${finish.FIN_DAY}T${finish.FIN_TM || '23:59'}:00+09:00`;
  const period = data.periodRows?.find(r => String(r.LOCAL_CD) === id);
  if (!period) return null;
  return [['END_DAY', 'END_TM'], ['REV_END_DAY', 'REV_END_TM'], ['REV_END_DAY2', 'REV_END_TM2'], ['REV_END_DAY3', 'REV_END_TM3']]
    .filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(String(period[day] ?? '')))
    .map(([day, time]) => `${period[day]}T${period[time] || '23:59'}:00+09:00`).sort().at(-1) ?? null;
}

export function normalizeDataset(data: OfficialDataset, type: VehicleType, year: number, now = Date.now(), previous?: SubsidyBaseline): SubsidyRecord[] {
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const row of data.rows) {
    const id = String(row.LOCAL_CD);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  const checkedTime = Date.parse(data.checkedAt);
  const isStale = now - checkedTime > STALE_AFTER || checkedTime > now + 5 * 60_000 || !Number.isFinite(checkedTime);
  const rows = data.rows.filter(r => String(r.LOCAL_CD) !== '9999');
  return rows.map(row => {
    const id = String(row.LOCAL_CD);
    const announced = primary(row.TCNT_1);
    const received = primary(row.RECEICNT_1);
    const delivered = primary(row.RELEACNT_1);
    const remaining = primary(row.RESICNT_1);
    const choiceRows = data.choiceRows?.filter(r => String(r.LOCAL_CD) === id) ?? [];
    const choice = choiceRows.find(r => r.NM === row.NM) ?? choiceRows.find(r => r.NM === '전체');
    const selected = choice ? numeric(choice.CHOICE_CNT) : null;
    const available = announced !== null && selected !== null ? Math.max(0, announced - selected) : null;
    const goals = countParts(row.TCNT_1);
    const deliveryRemains = countParts(row.RESICNT_1);
    // Reproduce the official category allocation, including over-selection transfers.
    const choices = choice ? [selected, numeric(choice.CHOICE_PRI), numeric(type === 'cargo' ? choice.CHOICE_TAXI : choice.CHOICE_BUSI), numeric(type === 'cargo' ? choice.CHOICE_HDRY : choice.CHOICE_TAXI), numeric(choice.CHOICE_COM)] : [];
    const rawRemains = goals.map((goal, i) => goal !== null && choices[i] !== null && choices[i] !== undefined ? goal - choices[i]! : null);
    const overflow = rawRemains.slice(1, -1).reduce<number>((sum, value) => sum + (value !== null && value < 0 ? -value : 0), 0);
    if (rawRemains.length === 5 && rawRemains[4] !== null) rawRemains[4]! -= overflow;
    const names = ['전체', '우선순위', '법인·기관', type === 'cargo' ? '택배' : '택시', '일반'];
    const categories = names.map((name, i) => ({name, announced: goals[i] ?? null, selected: choices[i] ?? null, available: rawRemains[i] !== null && rawRemains[i] !== undefined ? Math.max(0, rawRemains[i]!) : null, remaining: deliveryRemains[i] ?? null}));
    const notice = plainText(row.ETC);
    const deadline = deadlineOf(data, id);
    const deadlineClosed = !!deadline && Date.parse(deadline) < now;
    // Notes contain historical notices. Only the beginning can override a numeric signal.
    const headline = notice.slice(0, 500);
    const relevant = headline.split('\n').find(line => (type === 'cargo' ? /화물/.test(line) : /승용/.test(line)) && /마감|소진|종료/.test(line) && !/소진\s*시|마감\s*시|마감\s*예정/.test(line));
    const partiallyOpen = !!relevant && /접수\s*가능|신청\s*가능|접수\s*중/.test(relevant);
    const status: SubsidyRecord['status'] = deadlineClosed || (!!relevant && !partiallyOpen) || available === 0 ? 'closed' : 'unknown';
    const statusReason = partiallyOpen ? '구분별 접수 상태가 달라요 · 공고 확인' : relevant?.trim() ?? (deadlineClosed ? '공식 신청 마감일 경과' : available === 0 ? '공식 선정 잔여 0대' : '신청 여부는 공고문에서 확인');
    const old = previous?.rows.find(r => String(r.LOCAL_CD) === id);
    const oldGoal = old ? primary(old.TCNT_1) : null;
    const largeChange = oldGoal !== null && oldGoal > 0 && announced !== null && Math.abs(announced - oldGoal) / oldGoal > 0.5;
    const region = regions.find(r => r.id === id);
    const checks: Check[] = [
      {id:'source', label:'공식 사이트 원문 수집', passed: data.sourceUrl.startsWith(SOURCE_URL)},
      {id:'year', label:`${year}년·차종 일치`, passed: Number(row.YEAR) === year && row.NM === (type === 'cargo' ? '전기화물' : '전기승용')},
      {id:'region', label:'지역 코드·명칭·중복 검사', passed: /^\d{4,5}$/.test(id) && !duplicates.has(id) && region?.name === plainText(row.LOCAL_NM)},
      {id:'counts', label:'공고·접수·출고 수치 검사', passed: [announced,received,delivered,remaining].every(nonnegative)},
      {id:'remaining', label:'출고 잔여 계산 일치', passed: announced !== null && delivered !== null && remaining === Math.max(0, announced-delivered)},
      {id:'selection', label:'선정 잔여·공고 차수 대조', passed: selected !== null && announced !== null && (data.stepRows?.filter(r => String(r.LOCAL_CD) === id).reduce((sum, r) => sum + (numeric(r.STEP_CNT) ?? 0), 0) ?? 0) === announced},
      {id:'change', label:'공고 수량 급변 검사', passed: !largeChange},
      {id:'notice', label:'구분별 접수 공고 확인', passed: !partiallyOpen},
      {id:'freshness', label:'30분 이내 원문 확인·시각 검사', passed: !isStale},
    ];
    return {
      regionId:id, province:region?.province ?? plainText(row.SHORT_AREA_NM), region:plainText(row.LOCAL_NM), vehicleType:type,
      announced, received, selected, delivered, remaining, available, categories,
      status, statusReason, deadline, notice, phone:notice.match(/0\d{1,2}[-)\s]\d{3,4}[-\s]\d{4}/)?.[0] ?? null,
      verification:isStale ? 'stale' : checks.every(c => c.passed) ? 'verified' : 'review', checks,
      sourceUrl:data.sourceUrl, checkedAt:data.checkedAt, year:Number(row.YEAR),
      noticeAttachments:localNoticeAttachments(row,{regionId:id,vehicleType:type,year}),
    };
  });
}

function runtimeCache(): Cache | undefined {
  return (globalThis as unknown as {caches?: {default?: Cache}}).caches?.default;
}
const cacheKey = (type: VehicleType, year: number) => new Request(`https://ev-subsidy-finder.kwongary1129.chatgpt.site/__official-fallback-v3/${year}/${type}`);

async function load(type: VehicleType, year: number): Promise<SubsidyResponse> {
  const key = `${year}:${type}`;
  const now = Date.now();
  let last = memory.get(key);
  if (!last) {
    try {
      const cached = await runtimeCache()?.match(cacheKey(type,year));
      if (cached) {
        const entry=JSON.parse(await readBoundedText(cached,6*1024*1024)) as CacheEntry;
        if (entry.dataset?.year === year && Array.isArray(entry.dataset.rows)) last = entry;
      }
    } catch { /* A cache outage must not prevent an official fetch. */ }
    if (!last) {
      const snapshot = (type === 'cargo' ? cargoSnapshot : passengerSnapshot) as unknown as OfficialDataset;
      if (snapshot.year === year && snapshot.rows?.length) last={dataset:snapshot};
    }
  }
  try {
    const dataset = await fetchOfficialData(type,year);
    if (!dataset.rows.length || dataset.rows.some(r => Number(r.YEAR) !== year) || (last && dataset.rows.length < last.dataset.rows.length * 0.8)) throw new Error('Incomplete official data');
    const result = response(dataset,'live',type,year,now,last?.dataset);
    const baseline=last?{rows:last.dataset.rows.map(({LOCAL_CD,TCNT_1})=>({LOCAL_CD,TCNT_1}))}:undefined;
    const entry:CacheEntry={dataset,baseline};
    memory.set(key,entry);
    try {
      await runtimeCache()?.put(cacheKey(type,year),new Response(JSON.stringify(entry),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=86400'}}));
    } catch { /* Keep the validated in-memory response. */ }
    return result;
  } catch {
    if (last) {
      memory.set(key,last);
      return {...response(last.dataset,'cached',type,year,now,last.baseline),message:'공식 사이트 연결 지연 · 마지막 확인 데이터'};
    }
    return {records:[],checkedAt:null,attemptedAt:new Date(now).toISOString(),sourceUrl:SOURCE_URL,year,sourceStatus:'unavailable',message:'현재 공식 정보를 불러올 수 없어요'};
  }
}

function response(dataset: OfficialDataset, sourceStatus: 'live'|'cached', type: VehicleType, year: number, now: number, previous?: SubsidyBaseline): SubsidyResponse {
  const records = normalizeDataset(dataset,type,year,now,previous);
  if (sourceStatus === 'cached') for (const r of records) {
    r.verification = 'stale';
    r.checks.push({id:'connection',label:'최신 원문 재조회',passed:false});
  }
  return {records,checkedAt:dataset.checkedAt,attemptedAt:new Date(now).toISOString(),sourceUrl:dataset.sourceUrl,year,sourceStatus,fingerprint:dataset.fingerprint};
}

export function getSubsidies(type: VehicleType, year: number): Promise<SubsidyResponse> {
  const key = `${year}:${type}`;
  const running = inFlight.get(key);
  if (running) return running;
  const pending = load(type,year).finally(() => inFlight.delete(key));
  inFlight.set(key,pending);
  return pending;
}

/** Read-only counters for operational and regression checks. */
export const getSubsidyRuntimeState=()=>({entries:memory.size,bytes:memory.retainedBytes,pending:inFlight.size});
