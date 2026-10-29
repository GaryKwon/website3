import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { extractHwpxText, MAX_POLICY_ZIP_BYTES, parseBenefitPolicyText } from '../lib/benefit-policy-parser';
import { getBenefitPolicy, getBenefitPolicyRuntimeState } from '../lib/benefit-policy-source';

const YEAR = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Seoul' }).format(new Date()));
// Relevant normative paragraphs transcribed from the official 2026-06-23 HWPX,
// SHA256 d25b78a12fc299611201506099b362267b4e1e8c9b1f1d554771ffbeaffa1f63.
const sharing = '○ 지방자치단체는 차종별 국비 보조금 산정 수준에 비례하여 지방비 보조금을 차종별로 차등적으로 산정해야 하며, 구매자 특성에 따른 추가지원금의 경우도 국비와 지방비 비율에 따라 분담하여 지원되도록 해야 함';
const youth = '○ 청년(「청년기본법」 제3조에 따라 19세 이상 34세 이하인 사람)에 해당하는 개인이 생애 첫 자동차로 전기차를 구매하는 경우 국비 지원액의 20% 추가 지원';
const lowIncome = '○ 차상위 이하 계층에 해당하는 개인이 구매 시 해당 차량 국비 지원액의 20% 추가 지원';
const business = '○ 차상위 이하 계층에 해당하는 개인, 소상공인이 구매 시 해당차량 국비 지원액의 30% 추가 지원';
const farmer = '○ 농업인*이 구매 시 해당차량 국비 지원액의 10% 추가 지원';
const farmerCondition = '* 「농업·농촌 및 식품산업 기본법 시행령」 제3조 및「농업인 확인서 발급규정」에 따른 농업인 확인서 또는 「농어업경영체 육성 및 지원에 관한 법률 시행규칙」제3조에 따른 농업경영체 등록확인서(또는 증명서)를 제출받아 확인';
const delivery = '○ 택배용 차량*으로 전기화물차 구매 시 국비 지원액의 10% 추가 지원';
const deliveryCondition = '* 「화물자동차법」 제2조제3호에 따른 운송사업 중 화물을 집화·분류·배송하는 형태의 운송사업에 사용되는 자동차';
const oldEv = '○ 기존 노후 전기차(BMS 안전기능* 업데이트가 불가능한 차량에 한함)를 폐차하고 전기차를 재구매하는 경우 20만원 추가지원(’26.12.31.까지 지원)';
const projectEvidence = '증빙서류 예시(별지 5호 참고) : 사업계획서, 사업참여신청서, 차량제조사 확인서 등';
const fixture = `「${YEAR}년 전기자동차 보급사업」보조금 업무처리지침
4-1-1. 공통사항(중·대형, 소형, 초소형)
${sharing}
○ 구매자 특성에 따른 추가지원금은 중복 지원 가능. 단, 정액 지원(예 : 다자녀가구 지원 등) 금액은 일정 비율(%) 추가지원 금액을 산정한 이후 마지막에 더하도록 함
4-1-2. 중·대형, 소형
○ 전기택시에 대해서는 해당 차량 보조금에 250만원 추가 지원*
* 구매자가 택시사업자면허를 가진 경우 추가 지원(증빙자료로 면허증 사본 제출), 택시법인에 대해서는 중소기업이 구매하는 경우에 한정하여 추가 지원
※ 지역별 이동여건을 고려하여 법인(중소기업 한정)의 전기택시 구매에 대해 재지원제한기간 적용 없이 지자체 보조 가능
${lowIncome}
${youth}
○ 다자녀가구(18세 이하 자녀 2명 이상)에 해당하는 개인이 구매 시 자녀 수에 따라 최대 300만원* 추가지원
* (2자녀) 100만원, (3자녀) 200만원, (4자녀 이상) 300만원
○ 개인사업자나 법인이 2년 이내 2대 이상의 전기차를 구매하려는 경우 민간보조사업을 통해 국비만 지원하고 ‘재지원제한기간’ 미적용
※ ’26.9월 이후 지방비 보조금이 소진되는 경우 개인 구매에 대해서도 민간보조사업을 통해 국비만 지원(추가지원 및 인센티브 포함)할 수 있도록 허용하되 재지원제한기간은 적용
- 리스/렌탈 사업목적으로 구매(증빙서류 제출 필요)하는 경우 180만원 이내* 추가 지원
* 차종별 일반 국비 보조금(추가 지원금 外) 산정 수준에 비례하여 차등 산정
※ 이용자명의 리스 등과 같이 차량등록증 상 명의가 개인(구매자)인 경우 개인구매 기준 적용(단, 계약서 등을 통해 보조금 회수의무 이행주체를 명확히 지정하고, 증빙자료를 제출하여야 함)
${oldEv}
* 배터리 이상을 주차 중에도 감지(상시 또는 간헐)하고 차주 및 제작사에 알리는 기능
4-1-3. 초소형
○ 차량 종류에 관계없이 국비기준 200만원 정액 지원, 다만 구매자가 초소형 전기차 활용 확대*를 위한 지역 거점 사업의 일환으로 구매한다는 사실을 증빙**하는 경우 50만원 추가 지원
* 도심내 영업용(배달·관광 등), 단거리 교통수단으로 활용 등
** ${projectEvidence}
${lowIncome}
${youth}
4-2. 전기승합차
4-3-1. 공통사항(대형, 중형, 소형, 경형, 초소형)
${sharing}
○ 구매자 특성에 따른 추가지원은 중복 지원 가능
※ (계산 예시) 소상공인이 택배용 차량으로 국비보조금 1,000만원인 소형전기화물차를 구매하는 경우 : 1,000만원 +1,000만원×30% +1,000만원×10% = 1,400만원 지급
4-3-2. 대형·중형
4-3-3. 소형·경형
${business}
${farmer}
${farmerCondition}
${delivery}
${deliveryCondition}
4-3-4. 초소형
○ 차량 종류에 관계없이 초소형 전기화물차는 국비기준 380만원 정액 지원
- 다만, 초소형 전기화물차를 해당차량 활용 확대(도심내 영업용, 단거리 교통수단 등)를 위한 지역거점 사업 추진 목적으로 구매하는 경우 50만원 추가 지원
※ ${projectEvidence}
※ 原 제조국에서 전기화물로 판매하는 차량만 전기화물로 인정
※ 제거가 불가한 고정형 격벽 설치시에만 전기화물로 인정
${business}
${farmer}
${farmerCondition}
${delivery}
${deliveryCondition}
5. 보조금 집행 절차`;
function xmlFor(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="urn:test:section" xmlns:hp="urn:test:paragraph">${text.split('\n').map(p => `<hp:p><hp:run><hp:t>${escape(p)}</hp:t></hp:run></hp:p>`).join('')}</hs:sec>`;
}
function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: Record<string, string>, method = 8): Uint8Array {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let at = 0;
  for (const [name, content] of Object.entries(entries)) {
    const fileName = Buffer.from(name), plain = Buffer.from(content), compressed = method === 8 ? deflateRawSync(plain) : plain;
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum(plain), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(plain.length, 22); header.writeUInt16LE(fileName.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum(plain), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(at, 42);
    local.push(header, fileName, compressed); directory.push(central, fileName); at += header.length + fileName.length + compressed.length;
  }
  const centralBytes = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const document = (text = fixture) => zip({ 'Preview/PrvText.txt': '청년 99% 잘못된 미리보기', 'Contents/section0.xml': xmlFor(text) });
test('current clauses yield the correct national amounts, scopes, and funding flags', () => {
  const result = parseBenefitPolicyText(fixture, YEAR);
  assert.deepEqual(result.rules.map(r => [r.id, r.value]), [['children', 300], ['youth', 20], ['smallBusiness', 30], ['delivery', 10], ['taxi', 250], ['lowIncomePassenger', 20], ['lowIncomeCargo', 30], ['farmer', 10]]);
  assert.deepEqual(result.rules[0].childAmounts, { 2: 100, 3: 200, 4: 300 });
  assert.equal(result.rules[0].scope, 'passenger-standard');
  assert.equal(result.rules[1].scope, 'passenger-all');
  assert.equal(result.rules[2].scope, 'cargo-small-light-micro');
  assert.equal(result.rules[5].scope, 'passenger-all');
  assert.equal(result.rules[6].scope, 'cargo-small-light-micro');
  assert.equal(result.rules[7].scope, 'cargo-small-light-micro');
  assert.equal(result.rules[6].clause, result.rules[2].clause, 'income and business qualify for one shared cargo grant');
  assert.deepEqual(result.reviewRules.map(r => [r.id, r.amountLabel, r.scopes]), [
    ['oldEv', '20만원', ['passenger-standard']],
    ['lease', '최대 180만원', ['passenger-standard']],
    ['microProject', '50만원', ['passenger-micro', 'cargo-micro']],
  ]);
  assert.equal(result.reviewRules[0].expiresOn, '2026-12-31');
  assert.ok(result.sharedFunding && result.additivePercentages && result.fixedAfterPercentages);
});
test('changed child amounts and youth ages/rates are read from the document', () => {
  const text = fixture.replace('(3자녀) 200만원', '(3자녀) 150만원').replaceAll('19세 이상 34세 이하', '20세 이상 35세 이하').replaceAll('20% 추가 지원', '25% 추가 지원');
  const rules = parseBenefitPolicyText(text, YEAR).rules;
  assert.equal(rules[0].childAmounts?.[3], 150);
  assert.equal(rules[1].value, 25);
  assert.match(rules[1].requirement, /20~35세/);
});
test('changed cargo rates must retain the additive base and consistent example', () => {
  const text = fixture.replaceAll('30% 추가 지원', '25% 추가 지원').replace('×30%', '×25%').replace('1,400만원 지급', '1,350만원 지급');
  assert.equal(parseBenefitPolicyText(text, YEAR).rules.find(r => r.id === 'smallBusiness')?.value, 25);
  assert.equal(parseBenefitPolicyText(text, YEAR).rules.find(r => r.id === 'lowIncomeCargo')?.value, 25);
  assert.throws(() => parseBenefitPolicyText(fixture.replaceAll('30% 추가 지원', '25% 추가 지원'), YEAR));
});
test('new income and farmer amounts are parsed, and different micro terms fail closed', () => {
  const text = fixture.replaceAll(lowIncome, lowIncome.replace('20%', '22%')).replaceAll(farmer, farmer.replace('10%', '12%'));
  const rules = parseBenefitPolicyText(text, YEAR).rules;
  assert.equal(rules.find(r => r.id === 'lowIncomePassenger')?.value, 22);
  assert.equal(rules.find(r => r.id === 'farmer')?.value, 12);
  assert.throws(() => parseBenefitPolicyText(fixture.replace(lowIncome, lowIncome.replace('20%', '22%')), YEAR));
  assert.throws(() => parseBenefitPolicyText(fixture.replace(farmer, farmer.replace('10%', '12%')), YEAR));
});
test('review-only amounts and expiry are parsed from verified clauses', () => {
  const text = fixture.replace('20만원 추가지원(’26.12.31.', '35만원 추가지원(’27.6.30.').replace('180만원 이내*', '210만원 이내*').replaceAll('50만원 추가 지원', '60만원 추가 지원');
  const reviews = parseBenefitPolicyText(text, YEAR).reviewRules;
  assert.deepEqual(reviews.map(r => r.amountLabel), ['35만원', '최대 210만원', '60만원']);
  assert.equal(reviews[0].expiresOn, '2027-06-30');
  assert.ok(reviews.every(r => r.clause.length > 0));
});
test('income, farmer, and review eligibility cannot silently change', () => {
  for (const text of [
    fixture.replaceAll('차상위 이하 계층에 해당하는 개인이 구매', '차상위 이하 계층에 해당하는 법인이 구매'),
    fixture.replaceAll('차상위 이하 계층에 해당하는 개인, 소상공인', '차상위 이하 계층에 해당하는 개인 및 소상공인'),
    fixture.replaceAll(farmerCondition, farmerCondition.replace('제출받아 확인', '제출 생략')),
    fixture.replace(oldEv, oldEv.replace('업데이트가 불가능한 차량에 한함', '업데이트가 가능한 차량 포함')),
    fixture.replace('’26.12.31.', '’26.2.30.'),
    fixture.replace('사업목적으로 구매(증빙서류 제출 필요)', '개인이 리스 이용'),
    fixture.replace('개인구매 기준 적용', '사업자 구매 기준 적용'),
    fixture.replace('사실을 증빙**하는 경우', '경우'),
    fixture.replace('사업계획서, 사업참여신청서, 차량제조사 확인서 등', '증빙서류 면제'),
    fixture.replace('제거가 불가한 고정형 격벽', '탈착식 격벽'),
    fixture.replace('4-3-2. 대형·중형', `4-3-2. 대형·중형\n${farmer}\n${farmerCondition}`),
    fixture.replace('4-3-2. 대형·중형', '4-3-2. 대형·중형\n○ 지역 거점 사업으로 구매 시 50만원 추가 지원'),
    fixture.replaceAll(lowIncome, lowIncome.replace('20%', '0%')),
    fixture.replaceAll(farmer, farmer.replace('10%', '101%')),
  ]) assert.throws(() => parseBenefitPolicyText(text, YEAR));
});
test('changed eligibility, stacking, and sharing fail closed', () => {
  for (const changed of [fixture.replaceAll('생애 첫 자동차', '생애 첫 전기차'), fixture.replace('중복 지원 가능.', '중복 지원 불가.'), fixture.replaceAll('국비와 지방비 비율에 따라 분담', '국비로만 부담'), fixture.replace(youth, youth + '\n※ 추가 소득 제한 적용')]) {
    assert.throws(() => parseBenefitPolicyText(changed, YEAR));
  }
  assert.throws(() => parseBenefitPolicyText(fixture, YEAR - 1));
});
test('changed micro eligibility and unsupported scope do not reuse standard rules', () => {
  assert.throws(() => parseBenefitPolicyText(fixture.replace(`${lowIncome}\n${youth}\n4-2.`, `${lowIncome}\n${youth.replace('20%', '10%')}\n4-2.`), YEAR));
  assert.throws(() => parseBenefitPolicyText(fixture.replace('4-3-3. 소형·경형', '4-3-3. 중형·소형·경형'), YEAR));
});
test('HWPX reads all body sections and ignores the truncated preview', () => {
  assert.equal(parseBenefitPolicyText(extractHwpxText(document()), YEAR).rules[1].value, 20);
  const split = fixture.indexOf('4-3-1.');
  const multi = zip({ 'Contents/section0.xml': xmlFor(fixture.slice(0, split)), 'Contents/section1.xml': xmlFor(fixture.slice(split)) });
  assert.equal(parseBenefitPolicyText(extractHwpxText(multi), YEAR).rules.length, 8);
  assert.equal(parseBenefitPolicyText(extractHwpxText(zip({ 'Contents/section0.xml': xmlFor(fixture) }, 0)), YEAR).rules.length, 8);
});
test('ZIP corruption, CRC mismatch, traversal, and entry limits are rejected', () => {
  const badCrc = Buffer.from(document()); const marker = badCrc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); badCrc[marker + 16] ^= 1;
  // First directory entry is preview; corrupt the actual section checksum instead.
  const sectionMarker = badCrc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), marker + 4); badCrc[sectionMarker + 16] ^= 1;
  assert.throws(() => extractHwpxText(badCrc));
  assert.throws(() => extractHwpxText(document().subarray(0, 100)));
  assert.throws(() => extractHwpxText(zip({ '../Contents/section0.xml': xmlFor(fixture) })));
  assert.throws(() => extractHwpxText(zip(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x${i}`, 'x'])))));
  assert.throws(() => extractHwpxText(new Uint8Array(MAX_POLICY_ZIP_BYTES + 1)));
});
test('ZIP bombs and external XML entities are rejected before rule parsing', () => {
  assert.throws(() => extractHwpxText(zip({ 'Contents/section0.xml': 'x'.repeat(4 * 1024 * 1024) })));
  const undersized = Buffer.from(document()); const last = undersized.length - 22, centralAt = undersized.readUInt32LE(last + 16);
  const second = undersized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), centralAt + 4); const localAt = undersized.readUInt32LE(second + 42);
  undersized.writeUInt32LE(10, second + 24); undersized.writeUInt32LE(10, localAt + 22);
  assert.throws(() => extractHwpxText(undersized));
  assert.throws(() => extractHwpxText(zip({ 'Contents/section0.xml': '<!DOCTYPE sec [<!ENTITY xx SYSTEM="file:///secret">]>' + xmlFor(fixture) })));
  assert.throws(() => extractHwpxText(zip({ 'Contents/section0.xml': '<hs:sec>' + '<'.repeat(100_000) })));
  assert.throws(() => extractHwpxText(zip({ 'Contents/section0.xml': '<hs:sec><!--' + 'x'.repeat(100_000) })));
});

