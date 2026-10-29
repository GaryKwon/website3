import { regions } from '@/lib/regions';

export async function GET() {
  return Response.json({regions},{headers:{'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff'}});
}
