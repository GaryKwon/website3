import { freshRequestOptions, freshRequestHeaders, readBoundedText } from './upstream';
/** Read public server-rendered EV subsidy data. No third-party JavaScript is executed. */
export type VehicleType = 'passenger' | 'cargo';
export type OfficialRow = Record<string, unknown>;
export interface ParsedOfficialData {
  rows: OfficialRow[];
  choiceRows: OfficialRow[];
  finishRows: OfficialRow[];
  stepRows: OfficialRow[];
  periodRows: OfficialRow[];
  pageInfo: Record<string, unknown>;
  envelopeDecoded: boolean;
}
export interface OfficialData extends ParsedOfficialData {
  sourceUrl: string;
  checkedAt: string;
  fingerprint: string;
  year: number;
}
export type OfficialDataset = OfficialData;
const SOURCE = 'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do';
const DECODER_SOURCE = 'https://ev.or.kr/nportal/js/pnp4web/pnp4web.js?v=20190219';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Public alphabets observed in the site's shipped PNP4WEB renderer, 2026-10-29 UTC.
// Kept so an unavailable ancillary script does not turn valid public HTML into missing data.
const KNOWN_ALPHABETS = [
  'QRST0123ABCDEFGHIJKLUVWXcdefghijklmnopqrMNOPstuvYZabwxyz456789+/',
  'QRSTABCDEFGHIJKLUVWXYZabcdefghijklmnopqrMNOPstuvwxyz0123456789+/',
  'EFGHABCDMNOPIJKLQRSTUVWXcdefYZabghijklmnstuvwxyzopqr012389+/4567',
  'QRSTEFGHMNOPIJKLABCDUVWXYZabghij89+/klmnstuvwxyzopqrcdef01234567',
  'QRSTMNOPIJKLABCDUVWXYZabEFGH89+/klmnstuvghijopqrcdefwxyz45670123',
  'IJKLQRSTYZabMNOPABCDUVWXEFGHklmnstuv4567ghijopqrcdef89+/wxyz0123',
  'IJKLYZabMNOP89+/UVWXEFGHklmnstuvABCD4567ghijopqrcdefwxyzQRST0123',
];
let cachedDecoder: { text: string; until: number } | undefined;

