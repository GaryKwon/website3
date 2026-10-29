import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVehicleAmount, normalizeVehiclePrices, normalizeVehicleName, type VehicleDataset, type VehicleRecord, type VehicleSpecsDataset } from '../lib/vehicle-source';
import { vehicleFamily, vehicleConfiguration, amountWithTransition } from '../lib/vehicle-configuration';
import { enrichVehicleDataset } from '../lib/vehicles';

const fixture = (region: string, type: 'passenger'|'cargo'): VehicleDataset => JSON.parse(readFileSync(new URL(`../lib/data/vehicles-${region}-${type}.json`,import.meta.url),'utf8'));
let passed=0;
const failures:string[]=[];
function test(name:string,action:()=>void) {
  try { action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
const baseRow = () => ({MODEL_CD:'EXACT_ID',ORD:1,MAKER_NM:'현대자동차',MODEL_NM:'코나 일렉트릭 2WD 롱레인지 17인치',TYPE_CD:'RIDE',TYPE_NM:'일반승용',GAMT:'380',SUM_GAMT:'400',LAMT:'120',TOTAL_AMT:'520',EXCHANGE_3YEAR_GAMT3:'80',EXCHANGE_3YEAR_LAMT3:'24',USE_YN:'Y'});
const parse = (row:Record<string,unknown>,specs?:VehicleSpecsDataset) => normalizeVehiclePrices({list11:[row]},'1100','passenger',2026,specs)[0];
const byId = (r:VehicleRecord,id:string) => r.checks.find(c=>c.id===id);
const specFixture = ():VehicleSpecsDataset => ({year:2026,checkedAt:new Date().toISOString(),sourceUrl:'https://ev.or.kr/nportal/buySupprt/initSubsidyTargetVehicleAction.do',records:[{manufacturer:'현대자동차',modelName:'코나 일렉트릭 2WD 롱레인지 17인치',vehicleType:'passenger',battery:'리튬이온(64kWh)',range:'400km',seats:'5인승',national:400}]});

test('published amounts retain ten-thousand-won units',()=> {
  assert.equal(parseVehicleAmount('1,234'),1234);assert.equal(parseVehicleAmount('123.45만원'),123.45);assert.equal(parseVehicleAmount(0),0);
  assert.equal(parseVehicleAmount('0'),0);assert.equal(parseVehicleAmount('1000000'),1000000);
});
test('missing and invalid amounts never become zero',()=> {
  for(const value of [null,undefined,'',' ','-','미확인',false,true,[],{},'-1','100원',Infinity,NaN,'9007199254740992']) assert.equal(parseVehicleAmount(value),null, String(value));
});
for(const region of ['1100','4111','2600','5000']) for(const type of ['passenger','cargo'] as const) {
  test(`${region} ${type}: actual official snapshot has unique model IDs and consistent amounts`,()=> {
    const data=fixture(region,type);
    assert.equal(data.regionId,region);assert.equal(data.year,2026);assert.match(data.sourceUrl,/^https:\/\/ev\.or\.kr\/nportal\/buySupprt\/initPsLocalCarPirceAction\.do/);
    assert.equal(data.records.length,type==='cargo'?50:region==='5000'?134:135);
    assert.equal(new Set(data.records.map(r=>r.id)).size,data.records.length);
    for(const r of data.records) {
      assert.equal(r.vehicleType,type);assert(r.modelName&&r.manufacturer&&r.id);
      for(const n of [r.national,r.local,r.total,r.transitionNational,r.transitionLocal]) assert(n===null || Number.isFinite(n)&&n>=0);
      if(r.national!==null&&r.local!==null&&r.total!==null) assert(Math.abs(r.national+r.local-r.total)<0.005,r.id);
      const base=amountWithTransition(r,false);const extra=amountWithTransition(r,true);
      assert.equal(base.total,r.total,r.id);
      if(r.total!==null&&r.transitionNational!==null&&r.transitionLocal!==null) assert(Math.abs(extra.total!-(r.total+r.transitionNational+r.transitionLocal))<0.005,r.id);
    }
  });
}
test('actual Seoul MINI Aceman E base and transition are counted once',()=> {
  const r=fixture('1100','passenger').records.find(r=>r.id==='ACE_E')!;
  assert.deepEqual([r.national,r.local,r.total,r.transitionNational,r.transitionLocal],[400,120,520,80,24]);
  assert.deepEqual(amountWithTransition(r,true),{national:480,local:144,total:624,transition:104});
});
test('SUM_GAMT is authoritative and not added to GAMT',()=> {
  const r=parse(baseRow());assert.equal(r.national,400);assert.equal(r.total,520);assert.equal(byId(r,'sum')?.passed,true);
});
test('missing base or transition fields stay unknown',()=> {
  for(const field of ['SUM_GAMT','GAMT','LAMT','TOTAL_AMT','EXCHANGE_3YEAR_GAMT3','EXCHANGE_3YEAR_LAMT3']) {
    const row:Record<string,unknown>=baseRow(); row[field]=null;
    if(field==='SUM_GAMT') row.GAMT=null;
    if(field==='GAMT') row.SUM_GAMT=null;
    const r=parse(row);
    if(field.startsWith('EXCHANGE')) {assert.equal(amountWithTransition(r,false).total,520);assert.equal(amountWithTransition(r,true).total,null);}
    else assert.equal(amountWithTransition(r,false).total,null);
  }
});
test('inconsistent subtotal cannot produce an estimated total',()=> {
  const r=parse({...baseRow(),TOTAL_AMT:'521'});
  assert.equal(byId(r,'sum')?.passed,false);assert.equal(amountWithTransition(r,false).total,null);assert.equal(amountWithTransition(r,true).total,null);
});
test('specification join requires exact variant and manufacturer',()=> {
  const exact=parse(baseRow(),specFixture());assert.equal(exact.specs.battery,'리튬이온(64kWh)');
  for(const changed of [{MODEL_NM:'코나 일렉트릭 2WD 롱레인지 19인치'},{MAKER_NM:'다른 제조사'},{MODEL_NM:'코나 일렉트릭 2WD 롱레인지 17인치 빌트인 캠 미적용'}]) {
    const r=parse({...baseRow(),...changed},specFixture());assert.deepEqual(r.specs,{battery:null,range:null,seats:null});
  }
  assert.equal(normalizeVehicleName('Model 3'),normalizeVehicleName('MODEL3'));
});
test('duplicate exact spec matches do not invent a specification',()=> {
  const specs=specFixture();specs.records.push({...specs.records[0],battery:'다른 배터리'});
  assert.deepEqual(parse(baseRow(),specs).specs,{battery:null,range:null,seats:null});
});
test('independent national amount mismatch flags source discrepancy without overwriting local amount',()=> {
  const specs=specFixture();specs.records[0].national=399;
  const r=parse(baseRow(),specs);assert.equal(r.national,400);assert.equal(byId(r,'national-crosscheck')?.passed,false);
});
test('duplicate official model IDs fail the model identity check',()=> {
  const rows=normalizeVehiclePrices({list11:[baseRow(),{...baseRow(),MODEL_NM:'다른 사양'}]},'1100','passenger',2026);
  assert(rows.every(r=>byId(r,'model')?.passed===false));
});
test('family grouping and configuration extraction never alter money or official IDs',()=> {
  const data=fixture('1100','passenger');const untouched=structuredClone(data);
  const rows=enrichVehicleDataset(data,'live',Date.parse(data.checkedAt));
  for(const r of rows) {
    const original=untouched.records.find(o=>o.id===r.id)!;
    assert.equal(r.modelName,original.modelName);assert.equal(r.total,original.total);assert.equal(r.national,original.national);assert.equal(r.local,original.local);
  }
  assert.deepEqual(data,untouched);
  assert.equal(vehicleFamily('아이오닉5 2WD 롱레인지 19인치'),'아이오닉5');
  assert.equal(vehicleFamily('아이오닉5 AWD 롱레인지 20인치'),'아이오닉5');
  assert.deepEqual(vehicleConfiguration('아이오닉5 AWD 롱레인지 20인치'),{drive:'AWD',wheel:'20인치',trim:'롱레인지'});
});
test('stale, failed refresh, and future timestamps cannot pass freshness',()=> {
  const data=fixture('1100','passenger');const time=Date.parse(data.checkedAt);
  assert(enrichVehicleDataset(data,'live',time).every(r=>byId(r,'freshness')?.passed===true));
  for(const [status,now] of [['live',time+31*60_000],['live',time-6*60_000],['cached',time]] as const) assert(enrichVehicleDataset(data,status,now).every(r=>byId(r,'freshness')?.passed===false));
});
test('more than fifty percent amount changes remain flagged',()=> {
  const data=fixture('1100','passenger');const old=structuredClone(data);old.records[0].total=100;
  const current=enrichVehicleDataset(data,'live',Date.parse(data.checkedAt),old).find(r=>r.id===data.records[0].id)!;
  assert.equal(byId(current,'change')?.passed,false);
  const repeated=enrichVehicleDataset(data,'live',Date.parse(data.checkedAt)+60_000,old).find(r=>r.id===data.records[0].id)!;
  assert.equal(byId(repeated,'change')?.passed,false);
});
test('invalid source list structure is rejected',()=> {
  for(const list11 of [null,{},[null],[[]],['bad']]) assert.throws(()=>normalizeVehiclePrices({list11},'1100','passenger',2026));
});

test('malformed thousands separators do not create amounts',()=> {
  for(const raw of ['1,2','12,34','1,,000','1,234,56']) assert.equal(parseVehicleAmount(raw),null);
  assert.equal(parseVehicleAmount('1,234.5'),1234.5);
});
test('numeric zero national amount is preserved',()=> {
  const r=parse({...baseRow(),SUM_GAMT:0,LAMT:0,TOTAL_AMT:0});
  assert.equal(r.national,0);assert.equal(amountWithTransition(r,false).total,0);
});
test('national and local shifts are flagged even with an unchanged subtotal',()=> {
  const data=fixture('1100','passenger');const old=structuredClone(data);
  old.records[0].national=100;old.records[0].local=420;
  const current=enrichVehicleDataset(data,'live',Date.parse(data.checkedAt),old).find(r=>r.id===data.records[0].id)!;
  assert.equal(byId(current,'change')?.passed,false);
});

test('one-won precision is preserved and a one-won mismatch is rejected',()=> {
  const record={national:0.1001,local:0.2002,total:0.3003,transitionNational:0.0001,transitionLocal:0.0002};
  assert.deepEqual(amountWithTransition(record,true),{national:0.1002,local:0.2004,total:0.3006,transition:0.0003});
  assert.equal(amountWithTransition({...record,total:0.3004},false).total,null);
});

console.log(`${passed} passed, ${failures.length} failed`);
if(failures.length) process.exitCode=1;
