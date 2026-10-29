import specsSnapshot from './data/vehicles-specs.json';
import { freshRequestOptions, freshRequestHeaders, readBoundedText, upstreamGate } from './upstream';

export type VehicleType = 'passenger' | 'cargo';
export type VehicleCheck = { id: string; label: string; passed: boolean };
export interface VehicleRecord {
  id: string;
  manufacturer: string;
  modelName: string;
  vehicleType: VehicleType;
  category: string;
  categoryCode: string;
  national: number | null;
  local: number | null;
  total: number | null;
  transitionNational: number | null;
  transitionLocal: number | null;
  discontinued: boolean;
  specs: { battery: string | null; range: string | null; seats: string | null };
  checks: VehicleCheck[];
}
export interface VehicleDataset {
  regionId: string;
  year: number;
  checkedAt: string;
  sourceUrl: string;
  records: VehicleRecord[];
  fingerprint: string;
}
type Row = Record<string, unknown>;
type SpecRecord = { manufacturer: string; modelName: string; vehicleType: VehicleType; battery: string | null; range: string | null; seats: string | null; national: number | null };
export interface VehicleSpecsDataset {
  year: number;
  checkedAt: string;
  sourceUrl: string;
  records: SpecRecord[];
  sourceStatus?:'live'|'cached'|'unavailable';
}

const ORIGIN = 'https://ev.or.kr';
export const VEHICLE_PRICE_SOURCE = `${ORIGIN}/nportal/buySupprt/initPsLocalCarPirceAction.do`;
export const VEHICLE_SPEC_SOURCE = `${ORIGIN}/nportal/buySupprt/initSubsidyTargetVehicleAction.do`;
const PRICE_ENDPOINT = `${ORIGIN}/nportal/buySupprt/getLocalCarModelPrice.ajax`;
const SPEC_ENDPOINT = `${ORIGIN}/nportal/buySupprt/selectTargetVehicle.ajax`;
let lastSpecs:VehicleSpecsDataset|undefined;
let pendingSpecs:{year:number;promise:Promise<VehicleSpecsDataset>}|undefined;

const text = (value: unknown): string => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 1200);
const optionalText = (value: unknown): string | null => {
  const clean = text(value);
  return clean && clean !== '-' && clean !== 'null' ? clean : null;
};
export const normalizeVehicleName = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('en');

/** All public price endpoint fields below use ten-thousand Korean won (만원). */
export function parseVehicleAmount(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const original = String(value).trim().replace(/만원$/, '').trim();
  if (original.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?$/.test(original)) return null;
  const clean = original.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,4})?$/.test(clean)) return null;
  const amount = Number(clean);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000 ? amount : null;
}

async function postOfficial(endpoint: string, data: Record<string, string>, timeout = 12_000): Promise<Row> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await upstreamGate.run(async()=>{
    const result = await fetch(endpoint, {
      ...freshRequestOptions,
      method: 'POST',
      headers: {
        ...freshRequestHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Referer: VEHICLE_PRICE_SOURCE,
      },
      body: new URLSearchParams(data).toString(),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!result.ok) {
      try {await result.body?.cancel();} catch {}
      throw new Error(`공식 차량 정보 응답: ${result.status}`);
    }
    const body=await readBoundedText(result,2_000_000);
    if (body.length > 2_000_000) throw new Error('공식 차량 정보 크기를 확인할 수 없습니다.');
    const json: unknown = JSON.parse(body);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('공식 차량 정보 형식이 변경되었습니다.');
    return json as Row;
    },controller.signal);
  } finally { clearTimeout(timer);controller.abort(); }
}

function parseSpecs(payload: Row, year: number): VehicleSpecsDataset {
  if (!Array.isArray(payload.list) || payload.list.length < 20) throw new Error('공식 차량 제원 목록이 비어 있습니다.');
  const records: SpecRecord[] = payload.list.filter((r: Row) => r.CAR_KIND === '1C' || r.CAR_KIND === '2T').map((r: Row) => ({
    manufacturer: text(r.MADE_COMPANY_NM), modelName: text(r.MODEL),
    vehicleType: r.CAR_KIND === '1C' ? 'passenger' : 'cargo',
    battery: optionalText(r.BATTERY), range: optionalText(r.CHARGER_DISTANCE), seats: optionalText(r.PERSONS),
    national: parseVehicleAmount(r.SALE_PRICE),
  }));
  if (!records.length) throw new Error('공식 차량 제원에 전기승용·화물 정보가 없습니다.');
  return {year,checkedAt:new Date().toISOString(),sourceUrl:VEHICLE_SPEC_SOURCE,records,sourceStatus:'live'};
}

/** Exact model/manufacturer matching only: unavailable specifications stay null. */
export function fetchVehicleSpecs(year:number):Promise<VehicleSpecsDataset> {
  if(pendingSpecs?.year===year) return pendingSpecs.promise;
  const currentYear=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
  if(year!==currentYear) return Promise.resolve({year,checkedAt:new Date().toISOString(),sourceUrl:VEHICLE_SPEC_SOURCE,records:[],sourceStatus:'unavailable'});
  if(lastSpecs?.year!==year) lastSpecs=undefined;
  let promise:Promise<VehicleSpecsDataset>;
  promise=(async()=>{
    try {
      const payload=await postOfficial(SPEC_ENDPOINT,{spageId:'subsidyTargetVehicle',spageNo:'1',srecordCountPerPage:'99999',spageSize:'10',carType:'',schCompany:'ALL',schModel:'ALL'});
      const value=parseSpecs(payload,year);
      lastSpecs=value;
      return value;
    } catch {
      if(lastSpecs?.year===year) return {...lastSpecs,sourceStatus:'cached' as const};
      if(specsSnapshot.year===year) return {
        ...specsSnapshot,sourceStatus:'cached' as const,
        records:specsSnapshot.records.map(r=>({...r,vehicleType:r.vehicleType as VehicleType,national:parseVehicleAmount(r.national),battery:optionalText(r.battery),range:optionalText(r.range),seats:optionalText(r.seats)})),
      };
      return {year,checkedAt:new Date().toISOString(),sourceUrl:VEHICLE_SPEC_SOURCE,records:[],sourceStatus:'unavailable' as const};
    }
  })().finally(()=>{if(pendingSpecs?.promise===promise) pendingSpecs=undefined;});
  pendingSpecs={year,promise};
  return promise;
}

