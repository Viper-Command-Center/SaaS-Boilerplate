/**
 * POST /api/invite-request — public waitlist form.
 * Stores the request (so nothing is lost if email fails) and notifies the team.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/libs/DB';
import { sendAdminNotice } from '@/libs/email';
import { inviteRequests } from '@/models/Schema';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  company: z.string().max(160).optional(),
  website: z.string().max(300).optional(),
  clientCount: z.string().max(40).optional(),
  useCase: z.string().max(2000).optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Please fill in your name and a valid email.' }, { status: 400 });
  }

  await db.insert(inviteRequests).values({
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    company: body.company?.trim() || null,
    website: body.website?.trim() || null,
    clientCount: body.clientCount || null,
    useCase: body.useCase?.trim() || null,
  }).catch(() => {});

  await sendAdminNotice({
    subject: `Artivio invite request — ${body.company || body.name}`,
    body: [
      `<strong>Name:</strong> ${body.name}`,
      `<strong>Email:</strong> ${body.email}`,
      body.company ? `<strong>Company:</strong> ${body.company}` : '',
      body.website ? `<strong>Website:</strong> ${body.website}` : '',
      body.clientCount ? `<strong>Businesses/clients:</strong> ${body.clientCount}` : '',
      body.useCase ? `<strong>What they want to do:</strong><br/>${body.useCase}` : '',
    ].filter(Boolean).join('<br/>'),
  });

  return NextResponse.json({ ok: true });
}
