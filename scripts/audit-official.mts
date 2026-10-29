import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { regions } from '../lib/regions';
import { fetchOfficialData } from '../lib/official-source';
import { normalizeDataset } from '../lib/subsidies';
import { normalizeVehiclePrices, fetchVehicleSpecs, type VehicleSpecsDataset } from '../lib/vehicle-source';
import { readBoundedText } from '../lib/upstream';

type Raw=Record<string,unknown>;
const origin='https://ev.or.kr/nportal/buySupprt/';
const year=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
const output=new URL('../../../outputs/verification-data.json',import.meta.url);
const rawDirectory=new URL('../../research/audit/',import.meta.url);
const startedAt=new Date().toISOString();
const authorities=regions.filter(r=>!r.children?.length&&!r.id.startsWith('province:')&&r.id!=='9999');
const errors:{stage:string;regionId?:string;message:string}[]=[];
const mismatches:Raw[]=[];
let mismatchCount=0;
const arithmetic:Raw[]=[];
let arithmeticCount=0;
const cross=new Map<string,{manufacturer:string;modelName:string;vehicleType:string;priceNational:number;targetNational:number;regions:string[]}>();
const regionResults:Raw[]=[];
const statusResults:Raw[]=[];
let numericFields=0,modelRows=0,specMatched=0,specMissing=0,specFields=0,completed=0;
let liveSpecs:VehicleSpecsDataset|undefined;
const plain=(v:unknown)=>String(v??'').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').trim().slice(0,1200);
const optional=(v:unknown)=>{const p=plain(v);return p&&p!=='-'&&p!=='null'?p:null;};
const key=(v:unknown)=>plain(v).normalize('NFKC').replace(/\s+/g,'').toLowerCase();
function number(v:unknown):number|null {
  if(typeof v!=='string'&&typeof v!=='number')return null;
  const s=String(v).trim().replace(/만원$/,'').trim();
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/.test(s))return null;
  const n=Number(s.replace(/,/g,''));return Number.isFinite(n)&&n>=0&&n<=1000000?n:null;
}
function parts(v:unknown):(number|null)[] {
  return String(v??'').split(/<br\s*\/?\s*>/i).map(s=>{
    const raw=s.replace(/<[^>]*>/g,'').replace(/[()\s,]/g,'');
    return /^[-+]?\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):null;
  });
}
function compare(context:Raw,field:string,actual:unknown,expected:unknown) {
  if((typeof actual==='number'&&typeof expected==='number'&&Math.abs(actual-expected)<0.000001)||actual===expected)return;
  mismatchCount++;if(mismatches.length<500)mismatches.push({...context,field,actual,expected});
}
async function post(endpoint:string,params:Record<string,string>):Promise<Raw> {
  let last:unknown;
  for(let attempt=0;attempt<2;attempt++) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
    try {
      const r=await fetch(origin+endpoint,{method:'POST',cache:'no-store',redirect:'manual',signal:controller.signal,headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',Accept:'application/json','Cache-Control':'no-store, no-cache, max-age=0',Pragma:'no-cache',Referer:origin+'initPsLocalCarPirceAction.do'},body:new URLSearchParams(params).toString()});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const raw=await readBoundedText(r,2_000_000);const parsed:unknown=JSON.parse(raw);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Response object missing');
      return parsed as Raw;
    } catch(e){last=e;}finally{clearTimeout(timer);controller.abort();}
  }
  throw last;
}
function saveError(stage:string,e:unknown,regionId?:string) {errors.push({stage,regionId,message:e instanceof Error?`${e.name}: ${e.message}`:String(e)});}
function result(done:boolean) {
  const crossEntries=[...cross.values()];
  return {title:'전국 공식 전기차 보조금 데이터 대조',year,startedAt,checkedAt:new Date().toISOString(),complete:done,
    scope:{authorities:authorities.length,vehicleTypes:['passenger','cargo'],amountUnit:'만원',priceFields:['national','local','total','transitionNational','transitionLocal'],statusFields:['announced','received','selected','delivered','remaining','available'],method:'지역별 공식 원본과 애플리케이션 변환값을 전수 대조. 제원은 제조사·정확 모델명 일치 시만 대조. 원문 자체의 오류·행정 지연·개인 자격은 보증하지 않음.'},
    sourceUrls:[origin+'initPsLocalCarPirceAction.do',origin+'getLocalCarModelPrice.ajax',origin+'initSubsidyTargetVehicleAction.do',origin+'selectTargetVehicle.ajax',origin+'initSubsidyPaymentCheckAction.do'],
    summary:{regionsCompleted:completed,regionsSuccessful:regionResults.filter(r=>r.ok).length,modelRows,numericPriceFieldsCompared:numericFields,specMatchedRows:specMatched,specUnavailableRows:specMissing,specFieldsCompared:specFields,applicationDataMismatches:mismatchCount,officialArithmeticDiscrepancies:arithmeticCount,sourceNationalDisagreements:crossEntries.length,errors:errors.length},
    specifications:{sourceStatus:liveSpecs?.sourceStatus??'unavailable',checkedAt:liveSpecs?.checkedAt??null,records:liveSpecs?.records.length??0},
    statusResults,regions:regionResults,mismatches,mismatchesTruncated:mismatchCount>mismatches.length,officialArithmeticDiscrepancies:arithmetic,sourceNationalDisagreements:crossEntries,errors};
}
async function persist(done:boolean) {await writeFile(output,JSON.stringify(result(done),null,2)+'\n');}
await mkdir(new URL('.',output),{recursive:true});await mkdir(rawDirectory,{recursive:true});
console.log(`Audit started: ${authorities.length} authorities; concurrency 2; request timeout 12s; one retry.`);

