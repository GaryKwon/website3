import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { BoundedCache } from '../lib/cache';
import { readBoundedText, UpstreamGate, getUpstreamRuntimeState } from '../lib/upstream';
import { getVehicles, getVehicleRuntimeState } from '../lib/vehicles';
import { getSubsidies, getSubsidyRuntimeState } from '../lib/subsidies';
import { fetchVehicleSpecs } from '../lib/vehicle-source';
import { parseOfficialHtml } from '../lib/official-source';
import { regions } from '../lib/regions';

// Only checked-in, previously collected official fixtures are used. No network is sent.
const read=(name:string):any=>JSON.parse(readFileSync(new URL(`../lib/data/${name}`,import.meta.url),'utf8'));
const passenger=read('vehicles-1100-passenger.json');
const cargo=read('vehicles-1100-cargo.json');
const specifications=read('vehicles-specs.json');
const statusPassenger=read('official-passenger.json');
const statusCargo=read('official-cargo.json');
const year=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
let passed=0;
const failures:string[]=[];
async function test(name:string,action:()=>void|Promise<void>) {
  try {await action();passed++;console.log(`PASS ${name}`);}
  catch(error) {failures.push(name);console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);}
}

let clock=1000;
await test('last-known storage evicts the least recently used entry',()=>{
  const cache=new BoundedCache<string,string>(2,1000,100,()=>10,()=>clock);
  cache.set('a','a');cache.set('b','b');assert.equal(cache.get('a'),'a');cache.set('c','c');
  assert.equal(cache.get('b'),undefined);assert.equal(cache.get('a'),'a');assert.equal(cache.size,2);assert.equal(cache.retainedBytes,20);
});
await test('last-known storage expires entries without keeping stale references',()=>{
  const cache=new BoundedCache<string,string>(2,100,100,()=>10,()=>clock);
  cache.set('a','a');clock+=101;
  assert.equal(cache.get('a'),undefined);assert.equal(cache.size,0);assert.equal(cache.retainedBytes,0);
});
await test('last-known storage respects byte limits and rejects oversized entries',()=>{
  const cache=new BoundedCache<string,string>(8,1000,15,value=>value.length,()=>clock);
  cache.set('a','1234567890');cache.set('b','1234567890');
  assert.equal(cache.get('a'),undefined);assert.equal(cache.retainedBytes,10);
  cache.set('huge','x'.repeat(20));assert.equal(cache.get('huge'),undefined);assert.equal(cache.size,1);
  cache.clear();assert.equal(cache.retainedBytes,0);assert.equal(cache.size,0);
});
await test('replacing and deleting cached entries releases their byte accounting',()=>{
  const cache=new BoundedCache<string,string>(8,1000,100,value=>value.length,()=>clock);
  cache.set('a','12345');cache.set('a','12');assert.equal(cache.retainedBytes,2);
  assert(cache.delete('a'));assert(!cache.delete('a'));assert.equal(cache.retainedBytes,0);
});
await test('body size is enforced while reading and an oversized stream is cancelled',async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(20));},cancel(){cancelled=true;}});
  await assert.rejects(()=>readBoundedText(new Response(body),10));assert(cancelled);
});
await test('declared oversized bodies are rejected and cancelled before reading',async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  await assert.rejects(()=>readBoundedText(new Response(body,{headers:{'Content-Length':'1000'}}),10));assert(cancelled);
});
await test('bounded text keeps multibyte Korean characters intact across chunks',async()=>{
  const bytes=new TextEncoder().encode('공식 전기차 보조금');
  const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.slice(0,2));c.enqueue(bytes.slice(2,7));c.enqueue(bytes.slice(7));c.close();}});
  assert.equal(await readBoundedText(new Response(body),100),'공식 전기차 보조금');
});

