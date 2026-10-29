import { fetchVehiclePrices, VEHICLE_PRICE_SOURCE, type VehicleDataset, type VehicleRecord, type VehicleType } from './vehicle-source';
import { vehicleFamily, vehicleConfiguration } from './vehicle-configuration';
import { regions } from './regions';
import { getSubsidies } from './subsidies';
import { BoundedCache } from './cache';
import { readBoundedText } from './upstream';
import { localBenefitInfo } from './local-benefit-source';
import type { LocalBenefitInfo } from './benefit-types';
import seoulPassenger from './data/vehicles-1100-passenger.json';
import seoulCargo from './data/vehicles-1100-cargo.json';
import suwonPassenger from './data/vehicles-4111-passenger.json';
import suwonCargo from './data/vehicles-4111-cargo.json';
import busanPassenger from './data/vehicles-2600-passenger.json';
import busanCargo from './data/vehicles-2600-cargo.json';
import jejuPassenger from './data/vehicles-5000-passenger.json';
import jejuCargo from './data/vehicles-5000-cargo.json';

type EnrichedVehicle = VehicleRecord & {family:string; configuration:ReturnType<typeof vehicleConfiguration>};
export type VehiclesResponse = {
  records:EnrichedVehicle[]; regionId:string; year:number; checkedAt:string|null; sourceUrl:string;
  sourceStatus:'live'|'cached'|'unavailable'; message?:string;
  applicationStatus:'open'|'closed'|'unknown'; statusReason:string|null; remaining:number|null;
  availability:{announced:number|null;received:number|null;selected:number|null;delivered:number|null;selectionRemaining:number|null;deliveryRemaining:number|null;checkedAt:string;checks:{id:string;label:string;passed:boolean}[]}|null;
  statusSourceStatus:'live'|'cached'|'unavailable'; statusCheckedAt:string|null;
  localBenefits?:LocalBenefitInfo;
};
type VehicleBaseline={records:Pick<VehicleRecord,'id'|'national'|'local'|'total'>[]};
type Entry={dataset:VehicleDataset;baseline?:VehicleBaseline};
const MAX_AGE=30*60_000;
const memory=new BoundedCache<string,Entry>(8,30*60_000,12*1024*1024);
const pending=new Map<string,Promise<VehiclesResponse>>();
const snapshots=[seoulPassenger,seoulCargo,suwonPassenger,suwonCargo,busanPassenger,busanCargo,jejuPassenger,jejuCargo] as unknown as VehicleDataset[];

const runtimeCache=()=> (globalThis as unknown as {caches?:{default?:Cache}}).caches?.default;
const cacheKey=(id:string,type:VehicleType,year:number)=>new Request(`https://ev-subsidy-finder.kwongary1129.chatgpt.site/__model-price-fallback-v3/${year}/${id}/${type}`);

export function enrichVehicleDataset(dataset:VehicleDataset,sourceStatus:'live'|'cached',now=Date.now(),previous?:VehicleBaseline):EnrichedVehicle[] {
  const timestamp=Date.parse(dataset.checkedAt);
  const fresh=sourceStatus==='live' && Number.isFinite(timestamp) && now-timestamp<=MAX_AGE && timestamp<=now+5*60_000;
  return dataset.records.map(record=>{
    const old=previous?.records.find(r=>r.id===record.id);
    const sudden = !!old && (['total','national','local'] as const).some(field=>{
      const before=old[field],after=record[field];
      return before!==null && after!==null && Math.abs(after-before)/Math.max(1,before)>0.5;
    });
    return {...record,family:vehicleFamily(record.modelName),configuration:vehicleConfiguration(record.modelName),checks:[...record.checks,
      {id:'freshness',label:'30분 이내 금액 원문 확인',passed:fresh},
      {id:'change',label:'이전 조회 대비 금액 급변 확인',passed:!sudden},
    ]};
  });
}

