import { regions } from '@/lib/regions';
import { apiHeaders } from '@/lib/api-headers';

export async function GET(request?: Request) {
  return Response.json({regions},{headers:apiHeaders(request)});
}
