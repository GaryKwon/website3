import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoundedCache } from '../lib/cache';
import { UpstreamGate, getUpstreamRuntimeState } from '../lib/upstream';
import { getVehicleRuntimeState } from '../lib/vehicles';
import { getSubsidyRuntimeState } from '../lib/subsidies';
import type { VehicleDataset, VehicleRecord } from '../lib/vehicle-source';
import type { OfficialDataset } from '../lib/official-source';

type VehicleEntry={dataset:VehicleDataset;baseline?:{records:Pick<VehicleRecord,'id'|'national'|'local'|'total'>[]}};
type OfficialEntry={dataset:OfficialDataset;baseline?:{rows:Record<string,unknown>[]}};
const source=(name:string)=>readFileSync(new URL(`../lib/data/${name}`,import.meta.url),'utf8');
const vehicleSources=['1100','4111','2600','5000'].flatMap(region=>['passenger','cargo'].map(type=>source(`vehicles-${region}-${type}.json`)));
const officialSources=[source('official-passenger.json'),source('official-cargo.json')];
const vehicleCache=new BoundedCache<string,VehicleEntry>(8,30*60_000,12*1024*1024);
const officialCache=new BoundedCache<string,OfficialEntry>(2,30*60_000,6*1024*1024);
const limit=8*1024*1024;
const iterations=1000;
let assertions=0;
const check=(test:()=>void)=>{test();assertions++;};
const clock=process.hrtime.bigint();
const timers=new Set<ReturnType<typeof setTimeout>>();
const originalSetTimeout=globalThis.setTimeout;
const originalClearTimeout=globalThis.clearTimeout;
let peakTimers=0;
globalThis.setTimeout=((callback:TimerHandler,ms?:number,...args:unknown[])=>{
  let handle:ReturnType<typeof setTimeout>;
  handle=originalSetTimeout((...values:unknown[])=>{timers.delete(handle);if(typeof callback==='function')callback(...values);},ms,...args);
  timers.add(handle);peakTimers=Math.max(peakTimers,timers.size);return handle;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout=((handle:ReturnType<typeof setTimeout>)=>{timers.delete(handle);return originalClearTimeout(handle);}) as typeof clearTimeout;

function replaceBatch(start:number,count:number) {
  for(let i=start;i<start+count;i++) {
    const key=`region-${Math.floor(i/2)%160}`;
    const prior=vehicleCache.get(key);
    const dataset=JSON.parse(vehicleSources[i%vehicleSources.length]) as VehicleDataset;
    const baseline=prior?{records:prior.dataset.records.map(({id,national,local,total})=>({id,national,local,total}))}:undefined;
    vehicleCache.set(key,{dataset,baseline});
    const type=String(i%2);
    const previous=officialCache.get(type);
    const official=JSON.parse(officialSources[i%2]) as OfficialDataset;
    const numericBaseline=previous?{rows:previous.dataset.rows.map(({LOCAL_CD,TCNT_1})=>({LOCAL_CD,TCNT_1}))}:undefined;
    officialCache.set(type,{dataset:official,baseline:numericBaseline});
    check(()=>assert(vehicleCache.size<=8 && officialCache.size<=2));
    check(()=>assert(vehicleCache.retainedBytes<=12*1024*1024 && officialCache.retainedBytes<=6*1024*1024));
  }
}
const gc=async()=>{
  assert.equal(typeof globalThis.gc,'function','Run with node --expose-gc --import tsx scripts/test-memory.mts');
  globalThis.gc!();await new Promise<void>(resolve=>setImmediate(resolve));globalThis.gc!();
};
const observedSignals:{attached:()=>number;signal:AbortSignal;abort:()=>void}[]=[];
function trackedSignal() {
  const controller=new AbortController();
  const signal=controller.signal;
  const listeners=new Set<EventListenerOrEventListenerObject>();
  const add=signal.addEventListener;
  const remove=signal.removeEventListener;
  Object.defineProperty(signal,'addEventListener',{value:function(...args:Parameters<typeof add>){if(args[0]==='abort'&&args[1])listeners.add(args[1]);return Reflect.apply(add,signal,args);}});
  Object.defineProperty(signal,'removeEventListener',{value:function(...args:Parameters<typeof remove>){if(args[0]==='abort'&&args[1])listeners.delete(args[1]);return Reflect.apply(remove,signal,args);}});
  const tracked={signal,attached:()=>listeners.size,abort:()=>controller.abort()};observedSignals.push(tracked);return tracked;
}
const gate=new UpstreamGate(2,16);
let peakActive=0,peakQueued=0;
function sampleGate(){const state=gate.state;peakActive=Math.max(peakActive,state.active);peakQueued=Math.max(peakQueued,state.queued);return state;}
let activeResolvers:(()=>void)[]=[];
const held=()=>new Promise<void>(resolve=>activeResolvers.push(resolve));

try {
  replaceBatch(0,100);
  await gc();
  const before=process.memoryUsage();
  replaceBatch(100,iterations);
  await gc();
  const after=process.memoryUsage();
  const delta=after.heapUsed-before.heapUsed;
  check(()=>assert(delta<=limit,`Retained heap growth ${delta} exceeds ${limit}`));

  const active=[gate.run(held),gate.run(held)];
  await Promise.resolve();
  check(()=>assert.deepEqual(sampleGate(),{active:2,queued:0}));
  const signals=Array.from({length:16},trackedSignal);
  const queued=signals.map(tracked=>gate.run(held,tracked.signal).then(()=>false,error=>error instanceof DOMException&&error.name==='AbortError'));
  check(()=>assert.deepEqual(sampleGate(),{active:2,queued:16}));
  await assert.rejects(gate.run(async()=>{}),{name:'UpstreamBusyError'});assertions++;
  signals.forEach(tracked=>tracked.abort());
  check(()=>assert.deepEqual(sampleGate(),{active:2,queued:0}));
  check(()=>assert(signals.every(tracked=>tracked.attached()===0)));
  assert((await Promise.all(queued)).every(Boolean));assertions++;
  activeResolvers.splice(0).forEach(resolve=>resolve());await Promise.all(active);
  check(()=>assert.deepEqual(sampleGate(),{active:0,queued:0}));

  // Successful queued hand-off removes its abort listener as well.
  const heldAgain=[gate.run(held),gate.run(held)];await Promise.resolve();
  const completing=trackedSignal();const handoff=gate.run(async()=>{},completing.signal);
  check(()=>assert.equal(completing.attached(),1));
  activeResolvers.shift()!();await handoff;
  check(()=>assert.equal(completing.attached(),0));
  activeResolvers.splice(0).forEach(resolve=>resolve());await Promise.all(heldAgain);
  check(()=>assert.deepEqual(sampleGate(),{active:0,queued:0}));
  check(()=>assert.equal(timers.size,0));
  check(()=>assert.equal(getVehicleRuntimeState().pending,0));
  check(()=>assert.equal(getSubsidyRuntimeState().pending,0));
  check(()=>assert.deepEqual(getUpstreamRuntimeState(),{active:0,queued:0}));

  const retained={vehicleEntries:vehicleCache.size,vehicleJsonBytes:vehicleCache.retainedBytes,officialEntries:officialCache.size,officialJsonBytes:officialCache.retainedBytes};
  vehicleCache.clear();officialCache.clear();await gc();
  const afterClear=process.memoryUsage();
  check(()=>assert.equal(vehicleCache.size+officialCache.size,0));
  check(()=>assert(observedSignals.every(tracked=>tracked.attached()===0)));
  const report={
    environment:{runtime:process.version,execArgv:process.execArgv,platform:process.platform,architecture:process.arch,exposedGc:true,scope:'Local Node.js process; this is not a measurement of a production Cloudflare Worker isolate.'},
    workload:{fixture:'Actual checked-in official datasets from four cities, two vehicle types, and national passenger/cargo status.',warmupReplacements:100,measuredReplacements:iterations,simulatedRegionKeys:160,fetches:0},
    limits:{vehicleEntries:8,vehicleJsonBytes:12*1024*1024,officialEntries:2,officialJsonBytes:6*1024*1024,heapGrowthAllowedBytes:limit,upstreamActive:2,upstreamQueued:16},
    heap:{beforeBytes:before.heapUsed,afterBytes:after.heapUsed,retainedGrowthBytes:delta,afterCacheClearBytes:afterClear.heapUsed,rssBeforeBytes:before.rss,rssAfterBytes:after.rss,rssGrowthBytes:after.rss-before.rss,rssAfterCacheClearBytes:afterClear.rss},
    retained,
    cleanup:{afterClearEntries:vehicleCache.size+officialCache.size,activeTimers:timers.size,peakTestTimers:peakTimers,attachedAbortListeners:observedSignals.reduce((sum,tracked)=>sum+tracked.attached(),0),vehiclePending:getVehicleRuntimeState().pending,subsidyPending:getSubsidyRuntimeState().pending,upstream:gate.state,globalUpstream:getUpstreamRuntimeState()},
    gate:{peakActive,peakQueued,overflowRejected:true,abortedQueueRemoved:true,successfulQueueListenerRemoved:true},
    elapsedMs:Number(process.hrtime.bigint()-clock)/1e6,assertions,result:'passed',
  };
  const reportPath=fileURLToPath(new URL('../../../outputs/memory-verification.json',import.meta.url));
  mkdirSync(dirname(reportPath),{recursive:true});writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(`PASS ${iterations} real-data replacements; retained heap delta ${delta} bytes; gate ${peakActive}/${peakQueued}; zero pending, timers, and listeners`);
  console.log(`REPORT ${reportPath}`);
} finally {
  globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
}