function extractAlphabets(source: string): string[] {
  // Restrict extraction to literal hex strings and In[n] addition. Never eval source.
  const arrayText = source.match(/\bIn=(\[[\s\S]*?\]),zn=/)?.[1];
  if (!arrayText || !/^\[(?:"(?:\\x[0-9a-f]{2})*",?)+\]$/i.test(arrayText)) {
    throw new Error('공식 페이지 문자표 형식이 변경되었습니다.');
  }
  const literals: string[] = [];
  for (const match of arrayText.matchAll(/"((?:\\x[0-9a-f]{2})*)"/gi)) {
    literals.push(match[1].replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  }
  return Array.from({ length: 7 }, (_, index) => {
    const expression = source.match(new RegExp('o' + index + ':([\\s\\S]*?)(?:,o|,dc)'))?.[1];
    if (!expression || !/^In\[\d+\](?:\+In\[\d+\])*$/.test(expression)) {
      throw new Error('공식 페이지 문자표를 확인할 수 없습니다.');
    }
    const alphabet = [...expression.matchAll(/In\[(\d+)\]/g)].map(m => literals[Number(m[1])] ?? '').join('');
    if (alphabet.length !== 64 || new Set(alphabet).size !== 64 || [...alphabet].some(c => !STANDARD.includes(c))) {
      throw new Error('공식 페이지 문자표가 유효하지 않습니다.');
    }
    return alphabet;
  });
}

function decodeEnvelope(payload: string, decoderSource?: string): string {
  if (!/^[0-6][0-9][A-Za-z0-9+/=]+$/.test(payload) || payload.length > 6_000_000) {
    throw new Error('공식 페이지 데이터 형식이 변경되었습니다.');
  }
  const alphabets = decoderSource ? extractAlphabets(decoderSource) : KNOWN_ALPHABETS;
  const alphabet = alphabets[Number(payload[0])];
  const offset = Number(payload[1]);
  const rotated = alphabet.slice(offset) + alphabet.slice(0, offset);
  const translation=new Uint8Array(128);
  for(let i=0;i<rotated.length;i++) translation[rotated.charCodeAt(i)]=STANDARD.charCodeAt(i);
  translation[61]=61;
  const length=payload.length-2;
  const paddedLength=length+(4-length%4)%4;
  const encoded=new Uint8Array(paddedLength);
  encoded.fill(61);
  for(let i=0;i<length;i++) encoded[i]=translation[payload.charCodeAt(i+2)];
  const binary=atob(new TextDecoder().decode(encoded));
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function jsonBlock(html: string, id: string, required = true): unknown {
  const pattern = new RegExp('<script\\b(?=[^>]*\\bid=["\\\']' + id + '["\\\'])[^>]*>([\\s\\S]*?)<\\/script\\s*>', 'i');
  const raw = html.match(pattern)?.[1];
  if (!raw) {
    if (!required) return [];
    throw new Error('공식 페이지의 ' + id + ' 데이터를 찾을 수 없습니다.');
  }
  try { return JSON.parse(raw); }
  catch {
    // Mirrors the official renderer's control-character normalization only.
    try { return JSON.parse(raw.replace(/[\u0000-\u001F]+/g, ' ')); }
    catch { throw new Error('공식 페이지의 JSON 데이터를 읽을 수 없습니다.'); }
  }
}
function rowBlock(html: string, id: string): OfficialRow[] {
  const data = jsonBlock(html, id);
  if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('공식 페이지 목록의 구조가 변경되었습니다.');
  }
  return data;
}

export function decodeOfficialDocument(html: string, decoderSource?: string): string {
  if (html.length > 6_000_000) throw new Error('공식 페이지 응답이 너무 큽니다.');
  const wrapper = html.match(/\b_0xac\("([A-Za-z0-9+/=]+)"\)/);
  return wrapper ? decodeEnvelope(wrapper[1], decoderSource) : html;
}

export function parseOfficialHtml(html: string, decoderSource?: string): ParsedOfficialData {
  const wrapper = html.match(/\b_0xac\("([A-Za-z0-9+/=]+)"\)/);
  const envelopeDecoded = Boolean(wrapper);
  const decoded = decodeOfficialDocument(html, decoderSource);
  const pageInfo = jsonBlock(decoded, 'pageInfo');
  if (!pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) {
    throw new Error('공식 페이지 조회 조건을 확인할 수 없습니다.');
  }
  const rows = rowBlock(decoded, 'localListData');
  if (!rows.length || rows.some(row => typeof row.LOCAL_CD !== 'string' || typeof row.LOCAL_NM !== 'string')) {
    throw new Error('공식 페이지에 유효한 지자체 데이터가 없습니다.');
  }
  return {
    rows,
    choiceRows: rowBlock(decoded, 'choiceListData'),
    finishRows: rowBlock(decoded, 'finishListData'),
    stepRows: rowBlock(decoded, 'stepListData'),
    periodRows: rowBlock(decoded, 'periodListData'),
    pageInfo: pageInfo as Record<string, unknown>,
    envelopeDecoded,
  };
}

export async function fingerprintOfficialData(data: ParsedOfficialData): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify({
    rows: data.rows,
    choiceRows: data.choiceRows,
    finishRows: data.finishRows,
    stepRows: data.stepRows,
    periodRows: data.periodRows,
    pageInfo: data.pageInfo,
  }));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchOfficialData(type: VehicleType, year: number): Promise<OfficialData> {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('조회 연도가 유효하지 않습니다.');
  const carType = type === 'passenger' ? '11' : type === 'cargo' ? '12' : '';
  if (!carType) throw new Error('조회 차종이 유효하지 않습니다.');
  const url = new URL(SOURCE);
  url.search = new URLSearchParams({ year1: String(year), car_type: carType, localDo_cd: 'all', local_cd1: 'all' }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const pagePromise = fetch(url.toString(), {
      ...freshRequestOptions,
      signal: controller.signal,
      headers: { ...freshRequestHeaders, Accept: 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      redirect: 'follow',
    }).then(async response => {
      if (!response.ok) {
        try {await response.body?.cancel();} catch {}
        throw new Error('공식 페이지 응답: '+response.status);
      }
      return readBoundedText(response,3_000_000);
    });
    const decoderPromise = cachedDecoder && cachedDecoder.until > Date.now()
      ? Promise.resolve(cachedDecoder.text)
      : fetch(DECODER_SOURCE, { signal: controller.signal }).then(async response => {
          if (!response.ok) return undefined;
          const text=await readBoundedText(response,1_000_000);
          extractAlphabets(text);
          cachedDecoder = { text, until: Date.now() + 24 * 60 * 60 * 1000 };
          return text;
        }).catch(() => undefined);
    const [html, decoder] = await Promise.all([pagePromise, decoderPromise]);
    const parsed = parseOfficialHtml(html, decoder);
    if (String(parsed.pageInfo.carType) !== carType || String(parsed.pageInfo.year1) !== String(year)) {
      throw new Error('공식 페이지의 응답 차종 또는 연도가 조회 조건과 다릅니다.');
    }
    if (parsed.rows.some(row => String(row.YEAR) !== String(year))) throw new Error('공식 데이터 연도가 일치하지 않습니다.');
    return { ...parsed, sourceUrl: url.toString(), checkedAt: new Date().toISOString(), fingerprint: await fingerprintOfficialData(parsed), year };
  } finally { clearTimeout(timeout);controller.abort(); }
}