type MockOptions = { text?: string; fail?: boolean; unsupported?: boolean; unsupportedTitle?: boolean; oversizedBody?: boolean; wrongDocumentYear?: boolean; pagination?: boolean; delay?: Promise<unknown> };
function mockSource(options: MockOptions, calls: { url: string; init?: RequestInit }[]) {
  const bytes = document(options.wrongDocumentYear ? fixture.replace(`${YEAR}년`, `${YEAR - 1}년`) : options.text ?? fixture);
  const article = (id = 2) => ({ ARTC_ID: id, TITL: `${YEAR}년 전기자동차 보급사업 보조금 업무처리지침 개정`, INS_DT: `${YEAR}-01-01`, FILE_ID: `RULE${id}` });
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input); calls.push({ url, init });
    if (options.delay) await options.delay;
    if (options.fail) throw new Error('Simulated source failure');
    if (url.endsWith('selectBBSList.ajax')) {
      const page = Number(new URLSearchParams(String(init?.body)).get('spageNo'));
      const list = options.pagination && page === 1 ? Array.from({ length: 50 }, (_, i) => ({ ...article(i + 100), TITL: `${YEAR}년 수소전기자동차 보급사업 보조금 업무처리지침` })) : [{ ...article(10), TITL: `${YEAR}년 전기자동차 보급사업 보조금 업무처리지침(안)` }, { ...article(1), INS_DT: `${YEAR - 1}-12-30` }, { ...article(), ...(options.unsupportedTitle ? { TITL: `${YEAR}년 전기자동차 보급사업 보조금 업무처리지침 폐지` } : {}) }];
      return Response.json({ list, page: { _pageNo: String(page), _listCount: options.pagination ? 53 : 3 } });
    }
    if (url.endsWith('selectFileList.ajax')) return Response.json({ list: [{ FILE_NAME: `${YEAR}년 전기자동차 보급사업 보조금 업무처리지침.${options.unsupported ? 'pdf' : 'hwpx'}`, FILE_SIZE: bytes.length, FILE_MASK: 'ABCDEFGHIJKLMNOP123456' }] });
    if (!new Headers(init?.headers).get('User-Agent')) return new Response('Official Java filename handler requires User-Agent', { status: 500 });
    return new Response(options.oversizedBody ? new Uint8Array(MAX_POLICY_ZIP_BYTES + 1) : bytes as BodyInit, { headers: { 'Content-Length': String(options.oversizedBody ? MAX_POLICY_ZIP_BYTES + 1 : bytes.length) } });
  };
}
async function withSource(options: MockOptions, run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch, calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = mockSource(options, calls) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
  assert.deepEqual(getBenefitPolicyRuntimeState(), { pending: 0, active: 0, queued: 0 });
}
test('sequential policy calls refetch article, attachment, and document without caching', async () => {
  await withSource({}, async calls => {
    const first = await getBenefitPolicy(YEAR), second = await getBenefitPolicy(YEAR);
    assert.equal(first.sourceStatus, 'live'); assert.equal(second.sourceStatus, 'live'); assert.equal(calls.length, 6);
    for (const call of calls) { assert.equal(call.init?.cache, 'no-store'); assert.match(new Headers(call.init?.headers).get('Cache-Control')!, /no-store/); }
    assert.match(first.sourceUrl, /ARTC_ID=2&/); assert.equal(first.fingerprint?.length, 64);
  });
});
test('overlapping identical calls share one request pipeline and release it', async () => {
  let release!: () => void; const delay = new Promise<void>(resolve => { release = resolve; });
  await withSource({ delay }, async calls => {
    const one = getBenefitPolicy(YEAR), two = getBenefitPolicy(YEAR), three = getBenefitPolicy(YEAR);
    assert.equal(one, two); assert.equal(two, three); release();
    assert.equal((await one).sourceStatus, 'live'); await Promise.all([two, three]); assert.equal(calls.length, 3);
  });
});
test('the official attachment request identifies the app for the Java download handler', async () => {
  await withSource({}, async calls => {
    assert.equal((await getBenefitPolicy(YEAR)).sourceStatus, 'live');
    const download = calls.find(c => c.url.includes('downloadJfile.do'));
    assert.equal(new Headers(download?.init?.headers).get('User-Agent'), 'EVSubsidyFinder/1.0');
  });
});
test('new numerical values change the policy and fingerprint on the next lookup', async () => {
  let firstFingerprint: string | null = null;
  await withSource({}, async () => { firstFingerprint = (await getBenefitPolicy(YEAR)).fingerprint; });
  await withSource({ text: fixture.replaceAll('20% 추가 지원', '25% 추가 지원').replaceAll(farmer, farmer.replace('10%', '12%')).replace('’26.12.31.', '’27.6.30.') }, async () => {
    const result = await getBenefitPolicy(YEAR); assert.equal(result.sourceStatus, 'live'); assert.equal(result.rules[1].value, 25); assert.notEqual(result.fingerprint, firstFingerprint);
    assert.equal(result.rules.find(r => r.id === 'lowIncomePassenger')?.value, 25);
    assert.equal(result.rules.find(r => r.id === 'farmer')?.value, 12);
    assert.equal(result.reviewRules?.find(r => r.id === 'oldEv')?.expiresOn, '2027-06-30');
  });
});
test('a failed refresh never returns prior successful rules and retries immediately', async () => {
  await withSource({}, async () => assert.equal((await getBenefitPolicy(YEAR)).sourceStatus, 'live'));
  await withSource({ fail: true }, async () => {
    const result = await getBenefitPolicy(YEAR); assert.equal(result.sourceStatus, 'unavailable'); assert.equal(result.checkedAt, null); assert.deepEqual(result.rules, []); assert.deepEqual(result.reviewRules ?? [], []);
  });
  await withSource({}, async () => assert.equal((await getBenefitPolicy(YEAR)).sourceStatus, 'live'));
});
test('unsupported format, altered eligibility, and wrong document year cannot authorize extras', async () => {
  for (const options of [{ unsupported: true }, { unsupportedTitle: true }, { oversizedBody: true }, { wrongDocumentYear: true }, { text: fixture.replaceAll('생애 첫 자동차', '생애 첫 전기차') }, { text: fixture.replace(farmerCondition, farmerCondition.replace('제출받아 확인', '제출 생략')) }, { text: fixture.replace(oldEv, oldEv.replace('업데이트가 불가능한 차량에 한함', '모든 차량')) }]) {
    await withSource(options, async () => { const result = await getBenefitPolicy(YEAR); assert.equal(result.sourceStatus, 'unavailable'); assert.deepEqual(result.rules, []); assert.deepEqual(result.reviewRules ?? [], []); });
  }
});
test('mismatched request year is rejected without any network request', async () => {
  await withSource({}, async calls => { assert.equal((await getBenefitPolicy(YEAR - 1)).sourceStatus, 'unavailable'); assert.equal(calls.length, 0); });
});
test('guide discovery follows pages and excludes hydrogen and draft documents', async () => {
  await withSource({ pagination: true }, async calls => { const result = await getBenefitPolicy(YEAR); assert.equal(result.sourceStatus, 'live'); assert.equal(calls.length, 4); assert.match(result.sourceUrl, /ARTC_ID=2&/); });
});
test('overall deadline aborts a stalled lookup, releases it, and permits a fresh retry', async () => {
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>(); let aborted = false;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = originalTimeout(() => { timers.delete(handle); callback(...args); }, ms === 18_000 ? 0 : ms);
    timers.add(handle); return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => { timers.delete(handle); originalClear(handle); }) as typeof clearTimeout;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(init?.signal?.reason); };
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
  })) as typeof fetch;
  try {
    const result = await getBenefitPolicy(YEAR);
    assert.equal(result.sourceStatus, 'unavailable'); assert.equal(aborted, true); assert.equal(timers.size, 0);
    assert.deepEqual(getBenefitPolicyRuntimeState(), { pending: 0, active: 0, queued: 0 });
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
  await withSource({}, async () => assert.equal((await getBenefitPolicy(YEAR)).sourceStatus, 'live'));
});
