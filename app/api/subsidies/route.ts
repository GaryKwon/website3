import { getSubsidies } from '@/lib/subsidies';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type') ?? 'passenger';
  if (type !== 'passenger' && type !== 'cargo') return Response.json({error:'지원하지 않는 차종입니다.'},{status:400});
  const year = Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Seoul'}).format(new Date()));
  const result = await getSubsidies(type,year);
  return Response.json(result,{headers:{'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff'}});
}
