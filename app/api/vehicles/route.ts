import { getVehicles } from '@/lib/vehicles';
import { regions } from '@/lib/regions';
import { apiHeaders } from '@/lib/api-headers';

export async function GET(request:Request) {
  const query=new URL(request.url).searchParams;
  const region=query.get('region')??'';
  const type=query.get('type')??'passenger';
  if(type!=='passenger' && type!=='cargo') return Response.json({error:'차종을 확인해 주세요.'},{status:400,headers:apiHeaders(request)});
  const authority=regions.find(r=>r.id===region);
  if(!authority || authority.children?.length) return Response.json({error:'시·군·구를 선택해 주세요.'},{status:400,headers:apiHeaders(request)});
  const year=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
  const result=await getVehicles(region,type,year);
  return Response.json(result,{headers:apiHeaders(request)});
}
