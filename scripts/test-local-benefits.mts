import assert from 'node:assert/strict';
import test from 'node:test';
import passenger from '../lib/data/official-passenger.json';
import cargo from '../lib/data/official-cargo.json';
import { normalizeDataset, type SubsidyRecord } from '../lib/subsidies';
import type { OfficialDataset } from '../lib/official-source';
import { localBenefitInfo, localBenefitSignals, localNoticeAttachments, localNoticeText } from '../lib/local-benefit-source';

const year = Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
const checkedAt = new Date().toISOString();
function fresh(type: 'passenger' | 'cargo'): OfficialDataset {
  const original = type === 'passenger' ? passenger : cargo;
  return {...original,year,checkedAt,rows:original.rows.map(row=>({...row,YEAR:String(year)}))} as unknown as OfficialDataset;
}
function currentRecord(): SubsidyRecord {
  return normalizeDataset(fresh('passenger'),'passenger',year).find(record=>record.regionId==='1100')!;
}
const context = {regionId:'1100',vehicleType:'passenger' as const,year,sourceStatus:'live',checkedAt};

test('all 320 funding authority/type rows retain official notice metadata and 317 have attachments', () => {
  let total=0,withAttachments=0;
  for(const type of ['passenger','cargo'] as const) {
    const records=normalizeDataset(fresh(type),type,year);
    assert.equal(records.length,160);
    assert.equal(new Set(records.map(record=>record.regionId)).size,160);
    for(const record of records) {
      total++;
      const info=localBenefitInfo(record,{...context,regionId:record.regionId,vehicleType:type});
      assert.equal(info.sourceStatus,'live',record.regionId);
      assert.equal(info.monetaryVerification,'local-notice-required');
      if(info.notices.length) withAttachments++;
      for(const notice of info.notices) {
        const url=new URL(notice.downloadUrl);
        assert.equal(url.origin,'https://ev.or.kr');
        assert.equal(url.pathname,'/nportal/ps/comm/noticeFile/download.do');
        assert.equal(url.searchParams.get('local_cd'),record.regionId);
        assert.equal(url.searchParams.get('car_type'),type==='passenger'?'11':'12');
      }
    }
  }
  assert.equal(total,320);
  assert.equal(withAttachments,317);
});

test('missing cargo attachments remain unverified rather than denying additional support', () => {
  const records=normalizeDataset(fresh('cargo'),'cargo',year);
  for(const id of ['4513','4792','4812']) {
    const info=localBenefitInfo(records.find(record=>record.regionId===id),{...context,regionId:id,vehicleType:'cargo'});
    assert.equal(info.notices.length,0);
    assert.equal(info.monetaryVerification,'local-notice-required');
    assert.ok(!('amount' in info) && !('eligible' in info));
  }
});

test('cached, stale, wrong-year, wrong-authority and aggregate sources never appear newly verified', () => {
  const record=currentRecord();
  const cases = [
    {record,context:{...context,sourceStatus:'cached'}},
    {record:{...record,verification:'stale' as const},context},
    {record:{...record,year:year-1},context:{...context,year:year-1}},
    {record:{...record,regionId:'4111'},context},
    {record,context:{...context,regionId:'province:경기도'}},
    {record:{...record,checkedAt:new Date(Date.now()-31*60_000).toISOString()},context:{...context,checkedAt:new Date(Date.now()-31*60_000).toISOString()}},
    {record:undefined,context},
  ];
  for(const value of cases) {
    const info=localBenefitInfo(value.record,value.context);
    assert.equal(info.sourceStatus,'unavailable');
    assert.equal(info.checkedAt,null);
    assert.equal(info.noticeText,'');
    assert.equal(info.notices.length,0);
  }
});

test('notice links are regenerated from an allowlisted code and cannot carry arbitrary URLs or duplicate entries', () => {
  const record=currentRecord();
  const original=record.noticeAttachments![0];
  record.noticeAttachments=[original,{...original,label:'<script>bad</script>'},{...original,code:'https://evil.example',downloadUrl:'https://evil.example'},{...original,code:'D',downloadUrl:'javascript:alert(1)'}];
  const info=localBenefitInfo(record,context);
  assert.equal(info.notices.length,1);
  assert.ok(!info.notices[0].label.includes('<'));
  assert.ok(info.notices[0].downloadUrl.startsWith('https://ev.or.kr/'));
});

test('free-text signals stay evidence even when historical, closed, conflicting or containing script markup', () => {
  const text='<script>alert(1)</script>청년 EV드림 종료<br><img src=x onerror=alert(1)>택배 추가 지원 100만원 마감<br>다자녀 150만원(과거 공고)';
  const cleaned=localNoticeText(text);
  assert.ok(!cleaned.includes('<script') && !cleaned.includes('<img'));
  const signals=localBenefitSignals(text);
  assert.ok(signals.some(signal=>signal.id==='youth'));
  assert.ok(signals.some(signal=>signal.id==='delivery'));
  assert.ok(signals.some(signal=>signal.excerpt.includes('종료')));
  assert.ok(signals.every(signal=>!('amount' in signal) && !('eligible' in signal)));
});

test('notice attachment flags require the exact financial authority, type and year', () => {
  const row=fresh('passenger').rows.find(row=>row.LOCAL_CD==='1100')!;
  assert.ok(localNoticeAttachments(row,context).length>0);
  assert.equal(localNoticeAttachments(row,{...context,vehicleType:'cargo'}).length,0);
  assert.equal(localNoticeAttachments(row,{...context,year:year+1}).length,0);
  assert.equal(localNoticeAttachments(row,{...context,regionId:'9999'}).length,0);
  assert.equal(localNoticeAttachments(row,{...context,regionId:'province:경기도'}).length,0);
});
