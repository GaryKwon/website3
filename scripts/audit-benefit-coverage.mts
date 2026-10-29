/** Read-only audit: notice connectivity is not a semantic verification of local monetary rules. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOfficialData, type VehicleType } from '../lib/official-source';
import { normalizeDataset } from '../lib/subsidies';
import { regions } from '../lib/regions';
import { localBenefitInfo, localBenefitSignals } from '../lib/local-benefit-source';
import { extractHwpxText } from '../lib/benefit-policy-parser';
import { freshRequestHeaders, freshRequestOptions } from '../lib/upstream';
import type { LocalBenefitNotice } from '../lib/benefit-types';

const year=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
const output=path.resolve(process.env.BENEFIT_AUDIT_OUTPUT || '../../outputs/benefit-coverage-verification.json');
const metadataOnly=process.argv.includes('--metadata-only');
const MAX_BYTES=4*1024*1024;
const expected=regions.filter(region=>!region.children?.length&&/^\d{4,5}$/.test(region.id));
type AttachmentResult={code:string;url:string;status:'retrieved'|'unavailable'|'oversized';httpStatus?:number;filename?:string;type?:string;bytes?:number;fingerprint?:string;textCharacters?:number;signals?:ReturnType<typeof localBenefitSignals>;message?:string;monetaryRuleReview:'not-completed'};
type CoverageRow={regionId:string;region:string;vehicleType:VehicleType;year:number;checkedAt:string;sourceUrl:string;noticeCount:number;notices:LocalBenefitNotice[];noticeSignals:ReturnType<typeof localBenefitSignals>;attachmentResults:AttachmentResult[];monetaryRuleReview:'not-completed'};

async function readBytes(response:Response):Promise<Uint8Array> {
  const declared=Number(response.headers.get('Content-Length'));
  if(Number.isFinite(declared)&&declared>MAX_BYTES){await response.body?.cancel();throw new RangeError('Attachment exceeds 4 MiB.');}
  if(!response.body)throw new Error('Empty attachment body.');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const result=await reader.read();if(result.done)break;length+=result.value.byteLength;if(length>MAX_BYTES)throw new RangeError('Attachment exceeds 4 MiB.');chunks.push(result.value);}const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;}
  catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
}

async function probe(notice:LocalBenefitNotice):Promise<AttachmentResult> {
  const result:AttachmentResult={code:notice.code,url:notice.downloadUrl,status:'unavailable',monetaryRuleReview:'not-completed'};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12_000);
  try {
    const response=await fetch(notice.downloadUrl,{...freshRequestOptions,headers:{...freshRequestHeaders,Accept:'application/octet-stream,*/*',Referer:'https://ev.or.kr/nportal/buySupprt/initSubsidyPaymentCheckAction.do','User-Agent':'Mozilla/5.0 (compatible; EVONSubsidyVerifier/1.0)'},redirect:'follow',signal:controller.signal});
    result.httpStatus=response.status;
    if(!response.ok){await response.body?.cancel();throw new Error(`HTTP ${response.status}`);}
    const final=new URL(response.url);if(!['ev.or.kr','www.ev.or.kr'].includes(final.hostname)||final.protocol!=='https:'){await response.body?.cancel();throw new Error('Unrecognized attachment host.');}
    const disposition=response.headers.get('Content-Disposition')??'';
    if(!/attachment\b/i.test(disposition)){await response.body?.cancel();throw new Error('Missing attachment header; HTTP 200 may be an error page.');}
    const bytes=await readBytes(response);if(bytes.length<8)throw new Error('Attachment is empty.');
    let filename=disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i)?.[1]??'';
    try{filename=decodeURIComponent(filename);}catch{}
    const magic=Buffer.from(bytes.subarray(0,8));
    const isPdf=magic.subarray(0,5).toString()==='%PDF-';
    const isHwp=magic.equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
    const isZip=magic.readUInt32LE(0)===0x04034b50;
    if(!isPdf&&!isHwp&&!isZip)throw new Error('Unrecognized binary file type.');
    Object.assign(result,{status:'retrieved',filename:filename.slice(0,500),bytes:bytes.length,type:isPdf?'PDF':isHwp?'HWP':'ZIP',fingerprint:createHash('sha256').update(bytes).digest('hex')});
    if(isZip)try{const text=extractHwpxText(bytes);Object.assign(result,{type:'HWPX',textCharacters:text.length,signals:localBenefitSignals(text)});}catch(error){result.message=`Binary retrieved; text extraction needs review: ${error instanceof Error?error.message:String(error)}`;}
    else result.message='Binary retrieved; HWP/PDF monetary clauses require a separate document review.';
    return result;
  } catch(error){if(error instanceof RangeError)result.status='oversized';result.message=error instanceof Error?error.message:String(error);return result;}
  finally{clearTimeout(timer);controller.abort();}
}