await test('upstream gate caps active work and rejects queue overflow',async()=>{
  const gate=new UpstreamGate(2,2);let unlock!:()=>void;const blocked=new Promise<void>(resolve=>{unlock=resolve;});
  let maximum=0;
  const action=async()=>{maximum=Math.max(maximum,gate.state.active);await blocked;return 1;};
  const jobs=[gate.run(action),gate.run(action),gate.run(action),gate.run(action)];
  assert.deepEqual(gate.state,{active:2,queued:2});
  await assert.rejects(()=>gate.run(action),error=>error instanceof Error&&error.name==='UpstreamBusyError');
  unlock();assert.deepEqual(await Promise.all(jobs),[1,1,1,1]);assert(maximum<=2);assert.deepEqual(gate.state,{active:0,queued:0});
});
await test('aborted queued requests are removed without running their action',async()=>{
  const gate=new UpstreamGate(1,2);let unlock!:()=>void;const blocked=new Promise<void>(resolve=>{unlock=resolve;});
  const first=gate.run(()=>blocked);const controller=new AbortController();let ran=false;
  const queued=gate.run(async()=>{ran=true;},controller.signal);assert.deepEqual(gate.state,{active:1,queued:1});
  controller.abort();await assert.rejects(()=>queued,error=>error instanceof Error&&error.name==='AbortError');
  assert.equal(ran,false);assert.deepEqual(gate.state,{active:1,queued:0});unlock();await first;assert.deepEqual(gate.state,{active:0,queued:0});
});
await test('upstream gate releases failed jobs and refuses already aborted work',async()=>{
  const gate=new UpstreamGate(1,2);
  await assert.rejects(()=>gate.run(async()=>{throw new Error('test failure');}),/test failure/);
  assert.deepEqual(gate.state,{active:0,queued:0});
  const controller=new AbortController();controller.abort();let ran=false;
  await assert.rejects(()=>gate.run(async()=>{ran=true;},controller.signal));assert.equal(ran,false);
  assert.equal(await gate.run(async()=>42),42);assert.deepEqual(gate.state,{active:0,queued:0});
});

const rawOriginal=new URL('../../research/official.html',import.meta.url);
if(existsSync(rawOriginal)) await test('typed-array decoder preserves all original official rows',()=>{
  const parsed=parseOfficialHtml(readFileSync(rawOriginal,'utf8'));
  assert.equal(parsed.rows.length,statusPassenger.rows.length);
  assert.deepEqual(parsed.rows.map((r:any)=>r.LOCAL_CD).sort(),statusPassenger.rows.map((r:any)=>r.LOCAL_CD).sort());
});

const nativeFetch=globalThis.fetch;
const nativeSetTimeout=globalThis.setTimeout;
const nativeClearTimeout=globalThis.clearTimeout;
const requests:{kind:string;cache?:RequestCache;header:string|null;signal:AbortSignal|null}[]=[];
const activeTimers=new Set<ReturnType<typeof setTimeout>>();
let mode:'ok'|'fail'|'hang'='ok';
let revision=0;
let priceCalls=0,specCalls=0,statusCalls=0;
let accelerateTimeouts=false;

