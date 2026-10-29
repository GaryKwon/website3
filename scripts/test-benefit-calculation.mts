import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAdditionalBenefits, type BenefitVehicle } from '../lib/benefit-calculation';
import { EMPTY_BENEFIT_PROFILE, type BenefitBundle, type BenefitProfile } from '../lib/benefit-types';

const now = Date.now();
const passenger: BenefitVehicle = { vehicleType:'passenger',categoryCode:'RIDE',category:'일반승용',national:500,local:150,total:650,transitionNational:100,transitionLocal:30 };
const cargo: BenefitVehicle = { ...passenger,vehicleType:'cargo',categoryCode:'TRUCKSML',category:'화물(소형)',national:1000,local:300,total:1300 };
const bundle: BenefitBundle = {
  policy:{year:2026,revision:'test official clauses',checkedAt:new Date(now).toISOString(),sourceUrl:'https://ev.or.kr/',documentUrl:'https://ev.or.kr/file',fingerprint:'test',sourceStatus:'live',sharedFunding:true,additivePercentages:true,fixedAfterPercentages:true,rules:[
    {id:'children',label:'다자녀',kind:'children',value:0,childAmounts:{2:100,3:200,4:300},scope:'passenger-standard',requirement:'18세 이하 자녀',clause:'official'},
    {id:'youth',label:'청년',kind:'percent',value:20,scope:'passenger-all',requirement:'19–34세 생애 첫 자동차',clause:'official'},
    {id:'smallBusiness',label:'소상공인',kind:'percent',value:30,scope:'cargo-small-light-micro',requirement:'확인서',clause:'official'},
    {id:'delivery',label:'택배',kind:'percent',value:10,scope:'cargo-small-light-micro',requirement:'운송사업 증빙',clause:'official'},
    {id:'taxi',label:'택시',kind:'fixed',value:250,scope:'passenger-standard',requirement:'면허',clause:'official'},
    {id:'lowIncomePassenger',label:'기초·차상위',kind:'percent',value:20,scope:'passenger-all',requirement:'차상위 이하 개인',clause:'official'},
    {id:'lowIncomeCargo',label:'기초·차상위',kind:'percent',value:30,scope:'cargo-small-light-micro',requirement:'차상위 이하 개인',clause:'official'},
    {id:'farmer',label:'농업인',kind:'percent',value:10,scope:'cargo-small-light-micro',requirement:'농업인 확인서',clause:'official'},
  ]},
  local:{regionId:'1100',vehicleType:'passenger',year:2026,checkedAt:new Date(now).toISOString(),sourceStatus:'live',sourceUrl:'https://ev.or.kr/',noticeText:'별도 지역지원 가능',notices:[],signals:[],monetaryVerification:'local-notice-required'},
};
const profile=(patch:Partial<BenefitProfile>):BenefitProfile=>({...EMPTY_BENEFIT_PROFILE,...patch});
const calc=(patch:Partial<BenefitProfile>,vehicle=passenger,rules:BenefitBundle|undefined=bundle,transition=false)=>calculateAdditionalBenefits(vehicle,transition,profile(patch),rules,2026,now);

