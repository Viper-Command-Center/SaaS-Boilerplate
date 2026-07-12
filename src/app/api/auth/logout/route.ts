import { NextResponse } from 'next/server';
import { destroyCurrentSession } from '@/libs/auth/session';

export async function POST(request: Request) {
  await destroyCurrentSession();
  return NextResponse.redirect(new URL('/', request.url), 303);
}

// Support plain-link logout too.
export async function GET(request: Request) {
  await destroyCurrentSession();
  return NextResponse.redirect(new URL('/', request.url), 303);
}
