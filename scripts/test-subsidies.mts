import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDataset, countParts } from '../lib/subsidies';
import type { OfficialDataset } from '../lib/official-source';

const fixture = (type: 'passenger'|'cargo'): OfficialDataset => JSON.parse(readFileSync(new URL(`../lib/data/official-${type}.json`, import.meta.url), 'utf8'));
let passed = 0;
const failures: string[] = [];
function test(name: string, action: () => void) {
  try { action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
const normalize = (data: OfficialDataset, type: 'passenger'|'cargo' = 'passenger', advance = 0) => normalizeDataset(data,type,2026,Date.parse(data.checkedAt)+advance);

test('BR categories preserve empty leading slots and signed values', () => {
  assert.deepEqual(countParts('<br> (-2,931)<br /> (0)<br/> (3,980)'), [null,-2931,0,3980]);
  assert.deepEqual(countParts('12.5<br>invalid<br>9007199254740992'),[null,null,null]);
});
for (const type of ['passenger','cargo'] as const) {
  test(`${type}: official snapshot has 160 unique local authorities and finite counts`, () => {
    const rows=normalize(fixture(type),type);
    assert.equal(rows.length,160);
    assert.equal(new Set(rows.map(r=>r.regionId)).size,rows.length);
    assert(!rows.some(r=>r.regionId==='9999'));
    for(const r of rows) for(const n of [r.announced,r.received,r.selected,r.delivered,r.remaining,r.available]) assert(n===null || (Number.isSafeInteger(n)&&n>=0));
  });
}
test('old official response is stale after 30 minutes', () => {
  assert(normalize(fixture('passenger'),'passenger',31*60_000).every(r=>r.verification==='stale'));
});
test('wrong year and wrong vehicle never receive verified status', () => {
  const data=fixture('passenger');
  data.rows[0].YEAR='2025'; data.rows[1].NM='전기화물';
  const rows=normalize(data);
  assert.equal(rows[0].verification,'review'); assert.equal(rows[1].verification,'review');
});
test('duplicate official authority code is flagged', () => {
  const data=fixture('passenger');data.rows.push({...data.rows[0]});
  const rows=normalize(data).filter(r=>r.regionId===data.rows[0].LOCAL_CD);
  assert.equal(rows.length,2);assert(rows.every(r=>r.verification==='review'));
});
test('malformed official totals are unknown, never zero', () => {
  const data=fixture('passenger');data.rows[0].TCNT_1='정보 없음';
  const r=normalize(data)[0];assert.equal(r.announced,null);assert.equal(r.available,null);assert.equal(r.verification,'review');
});
test('authority name must match its official code', () => {
  const data=fixture('passenger');data.rows[0].LOCAL_NM='부산광역시';
  const r=normalize(data)[0];assert.equal(r.verification,'review');assert.equal(r.checks.find(c=>c.id==='region')?.passed,false);
});
test('partial cargo closure cannot become blanket closed status', () => {
  const data=fixture('cargo');const raw=data.rows.find(r=>r.LOCAL_CD==='1100')!;
  raw.ETC='전기화물차(일반, 우선순위) 마감 (※ 전기화물차(택배) 접수가능)';
  data.finishRows=data.finishRows.filter(r=>r.LOCAL_CD!=='1100');
  data.periodRows=data.periodRows.filter(r=>r.LOCAL_CD!=='1100');
  const r=normalize(data,'cargo').find(r=>r.regionId==='1100')!;
  assert.notEqual(r.status,'closed');
});
test('future timestamps cannot receive fresh verification', () => {
  const data=fixture('passenger');
  assert(normalize(data,'passenger',-6*60_000).every(r=>r.verification==='stale'));
});
test('non-primitive selected counts remain unknown', () => {
  for (const invalid of [false, [], {}]) {
    const data=fixture('passenger');
    data.choiceRows.find(r=>r.LOCAL_CD==='1100')!.CHOICE_CNT=invalid;
    const r=normalize(data).find(r=>r.regionId==='1100')!;
    assert.equal(r.selected,null);assert.equal(r.available,null);assert.equal(r.verification,'review');
  }
});
test('large changes remain reviewable against an earlier source', () => {
  const data=fixture('passenger');const earlier=fixture('passenger');
  earlier.rows[0].TCNT_1='100';
  const row=normalizeDataset(data,'passenger',2026,Date.parse(data.checkedAt),earlier)[0];
  assert.equal(row.checks.find(c=>c.id==='change')?.passed,false);
  assert.equal(row.verification,'review');
});
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode=1;
