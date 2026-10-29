import { inflateRawSync } from 'node:zlib';
import type { BenefitRule } from './benefit-types';

export const MAX_POLICY_ZIP_BYTES = 4 * 1024 * 1024;
const MAX_SECTION_BYTES = 3 * 1024 * 1024;
const MAX_SECTION_TOTAL = 8 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function requirePolicy(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Decode only predefined/numeric XML entities; external/custom entities are unsupported. */
export function decodePolicyEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&([^;\s]{1,24});/g, (_all, entity: string) => {
    if (named[entity] !== undefined) return named[entity];
    requirePolicy(/^#(?:\d+|x[0-9a-f]+)$/i.test(entity), '지원하지 않는 문서 문자 참조입니다.');
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    requirePolicy(Number.isInteger(point) && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) && (point >= 32 || point === 9 || point === 10 || point === 13), '유효하지 않은 문서 문자입니다.');
    return String.fromCodePoint(point);
  });
}

function sectionParagraphs(xml: string): string[] {
  requirePolicy(!/<!\s*(?:DOCTYPE|ENTITY|\[CDATA\[)/i.test(xml), '외부 엔터티 또는 지원하지 않는 XML 형식입니다.');
  requirePolicy(/<(?:[\w]+:)?sec\b/.test(xml), 'HWPX 본문 XML이 아닙니다.');
  const tags: string[] = [];
  const paragraphs: { chunks: string[]; length: number; depth: number }[] = [];
  const active: typeof paragraphs = [];
  let inText = 0;
  let consumed = 0;
  while (consumed < xml.length) {
    const start = consumed;
    let value: string;
    if (xml[start] !== '<') {
      const next = xml.indexOf('<', start);
      consumed = next < 0 ? xml.length : next;
      value = xml.slice(start, consumed);
    } else if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      requirePolicy(end >= 0, '끝나지 않은 XML 주석입니다.'); consumed = end + 3; continue;
    } else if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      requirePolicy(end >= 0 && end - start <= 32 * 1024, '지원하지 않는 XML 선언입니다.'); consumed = end + 2; continue;
    } else {
      requirePolicy(!xml.startsWith('<!', start), '지원하지 않는 XML 선언입니다.');
      let at = start + 1, quote = '';
      for (; at < xml.length; at++) {
        requirePolicy(at - start <= 32 * 1024, 'XML 태그 크기 제한을 초과했습니다.');
        const character = xml[at];
        if (quote) { if (character === quote) quote = ''; }
        else if (character === '"' || character === "'") quote = character;
        else if (character === '>') break;
        else requirePolicy(character !== '<', '중첩된 XML 태그 구분자입니다.');
      }
      requirePolicy(at < xml.length && !quote, '끝나지 않은 XML 태그입니다.');
      consumed = at + 1; value = xml.slice(start, consumed);
    }
    if (!value.startsWith('<')) {
      if (inText && active.length) {
        const paragraph = active[active.length - 1];
        const decoded = decodePolicyEntities(value);
        paragraph.length += decoded.length;
        requirePolicy(paragraph.length <= 256 * 1024, '문단 크기 제한을 초과했습니다.');
        paragraph.chunks.push(decoded);
      }
      continue;
    }
    const match = /^<(\/)?([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?(\/?)>$/.exec(value);
    requirePolicy(match, '지원하지 않는 XML 태그입니다.');
    const [, closing, name] = match;
    const selfClosing = value.endsWith('/>');
    const local = name.split(':').at(-1);
    if (closing) {
      requirePolicy(tags.pop() === name, 'XML 태그 순서가 일치하지 않습니다.');
      if (local === 't') inText--;
      if (local === 'p') requirePolicy(active.pop()?.depth === tags.length + 1, 'XML 문단 순서가 일치하지 않습니다.');
    } else if (!selfClosing) {
      tags.push(name);
      requirePolicy(tags.length <= 128, 'XML 중첩 제한을 초과했습니다.');
      if (local === 't') inText++;
      if (local === 'p') {
        requirePolicy(paragraphs.length < 20_000, '문단 수 제한을 초과했습니다.');
        const paragraph = { chunks: [] as string[], length: 0, depth: tags.length };
        paragraphs.push(paragraph); active.push(paragraph);
      }
    } else if (local === 'lineBreak' && inText && active.length) {
      active[active.length - 1].chunks.push(' ');
    }
  }
  requirePolicy(consumed === xml.length && tags.length === 0 && active.length === 0 && inText === 0, '완전한 XML 문서가 아닙니다.');
  return paragraphs.map(p => p.chunks.join('').normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Read all HWPX body sections, never the incomplete Preview/PrvText.txt. */
export function extractHwpxText(bytes: Uint8Array): string {
  requirePolicy(bytes.byteLength >= 22 && bytes.byteLength <= MAX_POLICY_ZIP_BYTES, '지침 파일 크기 제한을 초과했습니다.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  requirePolicy(end >= 0, 'ZIP 끝부분이 없습니다.');
  const count = view.getUint16(end + 10, true);
  const directoryBytes = view.getUint32(end + 12, true);
  const directoryAt = view.getUint32(end + 16, true);
  requirePolicy(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0 && view.getUint16(end + 8, true) === count, '분할 ZIP은 지원하지 않습니다.');
  requirePolicy(count > 0 && count <= 64 && directoryAt + directoryBytes === end, 'ZIP 항목 또는 디렉터리 크기가 유효하지 않습니다.');
  const names = new Set<string>();
  const intervals: { start: number; end: number }[] = [];
  const sections: { number: number; text: string }[] = [];
  let at = directoryAt, declaredTotal = 0, sectionTotal = 0;
  for (let i = 0; i < count; i++) {
    requirePolicy(at + 46 <= end && view.getUint32(at, true) === 0x02014b50, 'ZIP 항목이 손상되었습니다.');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true), compressed = view.getUint32(at + 20, true), expanded = view.getUint32(at + 24, true);
    const nameBytes = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true), next = at + 46 + nameBytes + extra + comment;
    requirePolicy(next <= end && nameBytes > 0 && nameBytes <= 512 && !(flags & 1) && (method === 0 || method === 8), '지원하지 않는 ZIP 항목입니다.');
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameBytes));
    requirePolicy(!names.has(name) && !name.includes('\0') && !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), '안전하지 않은 ZIP 경로입니다.'); names.add(name);
    declaredTotal += expanded;
    requirePolicy(declaredTotal <= MAX_ARCHIVE_TOTAL && compressed <= MAX_POLICY_ZIP_BYTES && localAt + 30 <= directoryAt, 'ZIP 해제 크기 제한을 초과했습니다.');
    requirePolicy(view.getUint32(localAt, true) === 0x04034b50 && view.getUint16(localAt + 6, true) === flags && view.getUint16(localAt + 8, true) === method, 'ZIP 로컬 헤더가 일치하지 않습니다.');
    const localNameLength = view.getUint16(localAt + 26, true), localExtraLength = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLength + localExtraLength, finish = start + compressed;
    requirePolicy(start <= directoryAt && finish <= directoryAt && utf8.decode(bytes.subarray(localAt + 30, localAt + 30 + localNameLength)) === name, 'ZIP 데이터 범위가 유효하지 않습니다.');
    requirePolicy(!intervals.some(r => localAt < r.end && finish > r.start), 'ZIP 데이터 범위가 겹칩니다.'); intervals.push({ start: localAt, end: finish });
    if (!(flags & 8)) requirePolicy(view.getUint32(localAt + 14, true) === crc && view.getUint32(localAt + 18, true) === compressed && view.getUint32(localAt + 22, true) === expanded, 'ZIP 파일 크기 또는 CRC가 일치하지 않습니다.');
    const section = /^Contents\/section(\d+)\.xml$/.exec(name);
    if (section) {
      sectionTotal += expanded;
      requirePolicy(expanded > 0 && expanded <= MAX_SECTION_BYTES && sectionTotal <= MAX_SECTION_TOTAL && sections.length < 16, '본문 해제 크기 제한을 초과했습니다.');
      const data = bytes.subarray(start, finish);
      let phase = 'inflate';
      try {
        // Workers' native inflater needs a small output-work-buffer allowance
        // for some valid streams. It remains bounded; exact ZIP size and CRC
        // are checked below before any XML is parsed or retained.
        const output = method === 0 ? data : inflateRawSync(data, { maxOutputLength: expanded + 64 * 1024 });
        phase = 'crc';
        requirePolicy(output.length === expanded && crc32(output) === crc, '본문 CRC 또는 크기가 일치하지 않습니다.');
        phase = 'utf8';
        const xml = utf8.decode(output);
        phase = 'xml';
        sections.push({ number: Number(section[1]), text: sectionParagraphs(xml).join('\n') });
      } catch (error) { throw new Error(`HWPX ${name} ${phase}: ${error instanceof Error ? error.message : '본문 처리 실패'}`); }
    }
    at = next;
  }
  requirePolicy(at === end && sections.length > 0, 'HWPX 본문을 찾을 수 없습니다.');
  sections.sort((a, b) => a.number - b.number);
  requirePolicy(sections.every((s, i) => s.number === i), 'HWPX 본문 순서가 유효하지 않습니다.');
  return sections.map(s => s.text).join('\n');
}