try {
  const raw=await post('selectTargetVehicle.ajax',{spageId:'subsidyTargetVehicle',spageNo:'1',srecordCountPerPage:'99999',spageSize:'10',carType:'',schCompany:'ALL',schModel:'ALL'});
  if(!Array.isArray(raw.list))throw new Error('Specification list missing');
  await writeFile(new URL('specifications.json',rawDirectory),JSON.stringify(raw));
  const parsed=(raw.list as Raw[]).filter(r=>r.CAR_KIND==='1C'||r.CAR_KIND==='2T');
  liveSpecs=await fetchVehicleSpecs(year);
  if(liveSpecs.sourceStatus!=='live')throw new Error('Application specification fetch used a fallback');
  compare({stage:'specification-count'},'count',liveSpecs.records.length,parsed.length);
  for(const item of liveSpecs.records) {
    const matches=parsed.filter(r=>(r.CAR_KIND==='1C'?'passenger':'cargo')===item.vehicleType&&key(r.MADE_COMPANY_NM)===key(item.manufacturer)&&key(r.MODEL)===key(item.modelName));
    if(matches.length!==1) {compare({stage:'specification',modelName:item.modelName},'unique exact source',matches.length,1);continue;}
    const r=matches[0];
    compare({stage:'specification',modelName:item.modelName},'battery',item.battery,optional(r.BATTERY));
    compare({stage:'specification',modelName:item.modelName},'range',item.range,optional(r.CHARGER_DISTANCE));
    compare({stage:'specification',modelName:item.modelName},'seats',item.seats,optional(r.PERSONS));
    compare({stage:'specification',modelName:item.modelName},'national',item.national,number(r.SALE_PRICE));
  }
} catch(e){saveError('specifications',e);liveSpecs=undefined;}

for(const type of ['passenger','cargo'] as const) {
  try {
    const source=await fetchOfficialData(type,year);const records=normalizeDataset(source,type,year);
    await writeFile(new URL(`status-${type}.json`,rawDirectory),JSON.stringify(source));
    let fieldCount=0;
    for(const r of records) {
      const raw=source.rows.find(row=>String(row.LOCAL_CD)===r.regionId)!;
      const a=parts(raw.TCNT_1),d=parts(raw.RELEACNT_1),remain=parts(raw.RESICNT_1);
      const choices=source.choiceRows.filter(row=>String(row.LOCAL_CD)===r.regionId);
      const choice=choices.find(c=>c.NM===raw.NM)??choices.find(c=>c.NM==='전체');
      const selected=choice?number(choice.CHOICE_CNT):null;
      const expected:Record<string,unknown>={announced:a[0],received:parts(raw.RECEICNT_1)[0],delivered:d[0],remaining:remain[0],selected,available:a[0]!==null&&selected!==null?Math.max(0,a[0]-selected):null};
      const context={stage:'status',regionId:r.regionId,vehicleType:type};
      compare(context,'region name',r.region,plain(raw.LOCAL_NM));
      for(const [field,value]of Object.entries(expected)){compare(context,field,r[field as keyof typeof r],value);fieldCount++;}
      const selectedParts=choice?[selected,number(choice.CHOICE_PRI),number(type==='cargo'?choice.CHOICE_TAXI:choice.CHOICE_BUSI),number(type==='cargo'?choice.CHOICE_HDRY:choice.CHOICE_TAXI),number(choice.CHOICE_COM)]:[];
      const selectionRemains=a.map((goal,i)=>goal!==null&&selectedParts[i]!==null&&selectedParts[i]!==undefined?goal-selectedParts[i]!:null);
      const overflow=selectionRemains.slice(1,-1).reduce<number>((sum,v)=>sum+(v!==null&&v<0?-v:0),0);
      if(selectionRemains.length===5&&selectionRemains[4]!==null)selectionRemains[4]!-=overflow;
      r.categories.forEach((category,i)=>{
        compare({...context,category:category.name},'announced',category.announced,a[i]??null);
        compare({...context,category:category.name},'selected',category.selected,selectedParts[i]??null);
        compare({...context,category:category.name},'available',category.available,selectionRemains[i]!==null&&selectionRemains[i]!==undefined?Math.max(0,selectionRemains[i]!):null);
        compare({...context,category:category.name},'remaining',category.remaining,remain[i]??null);
      });
    }
    compare({stage:'status-count',vehicleType:type},'authorities',records.length,source.rows.filter(r=>String(r.LOCAL_CD)!=='9999').length);
    statusResults.push({vehicleType:type,ok:true,checkedAt:source.checkedAt,rawRows:source.rows.length,authorities:records.length,numericFieldsCompared:fieldCount,fingerprint:source.fingerprint});
  } catch(e){saveError('status-'+type,e);statusResults.push({vehicleType:type,ok:false});}
}

