import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { regions, searchRegions, type Region } from '../lib/regions';

type AdministrativeFixture = {sourceUrl:string;checkedAt:string;provinces:{province:string;areas:string[]}[]};
type OfficialFixture = {rows:{LOCAL_CD:string;LOCAL_NM:string}[]};
const administrative:AdministrativeFixture=JSON.parse(readFileSync(new URL('../lib/data/administrative-areas.json',import.meta.url),'utf8'));
const official=(type:'passenger'|'cargo'):OfficialFixture=>JSON.parse(readFileSync(new URL(`../lib/data/official-${type}.json`,import.meta.url),'utf8'));
const authorities=regions.filter(r=>!r.children?.length);
const aggregates=regions.filter(r=>r.children?.length);
const compact=(value:string)=>value.replace(/\s+/g,'').toLowerCase();
// Mirror the page's matching predicate separately from the richer search helper.
const displayMatches=(query:string):Region[]=>{
  const needle=compact(query);
  return regions.filter(r=>[r.name,`${r.province}${r.name}`,...r.aliases].some(v=>compact(v).includes(needle)))
    .sort((a,b)=>Number([b.name,...b.aliases].some(v=>compact(v)===needle))-Number([a.name,...a.aliases].some(v=>compact(v)===needle))).slice(0,7);
};
const exactMatches=(query:string)=>searchRegions(query,regions.length).filter(r=>[r.name,...r.aliases].some(alias=>compact(alias)===compact(query)));
const mapsTo=(query:string,id:string)=>assert(exactMatches(query).some(r=>r.id===id),`${query} → ${id}`);
let passed=0;
const failures:string[]=[];
function test(name:string,action:()=>void){
  try{action();passed++;console.log(`PASS ${name}`);}
  catch(error){failures.push(name);console.error(`FAIL ${name}: ${error instanceof Error?error.message:String(error)}`);}
}