async function getPrices(id:string,type:VehicleType,year:number):Promise<Omit<VehiclesResponse,'applicationStatus'|'statusReason'|'remaining'|'availability'|'statusSourceStatus'|'statusCheckedAt'>> {
  const key=`${year}:${id}:${type}`;
  let entry=memory.get(key);
  if (!entry) {
    try {
      const response=await runtimeCache()?.match(cacheKey(id,type,year));
      if(response) {
        const cached=JSON.parse(await readBoundedText(response,8*1024*1024)) as Entry;
        if(cached.dataset?.regionId===id && cached.dataset.year===year && Array.isArray(cached.dataset.records) && cached.dataset.records.every(r=>r.vehicleType===type)) entry=cached;
      }
    } catch { /* Continue without a distributed cache. */ }
    if(!entry) {
      const initial=snapshots.find(s=>s.regionId===id && s.year===year && s.records[0]?.vehicleType===type);
      if(initial) entry={dataset:initial};
    }
  }
  const render=(e:Entry,sourceStatus:'live'|'cached')=>({regionId:id,year,checkedAt:e.dataset.checkedAt,sourceUrl:e.dataset.sourceUrl,sourceStatus,records:enrichVehicleDataset(e.dataset,sourceStatus,Date.now(),e.baseline),...(sourceStatus==='cached'?{message:'공식 연결 지연 · 마지막 확인 금액'}:{})});
  try {
    const dataset=await fetchVehiclePrices(id,type,year);
    if(dataset.regionId!==id || dataset.year!==year || dataset.records.some(r=>r.vehicleType!==type)) throw new Error('Mismatched response');
    if(entry && dataset.records.length<entry.dataset.records.length*0.8) throw new Error('Incomplete model list');
    const baseline=entry?{records:entry.dataset.records.map(({id,national,local,total})=>({id,national,local,total}))}:undefined;
    const next:Entry={dataset,baseline};
    memory.set(key,next);
    try {
      await runtimeCache()?.put(cacheKey(id,type,year),new Response(JSON.stringify(next),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=86400'}}));
    } catch { /* The live response remains usable. */ }
    return render(next,'live');
  } catch (error) {
    console.warn('Official vehicle price refresh failed', error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown upstream failure');
    if(entry) {memory.set(key,entry);return render(entry,'cached');}
    return {regionId:id,year,checkedAt:null,sourceUrl:VEHICLE_PRICE_SOURCE,sourceStatus:'unavailable',records:[],message:'공식 차량별 보조금을 불러올 수 없어요'};
  }
}

async function load(id:string,type:VehicleType,year:number):Promise<VehiclesResponse> {
  const [prices,status]=await Promise.all([getPrices(id,type,year),getSubsidies(type,year)]);
  const local=status.sourceStatus==='live'?status.records.find(r=>r.regionId===id):undefined;
  return {...prices,applicationStatus:local?.status??'unknown',statusReason:local?.statusReason??null,remaining:local?.available??null,
    availability:local?{announced:local.announced,received:local.received,selected:local.selected,delivered:local.delivered,selectionRemaining:local.available,deliveryRemaining:local.remaining,checkedAt:local.checkedAt,checks:local.checks}:null,
    statusSourceStatus:status.sourceStatus,statusCheckedAt:status.checkedAt,
    localBenefits:localBenefitInfo(local,{regionId:id,vehicleType:type,year,sourceStatus:status.sourceStatus,checkedAt:status.checkedAt}),
  };
}

export function getVehicles(id:string,type:VehicleType,year:number):Promise<VehiclesResponse> {
  if(!regions.some(r=>r.id===id && !r.children?.length)) throw new Error('지원 지자체를 선택해 주세요.');
  const key=`${year}:${id}:${type}`;
  const running=pending.get(key);
  if(running) return running;
  if(pending.size>=24) return Promise.resolve({records:[],regionId:id,year,checkedAt:null,sourceUrl:VEHICLE_PRICE_SOURCE,sourceStatus:'unavailable',message:'조회가 몰리고 있어요. 잠시 후 자동으로 다시 확인합니다.',applicationStatus:'unknown',statusReason:null,remaining:null,availability:null,statusSourceStatus:'unavailable',statusCheckedAt:null});
  const promise=load(id,type,year).finally(()=>pending.delete(key));
  pending.set(key,promise);
  return promise;
}

/** Read-only counters for operational and regression checks; no retained response data is exposed. */
export const getVehicleRuntimeState=()=>({entries:memory.size,bytes:memory.retainedBytes,pending:pending.size});