let next=0;
async function auditRegion() {
  while(next<authorities.length) {
    const authority=authorities[next++];const regionId=authority.id;
    try {
      const payload=await post('getLocalCarModelPrice.ajax',{year:String(year),local_cd:regionId});
      const rawText=JSON.stringify(payload);await writeFile(new URL(`${regionId}.json`,rawDirectory),rawText);
      const counts:Record<string,number>={};const before=mismatchCount;
      for(const type of ['passenger','cargo'] as const) {
        const list=payload[type==='passenger'?'list11':'list12'];
        if(!Array.isArray(list))throw new Error(`Missing ${type} price list`);
        const records=normalizeVehiclePrices(payload,regionId,type,year,liveSpecs);
        counts[type]=list.length;modelRows+=list.length;
        compare({regionId,vehicleType:type},'row count',records.length,list.length);
        for(let index=0;index<list.length;index++) {
          const raw=list[index] as Raw;const record=records[index];const context={regionId,vehicleType:type,modelId:record.id,modelName:record.modelName};
          compare(context,'model ID',record.id,plain(raw.MODEL_CD||raw.ORD));compare(context,'manufacturer',record.manufacturer,plain(raw.MAKER_NM));compare(context,'model name',record.modelName,plain(raw.MODEL_NM));
          compare(context,'discontinued',record.discontinued,raw.USE_YN==='N');
          const nationalSource=raw.SUM_GAMT===null||raw.SUM_GAMT===undefined||typeof raw.SUM_GAMT==='string'&&!raw.SUM_GAMT.trim()?raw.GAMT:raw.SUM_GAMT;
          const expected={national:number(nationalSource),local:number(raw.LAMT),total:number(raw.TOTAL_AMT),transitionNational:number(raw.EXCHANGE_3YEAR_GAMT3),transitionLocal:number(raw.EXCHANGE_3YEAR_LAMT3)};
          for(const [field,value]of Object.entries(expected)){compare(context,field,record[field as keyof typeof expected],value);numericFields++;}
          if(expected.national!==null&&expected.local!==null&&expected.total!==null&&Math.abs(expected.national+expected.local-expected.total)>=0.005){arithmeticCount++;if(arithmetic.length<500)arithmetic.push({...context,...expected});}
          const matched=liveSpecs?.records.filter(s=>s.vehicleType===type&&key(s.manufacturer)===key(raw.MAKER_NM)&&key(s.modelName)===key(raw.MODEL_NM))??[];
          if(matched.length===1) {
            specMatched++;const spec=matched[0];
            for(const field of ['battery','range','seats'] as const){compare(context,'specification '+field,record.specs[field],spec[field]);specFields++;}
            if(spec.national!==null&&expected.national!==null&&Math.abs(spec.national-expected.national)>=0.005){
              const crossKey=JSON.stringify([type,record.manufacturer,record.modelName,spec.national,expected.national]);
              const item=cross.get(crossKey)??{manufacturer:record.manufacturer,modelName:record.modelName,vehicleType:type,priceNational:expected.national,targetNational:spec.national,regions:[]};item.regions.push(regionId);cross.set(crossKey,item);
              compare(context,'national discrepancy warning',record.checks.find(c=>c.id==='national-crosscheck')?.passed,false);
            }
          } else {specMissing++;compare(context,'unmatched specification',JSON.stringify(record.specs),JSON.stringify({battery:null,range:null,seats:null}));}
        }
      }
      regionResults.push({regionId,region:authority.name,province:authority.province,ok:true,checkedAt:new Date().toISOString(),rows:counts,applicationDataMismatches:mismatchCount-before,sha256:createHash('sha256').update(rawText).digest('hex')});
    } catch(e){saveError('regional-prices',e,regionId);regionResults.push({regionId,region:authority.name,ok:false});}
    completed++;
    if(completed%10===0||completed===authorities.length){await persist(false);console.log(`Progress ${completed}/${authorities.length}; model rows ${modelRows}; app mismatches ${mismatchCount}; errors ${errors.length}.`);}
  }
}
await Promise.all([auditRegion(),auditRegion()]);
regionResults.sort((a,b)=>String(a.regionId).localeCompare(String(b.regionId)));
await persist(true);
console.log(JSON.stringify({output:fileURLToPath(output),...result(true).summary}));
if(errors.length||mismatchCount)process.exitCode=1;