export function normalizeVehiclePrices(payload: Row, regionId: string, type: VehicleType, year: number, specs?: VehicleSpecsDataset): VehicleRecord[] {
  const key = type === 'passenger' ? 'list11' : 'list12';
  const rows = payload[key];
  if (!Array.isArray(rows)) throw new Error('공식 차량별 보조금 목록 형식이 변경되었습니다.');
  if (rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('공식 차량별 보조금 항목이 유효하지 않습니다.');
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  rows.forEach((r: Row) => { const id=text(r.MODEL_CD || r.ORD); if(ids.has(id)) duplicates.add(id);ids.add(id); });
  return rows.map((r: Row) => {
    const id = text(r.MODEL_CD || r.ORD);
    const manufacturer = text(r.MAKER_NM);
    const modelName = text(r.MODEL_NM);
    const sumAmount = r.SUM_GAMT;
    const national = parseVehicleAmount(sumAmount === null || sumAmount === undefined || (typeof sumAmount === 'string' && !sumAmount.trim()) ? r.GAMT : sumAmount);
    const local = parseVehicleAmount(r.LAMT);
    const total = parseVehicleAmount(r.TOTAL_AMT);
    const transitionNational = parseVehicleAmount(r.EXCHANGE_3YEAR_GAMT3);
    const transitionLocal = parseVehicleAmount(r.EXCHANGE_3YEAR_LAMT3);
    const matched = specs?.year === year ? specs.records.filter(s => s.vehicleType===type && normalizeVehicleName(s.manufacturer)===normalizeVehicleName(manufacturer) && normalizeVehicleName(s.modelName)===normalizeVehicleName(modelName)) : [];
    const spec = matched.length === 1 ? matched[0] : undefined;
    const checks: VehicleCheck[] = [
      {id:'model',label:'공식 제조사·모델 코드 확인',passed:!!id && !!manufacturer && !!modelName && !duplicates.has(id)},
      {id:'amounts',label:'공식 국비·지방비 금액 확인',passed:national!==null && local!==null && total!==null},
      {id:'sum',label:'국비·지방비 합계 대조',passed:national!==null && local!==null && total!==null && Math.round(national*10000)+Math.round(local*10000)===Math.round(total*10000)},
      {id:'type',label:'차종·규격 확인',passed:type==='passenger' ? /^RIDE/.test(text(r.TYPE_CD)) : /^TRUCK/.test(text(r.TYPE_CD))},
      {id:'transition',label:'모델별 전환지원금 확인',passed:transitionNational!==null && transitionLocal!==null},
      {id:'spec-freshness',label:'제공된 제원 원문 최신 확인',passed:!spec || !!specs && specs.sourceStatus!=='cached' && specs.sourceStatus!=='unavailable' && Number.isFinite(Date.parse(specs.checkedAt)) && Date.now()-Date.parse(specs.checkedAt)<=24*60*60_000 && Date.parse(specs.checkedAt)<=Date.now()+5*60_000},
    ];
    // The local price endpoint is authoritative for amounts. The target list is
    // independent corroboration only when its exact vehicle variant is present.
    if (spec?.national !== null && spec?.national !== undefined) checks.push({id:'national-crosscheck',label:'차량 지급대상 국비 원문 대조',passed:national!==null && Math.round(spec.national*10000)===Math.round(national*10000)});
    return {id,manufacturer,modelName,vehicleType:type,category:text(r.TYPE_NM),categoryCode:text(r.TYPE_CD),national,local,total,transitionNational,transitionLocal,discontinued:r.USE_YN==='N',specs:{battery:spec?.battery??null,range:spec?.range??null,seats:spec?.seats??null},checks};
  });
}

export async function fetchVehiclePrices(regionId: string, type: VehicleType, year: number): Promise<VehicleDataset> {
  if (!/^\d{4,5}$/.test(regionId) || regionId==='9999') throw new Error('지자체 코드가 유효하지 않습니다.');
  if (type!=='passenger' && type!=='cargo') throw new Error('차종이 유효하지 않습니다.');
  if (!Number.isInteger(year) || year<2020 || year>2100) throw new Error('조회 연도가 유효하지 않습니다.');
  const [payload,specs] = await Promise.all([
    postOfficial(PRICE_ENDPOINT,{year:String(year),local_cd:regionId}),
    fetchVehicleSpecs(year),
  ]);
  const records=normalizeVehiclePrices(payload,regionId,type,year,specs);
  const fingerprintBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({regionId,type,year,records})));
  const fingerprint=[...new Uint8Array(fingerprintBytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const sourceUrl=`${VEHICLE_PRICE_SOURCE}?year1=${year}&local_cd1=${encodeURIComponent(regionId)}`;
  return {regionId,year,checkedAt:new Date().toISOString(),sourceUrl,records,fingerprint};
}