test('the current MOIS fixture contains 16 provinces and 229 local names',()=>{
  assert.equal(administrative.sourceUrl,'https://www.mois.go.kr/frt/sub/a04/localGovernment/screen.do');
  assert(Number.isFinite(Date.parse(administrative.checkedAt)));
  assert.equal(administrative.provinces.length,16);
  assert.equal(administrative.provinces.reduce((count,p)=>count+p.areas.length,0),229);
  assert.equal(new Set(administrative.provinces.map(p=>p.province)).size,16);
});
test('all 169 region IDs are unique, with 160 financial authorities and nine aggregates',()=>{
  assert.equal(regions.length,169);assert.equal(new Set(regions.map(r=>r.id)).size,169);
  assert.equal(authorities.length,160);assert.equal(aggregates.length,9);
  assert(!regions.some(r=>r.id==='9999'));
  for(const r of regions){assert(r.name&&r.province);assert.equal(new Set(r.aliases).size,r.aliases.length,r.id);}
});
for(const type of ['passenger','cargo'] as const){
  test(`every official ${type} authority code exists exactly once`,()=>{
    const rows=official(type).rows.filter(r=>r.LOCAL_CD!=='9999');
    assert.equal(rows.length,160);assert.equal(new Set(rows.map(r=>r.LOCAL_CD)).size,160);
    assert.deepEqual(new Set(rows.map(r=>r.LOCAL_CD)),new Set(authorities.map(r=>r.id)));
    for(const row of rows){const authority=authorities.find(r=>r.id===row.LOCAL_CD)!;assert.equal(authority.name,row.LOCAL_NM,row.LOCAL_CD);}
  });
}
for(const province of administrative.provinces){
  test(`${province.province}: all ${province.areas.length} qualified local names resolve`,()=>{
    assert(searchRegions(province.province,regions.length).length,province.province);
    for(const area of province.areas){
      const query=`${province.province} ${area}`;
      const matches=exactMatches(query);
      assert.equal(matches.length,1,`${query}: ${matches.map(r=>r.id).join(', ')}`);
      assert(!matches[0].children?.length,`${query} must resolve to an administering authority`);
      assert(displayMatches(query).some(r=>r.id===matches[0].id),`${query} is missing from the page's seven suggestions`);
    }
  });
}
test('all aggregate children refer to unique, existing financial authorities',()=>{
  const expected:Record<string,number>={'경기도':31,'강원특별자치도':18,'충청북도':11,'충청남도':15,'전북특별자치도':14,'전라남도':22,'경상북도':22,'경상남도':18,'전남광주통합특별시':23};
  for(const aggregate of aggregates){
    assert.equal(aggregate.id,`province:${aggregate.name}`);
    assert.equal(aggregate.children!.length,expected[aggregate.name],aggregate.name);
    assert.equal(new Set(aggregate.children).size,aggregate.children!.length,aggregate.name);
    for(const id of aggregate.children!)assert.equal(authorities.filter(r=>r.id===id).length,1,`${aggregate.name}: ${id}`);
  }
});
test('the merged province retains old Gwangju and Jeonnam financial authority codes',()=>{
  const merged=regions.find(r=>r.id==='province:전남광주통합특별시')!;
  assert(merged.children?.includes('2900'));
  const jeonnam=regions.find(r=>r.id==='province:전라남도')!;
  assert(jeonnam.children?.every(id=>merged.children?.includes(id)));
  for(const district of ['동구','서구','남구','북구','광산구'])mapsTo(`전남광주통합특별시 ${district}`,'2900');
});
test('all seventeen former province names remain searchable',()=>{
  const names=['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도'];
  for(const name of names)assert.equal(exactMatches(name).length,1,name);
  mapsTo('광주광역시','2900');mapsTo('전라남도','province:전라남도');
  mapsTo('강원도','province:강원특별자치도');mapsTo('전라북도','province:전북특별자치도');
});
test('province abbreviations rank their aggregate before child authorities',()=>{
  for(const [query,id] of [['경기','province:경기도'],['강원','province:강원특별자치도'],['충북','province:충청북도'],['충남','province:충청남도'],['전북','province:전북특별자치도'],['전남','province:전라남도'],['경북','province:경상북도'],['경남','province:경상남도'],['전남광주','province:전남광주통합특별시']]){assert.equal(searchRegions(query)[0]?.id,id,query);assert.equal(displayMatches(query)[0]?.id,id,`page ${query}`);}
});
test('all 285 legacy and abbreviated province-qualified authority aliases remain visible',()=>{
  const aliases:Record<string,string[]>={'경기도':['경기'],'강원특별자치도':['강원도','강원'],'충청북도':['충북','충북도'],'충청남도':['충남','충남도'],'전북특별자치도':['전라북도','전북','전북도'],'전라남도':['전남','전남도'],'경상북도':['경북','경북도'],'경상남도':['경남','경남도']};
  let count=0;
  for(const authority of authorities)for(const prefix of aliases[authority.province]||[]){
    const query=`${prefix} ${authority.name}`;count++;
    mapsTo(query,authority.id);assert(displayMatches(query).some(r=>r.id===authority.id),query);
  }
  assert.equal(count,285);
});
test('Jung-gu keeps all six authorities, including the former Incheon district alias',()=>{
  assert.deepEqual(new Set(exactMatches('중구').map(r=>r.id)),new Set(['1100','2600','2700','2800','3000','3100']));
});
test('Goseong-gun is disambiguated by province',()=>{
  assert.deepEqual(new Set(exactMatches('고성군').map(r=>r.id)),new Set(['4282','4882']));
  mapsTo('강원특별자치도 고성군','4282');mapsTo('경상남도 고성군','4882');
});
test('current Incheon names and the three replaced district names resolve to the official authority',()=>{
  const current=administrative.provinces.find(p=>p.province==='인천광역시')!;
  for(const name of [...current.areas,'중구','동구','서구'])mapsTo(`인천광역시 ${name}`,'2800');
});
test('the four 2026 Hwaseong districts resolve to Hwaseong',()=>{
  for(const district of ['만세구','효행구','병점구','동탄구']){
    mapsTo(district,'4159');mapsTo(`화성시 ${district}`,'4159');mapsTo(`경기도 화성시 ${district}`,'4159');
  }
});
test('all 39 existing general-district aliases retain their administering city',()=>{
  // Regression coverage of existing aliases, not an assertion that the MOIS
  // autonomous-authority fixture enumerates non-autonomous general districts.
  const districts:Record<string,string[]>={
    '수원시':['장안구','권선구','팔달구','영통구'],
    '성남시':['수정구','중원구','분당구'],
    '안양시':['만안구','동안구'],
    '안산시':['상록구','단원구'],
    '고양시':['덕양구','일산동구','일산서구'],
    '용인시':['처인구','기흥구','수지구'],
    '화성시':['만세구','효행구','병점구','동탄구'],
    '부천시':['원미구','소사구','오정구'],
    '청주시':['상당구','서원구','흥덕구','청원구'],
    '천안시':['동남구','서북구'],
    '전주시':['완산구','덕진구'],
    '포항시':['남구','북구'],
    '창원시':['의창구','성산구','마산합포구','마산회원구','진해구'],
  };
  assert.equal(Object.values(districts).reduce((count,items)=>count+items.length,0),39);
  for(const [city,names] of Object.entries(districts)){
    const authority=authorities.find(r=>r.name===city);assert(authority,city);
    for(const district of names){mapsTo(`${city} ${district}`,authority.id);mapsTo(`${authority.province} ${city} ${district}`,authority.id);}
  }
});
console.log(`${passed} passed, ${failures.length} failed; audited 16 current provinces, 229 qualified local names, 160 subsidy authorities, and 39 general-district aliases.`);
if(failures.length)process.exitCode=1;