globalThis.setTimeout=((fn:TimerHandler,ms?:number,...args:any[])=>{
  let timer:ReturnType<typeof setTimeout>;
  const delay=accelerateTimeouts && ms===12000 ? 2 : ms;
  timer=nativeSetTimeout(()=>{activeTimers.delete(timer);if(typeof fn==='function') fn(...args);},delay);
  activeTimers.add(timer);return timer;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout=((id:ReturnType<typeof setTimeout>|undefined)=>{if(id!==undefined)activeTimers.delete(id);nativeClearTimeout(id);}) as typeof clearTimeout;

function priceRows(data:any) {
  return data.records.map((r:any,index:number)=>{
    const extra=index===0?revision:0;
    return {MODEL_CD:r.id,MAKER_NM:r.manufacturer,MODEL_NM:r.modelName,TYPE_CD:r.categoryCode,TYPE_NM:r.category,
      SUM_GAMT:r.national===null?null:String(r.national+extra),GAMT:r.national===null?null:String(r.national+extra),LAMT:r.local===null?null:String(r.local),TOTAL_AMT:r.total===null?null:String(r.total+extra),
      EXCHANGE_3YEAR_GAMT3:r.transitionNational,EXCHANGE_3YEAR_LAMT3:r.transitionLocal,USE_YN:r.discontinued?'N':'Y'};
  });
}
function statusHtml(type:string) {
  const data=type==='12'?statusCargo:statusPassenger;
  const blocks:Record<string,unknown>={localListData:data.rows.map((r:any)=>({...r,YEAR:String(year)})),choiceListData:data.choiceRows.map((r:any)=>({...r,CHOICE_CNT:Number(r.CHOICE_CNT)+(r.LOCAL_CD==='1100'?revision:0)})),finishListData:data.finishRows,stepListData:data.stepRows,periodListData:data.periodRows,pageInfo:{...data.pageInfo,year1:String(year),carType:type}};
  return Object.entries(blocks).map(([id,value])=>`<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g,'\\u003c')}</script>`).join('');
}
function waitForAbort(signal:AbortSignal|null|undefined):Promise<never> {
  return new Promise((_,reject)=>{
    if(signal?.aborted) {reject(new DOMException('Aborted','AbortError'));return;}
    signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  });
}
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  const kind=url.pathname.includes('getLocalCarModelPrice')?'price':url.pathname.includes('selectTargetVehicle')?'spec':url.pathname.includes('initSubsidyPayment')?'status':'decoder';
  const headers=new Headers(init?.headers);
  requests.push({kind,cache:init?.cache,header:headers.get('Cache-Control'),signal:init?.signal??null});
  if(kind==='price')priceCalls++;if(kind==='spec')specCalls++;if(kind==='status')statusCalls++;
  await Promise.resolve();
  if(kind==='decoder')return new Response('unavailable',{status:503});
  if(mode==='hang')return waitForAbort(init?.signal);
  if(mode==='fail')throw new Error('Simulated upstream failure');
  if(kind==='price')return Response.json({list11:priceRows(passenger),list12:priceRows(cargo)});
  if(kind==='spec')return Response.json({list:specifications.records.map((r:any)=>({MADE_COMPANY_NM:r.manufacturer,MODEL:r.modelName,CAR_KIND:r.vehicleType==='passenger'?'1C':'2T',BATTERY:r.battery,CHARGER_DISTANCE:r.range,PERSONS:r.seats,SALE_PRICE:r.national}))});
  return new Response(statusHtml(url.searchParams.get('car_type')??'11'),{headers:{'Content-Type':'text/html'}});
}) as typeof fetch;