test('children awards are exclusive and follow official 100/200/300 amounts',()=>{
  for(const [children,extra] of [[2,100],[3,200],[4,300]] as const){const r=calc({children});assert.equal(r.lines.length,1);assert.equal(r.additional,extra);assert.equal(r.total,650+extra);}
});
test('youth uses original national amount and does not add local matching twice',()=>{
  const r=calc({youth:true});assert.equal(r.additional,100);assert.equal(r.total,750);assert.equal(r.base.local,150);
});
test('passenger percentage and fixed awards stack without compound growth',()=>{
  const r=calc({children:3,youth:true,taxi:true});assert.equal(r.additional,550);assert.equal(r.total,1200);
});
test('small-business and delivery use the same original cargo national base',()=>{
  const r=calc({smallBusiness:true,delivery:true},cargo);assert.equal(r.additional,400);assert.equal(r.total,1700);
});
test('transition never inflates another percentage and first-car is incompatible with it',()=>{
  assert.equal(calc({farmer:true},cargo,bundle,true).additional,100);
  assert.equal(calc({children:2},passenger,bundle,true).total,880);
  const conflict=calc({youth:true},passenger,bundle,true);assert.equal(conflict.total,null);assert.equal(conflict.lines[0].state,'unverified');
});
test('cargo small-business with transition remains unresolved instead of assuming regional stacking',()=>{
  const r=calc({smallBusiness:true,delivery:true},cargo,bundle,true);
  assert.equal(r.total,null);assert.equal(r.pendingCount,1);assert.equal(r.knownTotal,1530);
  assert.match(r.lines[0].detail,/중복 가능 여부/);
});
test('low-income and youth passenger percentages stack on the original base',()=>{
  const r=calc({lowIncome:true,youth:true});assert.equal(r.additional,200);assert.equal(r.total,850);
});
test('cargo low-income and small-business are one award, with farmer and delivery independently added',()=>{
  const r=calc({smallBusiness:true,lowIncome:true,farmer:true,delivery:true},cargo);
  assert.equal(r.lines.length,3);assert.equal(r.additional,500);assert.equal(r.total,1800);
  assert.match(r.lines[0].label,/소상공인/);assert.match(r.lines[0].detail,/한 번/);
});
test('flags from another vehicle type do not leak into the calculation',()=>{
  assert.equal(calc({smallBusiness:true,delivery:true}).additional,0);
  assert.equal(calc({children:4,youth:true,taxi:true},cargo).additional,0);
});
test('micro passenger child and taxi awards are excluded while youth remains eligible',()=>{
  const r=calc({children:3,taxi:true,youth:true},{...passenger,categoryCode:'RIDESSML',category:'승용(초소형)'});
  assert.equal(r.additional,100);assert.equal(r.lines.filter(l=>l.state==='not-applicable').length,2);
});
test('medium cargo and unknown passenger categories require source review',()=>{
  assert.equal(calc({smallBusiness:true},{...cargo,categoryCode:'TRUCKMID',category:'화물(중형)'}).total,null);
  assert.equal(calc({children:2},{...passenger,categoryCode:'NEWCLASS'}).total,null);
});
test('unavailable, old, future, wrong-year, and changed-semantics policy cannot produce an extra total',()=>{
  const policies=[{sourceStatus:'unavailable' as const},{checkedAt:new Date(now-31*60_000).toISOString()},{checkedAt:new Date(now+6*60_000).toISOString()},{year:2027},{sharedFunding:false},{additivePercentages:false},{fixedAfterPercentages:false}];
  for(const patch of policies){const r=calc({youth:true},passenger,{...bundle,policy:{...bundle.policy,...patch}});assert.equal(r.total,null);assert.equal(r.additional,null);}
  assert.equal(calculateAdditionalBenefits(passenger,false,profile({children:2}),undefined,2026,now).total,null);
});
test('base remains visible without selected extras even when policy is unavailable',()=>{
  assert.equal(calculateAdditionalBenefits(passenger,false,profile({}),undefined,2026,now).total,650);
});
test('changed official rates and child amounts recalculate the same selected conditions',()=>{
  const changed={...bundle,policy:{...bundle.policy,revision:'revised',rules:bundle.policy.rules.map(r=>r.id==='youth'?{...r,value:25}:r.id==='children'?{...r,childAmounts:{2:110,3:210,4:310}}:r)}};
  assert.equal(calc({youth:true,children:3},passenger,changed).additional,335);
});
test('unverified local notices never inject money into the estimated total',()=>{
  const local={...bundle.local,noticeText:'시비 999만원 제조사 할인 999만원',signals:[{id:'taxi',label:'택시',excerpt:'추가 999만원'}]};
  assert.equal(calc({taxi:true},passenger,{...bundle,local}).additional,250);
});
test('one-won precision is preserved in fractional percentage estimates',()=>{
  const r=calc({youth:true},{...passenger,national:0.1001,local:0.2,total:0.3001});assert.equal(r.additional,0.02);assert.equal(r.total,0.3201);
});
test('missing base values and zero-national vehicles do not invent fixed awards',()=>{
  assert.equal(calc({children:2},{...passenger,total:null}).total,null);
  const r=calc({children:2},{...passenger,national:0,local:0,total:0});assert.equal(r.additional,0);assert.equal(r.total,0);
});