const rows:CoverageRow[]=[];
const sources:{vehicleType:VehicleType;sourceUrl:string;checkedAt:string;fingerprint:string}[]=[];
for(const vehicleType of ['passenger','cargo'] as const){
  const dataset=await fetchOfficialData(vehicleType,year);
  const financial=dataset.rows.filter(row=>row.LOCAL_CD!=='9999');
  if(financial.length!==expected.length||new Set(financial.map(row=>row.LOCAL_CD)).size!==expected.length)throw new Error(`Authority coverage mismatch: ${vehicleType}`);
  for(const authority of expected){const matches=financial.filter(row=>row.LOCAL_CD===authority.id);if(matches.length!==1||matches[0].LOCAL_NM!==authority.name||Number(matches[0].YEAR)!==year)throw new Error(`Invalid authority/year/name: ${vehicleType} ${authority.id}`);}
  const records=normalizeDataset(dataset,vehicleType,year);
  for(const record of records){const info=localBenefitInfo(record,{regionId:record.regionId,vehicleType,year,sourceStatus:'live',checkedAt:dataset.checkedAt});if(info.sourceStatus!=='live')throw new Error(`Unverified notice index: ${vehicleType} ${record.regionId}`);rows.push({regionId:record.regionId,region:record.region,vehicleType,year,checkedAt:dataset.checkedAt,sourceUrl:info.sourceUrl,noticeCount:info.notices.length,notices:info.notices,noticeSignals:info.signals,attachmentResults:[],monetaryRuleReview:'not-completed'});}
  sources.push({vehicleType,sourceUrl:dataset.sourceUrl,checkedAt:dataset.checkedAt,fingerprint:dataset.fingerprint});
}
const tasks=rows.filter(row=>row.notices.length);let next=0,completed=0;
if(!metadataOnly)await Promise.all(Array.from({length:2},async()=>{
  while(next<tasks.length){const row=tasks[next++];const sorted=[...row.notices].sort((a,b)=>b.code.charCodeAt(0)-a.code.charCodeAt(0)||a.code.length-b.code.length||a.code.localeCompare(b.code));
    // Fetch one current advertised main/supplementary document per authority/type.
    // If the latest file is unavailable, make at most one fallback attempt.
    for(const notice of sorted.slice(0,2)){const result=await probe(notice);row.attachmentResults.push(result);if(result.status==='retrieved')break;}
    completed++;if(completed%40===0||completed===tasks.length)console.log(`Attachment connectivity: ${completed}/${tasks.length}`);
  }
}));
const report={checkedAt:new Date().toISOString(),year,scope:'Official national portal notice index for all funding authorities, plus one advertised main/supplementary binary when available. Keyword evidence is not a semantic eligibility or monetary-rule verification. Latest supplements may retain older base terms; missing words do not mean a benefit is absent.',limits:{concurrency:2,requestTimeoutMs:12000,attachmentBytes:MAX_BYTES,maxAttemptsPerAuthorityType:2},sources,summary:{authoritiesPerType:expected.length,authorityTypeRows:rows.length,indexVerified:rows.length,advertisedAttachmentRows:tasks.length,missingAttachmentRows:rows.filter(row=>!row.notices.length).map(row=>({regionId:row.regionId,region:row.region,vehicleType:row.vehicleType})),connectivityChecked:metadataOnly?0:completed,filesRetrieved:rows.filter(row=>row.attachmentResults.some(result=>result.status==='retrieved')).length,hwpxExtracted:rows.filter(row=>row.attachmentResults.some(result=>result.type==='HWPX')).length,requiresConnectivityReview:metadataOnly?tasks.length:rows.filter(row=>row.notices.length&&!row.attachmentResults.some(result=>result.status==='retrieved')).length,localMonetaryRulesSemanticallyReviewed:0},rows};
await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,summary:report.summary},null,2));