try {
  await test('sequential loads refetch model prices, specifications and status every time',async()=>{
    const before=[priceCalls,specCalls,statusCalls];
    revision=0;const first=await getVehicles('1100','passenger',year);
    revision=1;const second=await getVehicles('1100','passenger',year);
    assert.equal(first.sourceStatus,'live');assert.equal(second.sourceStatus,'live');
    assert.deepEqual([priceCalls-before[0],specCalls-before[1],statusCalls-before[2]],[2,2,2]);
    assert.equal(second.records[0].total,first.records[0].total!+1);
  });
  await test('price decreases and large changes replace old amounts instead of freezing them',async()=>{
    mode='ok';revision=0;const base=await getVehicles('1100','passenger',year);
    revision=-300;const lower=await getVehicles('1100','passenger',year);
    assert.equal(lower.sourceStatus,'live');assert.equal(lower.records[0].total,base.records[0].total!-300);
    assert.equal(lower.records[0].checks.find(c=>c.id==='change')?.passed,false);
    const confirmed=await getVehicles('1100','passenger',year);
    assert.equal(confirmed.records[0].total,lower.records[0].total);
    assert.equal(confirmed.records[0].checks.find(c=>c.id==='change')?.passed,true);
    revision=1;
  });
  await test('overlapping identical loads share exactly one upstream request set',async()=>{
    const before=[priceCalls,specCalls,statusCalls];
    const [a,b,c]=await Promise.all([getVehicles('4111','passenger',year),getVehicles('4111','passenger',year),getVehicles('4111','passenger',year)]);
    assert.strictEqual(a,b);assert.strictEqual(b,c);
    assert.deepEqual([priceCalls-before[0],specCalls-before[1],statusCalls-before[2]],[1,1,1]);
    assert.equal(getVehicleRuntimeState().pending,0);assert.equal(getSubsidyRuntimeState().pending,0);
  });
  await test('all data requests bypass browser, proxy and edge caches',()=>{
    for(const r of requests.filter(r=>r.kind!=='decoder')) {assert.equal(r.cache,'no-store',r.kind);assert.match(r.header??'',/no-store/);}
  });
  await test('completed requests release every request deadline timer',()=>{
    assert.equal(activeTimers.size,0);
    assert(requests.filter(r=>r.kind!=='decoder').every(r=>r.signal?.aborted));
  });
  await test('failed refresh preserves last successful timestamp and marks previous values',async()=>{
    mode='ok';const live=await getVehicles('2600','passenger',year);const oldTime=live.checkedAt;
    mode='fail';const fallback=await getVehicles('2600','passenger',year);
    assert.equal(fallback.sourceStatus,'cached');assert.equal(fallback.checkedAt,oldTime);
    assert(fallback.records.every(r=>r.checks.some(c=>c.id==='freshness'&&!c.passed)));
    assert.equal(fallback.applicationStatus,'unknown');
    assert.equal(getVehicleRuntimeState().pending,0);assert.equal(getSubsidyRuntimeState().pending,0);assert.equal(activeTimers.size,0);assert.deepEqual(getUpstreamRuntimeState(),{active:0,queued:0});
  });
  await test('a following refresh retries immediately after upstream failure',async()=>{
    const before=priceCalls;mode='ok';const recovered=await getVehicles('2600','passenger',year);
    assert.equal(recovered.sourceStatus,'live');assert.equal(priceCalls-before,1);
  });
  await test('standalone status loads also revalidate sequentially',async()=>{
    const before=statusCalls;await getSubsidies('passenger',year);await getSubsidies('passenger',year);
    assert.equal(statusCalls-before,2);
  });
  await test('remaining vehicle counts reflect a changed official selection immediately',async()=>{
    mode='ok';revision=0;const first=await getSubsidies('passenger',year);
    revision=3;const second=await getSubsidies('passenger',year);
    const a=first.records.find(r=>r.regionId==='1100')!,b=second.records.find(r=>r.regionId==='1100')!;
    assert.equal(b.selected,a.selected!+3);assert.equal(b.available,Math.max(0,a.available!-3));
    revision=1;
  });
  await test('standalone specification loads revalidate sequentially',async()=>{
    const before=specCalls;await fetchVehicleSpecs(year);await fetchVehicleSpecs(year);
    assert.equal(specCalls-before,2);
  });
  await test('upstream timeouts release pending requests and deadline timers',async()=>{
    mode='hang';accelerateTimeouts=true;
    const result=await getVehicles('2600','passenger',year);
    assert.equal(result.sourceStatus,'cached');assert.equal(getVehicleRuntimeState().pending,0);assert.equal(getSubsidyRuntimeState().pending,0);assert.equal(activeTimers.size,0);assert.deepEqual(getUpstreamRuntimeState(),{active:0,queued:0});
    mode='ok';accelerateTimeouts=false;
    assert.equal((await getVehicles('2600','passenger',year)).sourceStatus,'live');
  });
  await test('many region loads retain at most eight vehicle and two status fallbacks',async()=>{
    mode='ok';
    for(const region of regions.filter(r=>!r.children?.length&&!r.id.startsWith('province:')).slice(0,18)) await getVehicles(region.id,'passenger',year);
    const vehicle=getVehicleRuntimeState(),status=getSubsidyRuntimeState();
    assert(vehicle.entries<=8);assert(vehicle.bytes<=12*1024*1024);assert.equal(vehicle.pending,0);
    assert(status.entries<=2);assert(status.bytes<=6*1024*1024);assert.equal(status.pending,0);assert.equal(activeTimers.size,0);
  });
} finally {
  globalThis.fetch=nativeFetch;globalThis.setTimeout=nativeSetTimeout;globalThis.clearTimeout=nativeClearTimeout;
  for(const timer of activeTimers)nativeClearTimeout(timer);
}

console.log(`${passed} passed, ${failures.length} failed`);
if(failures.length)process.exitCode=1;