type ParsedBenefitPolicy = { rules: BenefitRule[]; sharedFunding: boolean; additivePercentages: boolean; fixedAfterPercentages: boolean };
const compact = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
const money = (s: string) => Number(s.replace(/,/g, ''));
function positive(value: number, max = 10_000): number {
  requirePolicy(Number.isFinite(value) && value > 0 && value <= max, '지원 금액 또는 비율 범위를 확인해야 합니다.'); return value;
}

/** Parse supported normative clauses. Unknown eligibility, scope, or stacking changes disable calculation. */
export function parseBenefitPolicyText(text: string, year: number): ParsedBenefitPolicy {
  requirePolicy(text.length <= MAX_SECTION_TOTAL, '지침 텍스트가 너무 큽니다.');
  const ps = text.split(/\r?\n/).map(s => s.normalize('NFKC').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cs = ps.map(compact);
  requirePolicy(cs.slice(0, 60).join('').includes(`「${year}년전기자동차보급사업」보조금업무처리지침`), '지침 연도 또는 문서 종류가 일치하지 않습니다.');
  const header = (value: string) => { const indices = cs.flatMap((s, i) => s === value ? [i] : []); requirePolicy(indices.length === 1, '지침 차종 구성을 확인해야 합니다.'); return indices[0]; };
  const passengerCommon = header('4-1-1.공통사항(중·대형,소형,초소형)');
  const passengerStandard = header('4-1-2.중·대형,소형');
  const passengerMicro = header('4-1-3.초소형');
  const bus = cs.findIndex((s, i) => i > passengerMicro && s.startsWith('4-2.전기승합차'));
  const cargoCommon = header('4-3-1.공통사항(대형,중형,소형,경형,초소형)');
  const cargoMedium = header('4-3-2.대형·중형');
  const cargoSmall = header('4-3-3.소형·경형');
  const cargoMicro = header('4-3-4.초소형');
  const end = cs.findIndex((s, i) => i > cargoMicro && s.startsWith('5.보조금집행절차'));
  requirePolicy(passengerCommon < passengerStandard && passengerStandard < passengerMicro && passengerMicro < bus && bus < cargoCommon && cargoCommon < cargoMedium && cargoMedium < cargoSmall && cargoSmall < cargoMicro && cargoMicro < end, '지침 차종 순서가 바뀌었습니다.');
  for (const [pattern, expected] of [[/^○청년/, 2], [/^○다자녀/, 1], [/^○전기택시/, 1], [/^○택배용차량/, 2], [/^○(?:소상공인|차상위이하계층에해당하는개인,소상공인)/, 2]] as const) {
    requirePolicy(cs.filter(s => pattern.test(s)).length === expected, '지원 조항의 자격 또는 적용 범위가 추가·변경되었습니다.');
  }
  const sharing = '○지방자치단체는차종별국비보조금산정수준에비례하여지방비보조금을차종별로차등적으로산정해야하며,구매자특성에따른추가지원금의경우도국비와지방비비율에따라분담하여지원되도록해야함';
  requirePolicy(cs.slice(passengerCommon, passengerStandard).includes(sharing) && cs.slice(cargoCommon, cargoMedium).includes(sharing), '추가 지원금 분담 규칙이 바뀌었습니다.');
  requirePolicy(cs.slice(passengerCommon, passengerStandard).includes('○구매자특성에따른추가지원금은중복지원가능.단,정액지원(예:다자녀가구지원등)금액은일정비율(%)추가지원금액을산정한이후마지막에더하도록함'), '승용 중복 또는 정액 지원 순서를 확인해야 합니다.');
  requirePolicy(cs.slice(cargoCommon, cargoMedium).includes('○구매자특성에따른추가지원은중복지원가능'), '화물 중복 지원 규칙이 바뀌었습니다.');
  const block = (start: number, stop: number, needle: string) => {
    const indices = cs.flatMap((s, i) => i >= start && i < stop && s.startsWith(needle) ? [i] : []);
    requirePolicy(indices.length === 1, '추가 지원 조항이 누락되거나 중복되었습니다.');
    const begin = indices[0]; let finish = begin + 1;
    while (finish < stop && !cs[finish].startsWith('○') && !/^\d+-\d+-\d+\./.test(cs[finish])) finish++;
    return { values: cs.slice(begin, finish), clause: ps.slice(begin, finish).join(' '), index: begin };
  };
  const youthPattern = /^○청년\(「청년기본법」제3조에따라(\d+)세이상(\d+)세이하인사람\)에해당하는개인이생애첫자동차로전기차를구매하는경우국비지원액의(\d+(?:\.\d+)?)%추가지원$/;
  const youth = block(passengerStandard, passengerMicro, '○청년('), microYouth = block(passengerMicro, bus, '○청년(');
  const y = youth.values[0].match(youthPattern);
  requirePolicy(y && youth.values.length === 1 && microYouth.values.length === 1 && microYouth.values[0] === youth.values[0], '청년 추가 지원 자격 또는 차종 범위가 바뀌었습니다.');
  const minAge = positive(Number(y[1]), 100), maxAge = positive(Number(y[2]), 100), youthRate = positive(Number(y[3]), 100);
  requirePolicy(minAge <= maxAge && minAge >= 18, '청년 나이 기준을 확인해야 합니다.');
  const child = block(passengerStandard, passengerMicro, '○다자녀가구(');
  const c = child.values[0].match(/^○다자녀가구\((\d+)세이하자녀2명이상\)에해당하는개인이구매시자녀수에따라최대([\d,]+)만원\*?추가지원$/);
  const amounts = child.values[1]?.match(/^\*\(2자녀\)([\d,]+)만원,\(3자녀\)([\d,]+)만원,\(4자녀이상\)([\d,]+)만원$/);
  requirePolicy(c && amounts && child.values.length === 2 && !cs.slice(passengerMicro, bus).some(s => s.startsWith('○다자녀')), '다자녀 자격·금액 또는 차종 범위가 바뀌었습니다.');
  const childAge = positive(Number(c[1]), 30), childAmounts = { 2: positive(money(amounts[1])), 3: positive(money(amounts[2])), 4: positive(money(amounts[3])) };
  requirePolicy(childAmounts[2] <= childAmounts[3] && childAmounts[3] <= childAmounts[4] && childAmounts[4] === money(c[2]), '다자녀 지원 한도가 일치하지 않습니다.');
  const business = block(cargoSmall, cargoMicro, '○차상위이하계층에해당하는개인,소상공인');
  const microBusiness = block(cargoMicro, end, '○차상위이하계층에해당하는개인,소상공인');
  const b = business.values[0].match(/^○차상위이하계층에해당하는개인,소상공인이구매시해당차량국비지원액의(\d+(?:\.\d+)?)%추가지원$/);
  requirePolicy(b && business.values.length === 1 && microBusiness.values.length === 1 && business.values[0] === microBusiness.values[0], '소상공인 자격 또는 차종 범위가 바뀌었습니다.');
  const businessRate = positive(Number(b[1]), 100);
  const delivery = block(cargoSmall, cargoMicro, '○택배용차량'), microDelivery = block(cargoMicro, end, '○택배용차량');
  const d = delivery.values[0].match(/^○택배용차량\*?으로전기화물차구매시국비지원액의(\d+(?:\.\d+)?)%추가지원$/);
  const deliveryCondition = '*「화물자동차법」제2조제3호에따른운송사업중화물을집화·분류·배송하는형태의운송사업에사용되는자동차';
  requirePolicy(d && delivery.values.length === 2 && delivery.values[1] === deliveryCondition && microDelivery.values.join('\n') === delivery.values.join('\n'), '택배 추가 지원 자격 또는 차종 범위가 바뀌었습니다.');
  const deliveryRate = positive(Number(d[1]), 100);
  const additiveExample = cs.slice(cargoCommon, cargoMedium).some(s => {
    const m = s.match(/^※\(계산예시\)소상공인이택배용차량으로국비보조금([\d,]+)만원인소형전기화물차를구매하는경우:([\d,]+)만원\+([\d,]+)만원×(\d+(?:\.\d+)?)%\+([\d,]+)만원×(\d+(?:\.\d+)?)%=([\d,]+)만원지급$/);
    return m && money(m[1]) === money(m[2]) && money(m[2]) === money(m[3]) && money(m[3]) === money(m[5]) && Number(m[4]) === businessRate && Number(m[6]) === deliveryRate && Math.abs(money(m[7]) - money(m[1]) * (1 + businessRate / 100 + deliveryRate / 100)) < .0001;
  });
  requirePolicy(additiveExample, '비율 추가 지원의 합산 기준이 확인되지 않습니다.');
  const taxi = block(passengerStandard, passengerMicro, '○전기택시에대해서는');
  const t = taxi.values[0].match(/^○전기택시에대해서는해당차량보조금에([\d,]+)만원추가지원\*?$/);
  requirePolicy(t && taxi.values.length === 3 && taxi.values[1] === '*구매자가택시사업자면허를가진경우추가지원(증빙자료로면허증사본제출),택시법인에대해서는중소기업이구매하는경우에한정하여추가지원' && taxi.values[2] === '※지역별이동여건을고려하여법인(중소기업한정)의전기택시구매에대해재지원제한기간적용없이지자체보조가능' && !cs.slice(passengerMicro, bus).some(s => s.startsWith('○전기택시')), '택시 지원 자격 또는 차종 범위가 바뀌었습니다.');
  const rules: BenefitRule[] = [
    { id: 'children', label: '다자녀', kind: 'children', value: childAmounts[4], childAmounts, scope: 'passenger-standard', requirement: `${childAge}세 이하 자녀 2명 이상 · 개인 구매자`, clause: child.clause },
    { id: 'youth', label: '청년 생애 첫 자동차', kind: 'percent', value: youthRate, scope: 'passenger-all', requirement: `${minAge}~${maxAge}세 개인 · 생애 첫 자동차로 전기차 구매`, clause: youth.clause },
    { id: 'smallBusiness', label: '소상공인', kind: 'percent', value: businessRate, scope: 'cargo-small-light-micro', requirement: '소상공인 자격 및 지자체 증빙서류 확인 필요', clause: business.clause },
    { id: 'delivery', label: '택배용 차량', kind: 'percent', value: deliveryRate, scope: 'cargo-small-light-micro', requirement: '화물을 집화·분류·배송하는 법정 운송사업용 자동차', clause: delivery.clause },
    { id: 'taxi', label: '전기택시', kind: 'fixed', value: positive(money(t[1])), scope: 'passenger-standard', requirement: '택시사업자 면허 · 법인택시는 중소기업 한정', clause: taxi.clause },
  ];
  return { rules, sharedFunding: true, additivePercentages: true, fixedAfterPercentages: true };
}
