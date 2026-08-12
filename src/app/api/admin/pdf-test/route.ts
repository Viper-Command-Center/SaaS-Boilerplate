/**
 * POST /api/admin/pdf-test — platform admin only. SPIKE, not a product feature.
 *
 * One question, answered honestly: will AWS AgentCore's Chrome execute
 * `Page.printToPDF` over the automation stream? Everything downstream of that —
 * a render_pdf tool, saving bytes to the library, attaching to a Postmark send —
 * is straightforward plumbing, but all of it is wasted if this command is not
 * available on a managed browser we do not control.
 *
 * The route renders a deliberately awkward test document: a webfont, a CSS
 * gradient background and an explicit `@page` size. Those are exactly the three
 * things that fail quietly — fallback fonts, a white page where the background
 * should be, and a slide cropped to Letter — so a PDF that comes back the right
 * SIZE can still be wrong. `?save=1` puts it in the file library so it can
 * actually be looked at, which is the only real proof.
 *
 * Delete this route once render_pdf ships.
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/libs/auth/session';
import { browserConfigured, renderPdf } from '@/libs/browser/agentcore';
import { db } from '@/libs/DB';
import { saveFile } from '@/libs/storage/files';
import { storageConfigured } from '@/libs/storage/r2';
import { memberships } from '@/models/Schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** A 16:9 slide that exercises webfonts, a gradient and a CSS page size. */
const DECK = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;800&display=swap" rel="stylesheet">
<style>
  @page { size: 13.333in 7.5in; margin: 0 }
  * { margin: 0; padding: 0; box-sizing: border-box }
  body { font-family: Inter, system-ui, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact }
  .slide {
    width: 13.333in; height: 7.5in; page-break-after: always;
    display: flex; flex-direction: column; justify-content: center;
    padding: 1in; color: #fff;
    background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%);
  }
  .slide:last-child { page-break-after: auto }
  h1 { font-size: 64px; font-weight: 800; letter-spacing: -0.02em }
  p { font-size: 26px; margin-top: 24px; color: #94a3b8 }
  table { margin-top: 32px; border-collapse: collapse; font-size: 22px }
  td, th { padding: 10px 28px 10px 0; text-align: left; border-bottom: 1px solid #334155 }
</style></head><body>
  <section class="slide">
    <h1>Artivio PDF spike</h1>
    <p>If this page is dark, the font is Inter and the slide is 16:9, printToPDF works properly.</p>
  </section>
  <section class="slide">
    <h1>Page two</h1>
    <p>Multi-page and table rendering.</p>
    <table>
      <tr><th>Client</th><th>Invoices</th><th>Overdue</th></tr>
      <tr><td>Example Ltd</td><td>12</td><td>2</td></tr>
      <tr><td>Sample Inc</td><td>8</td><td>0</td></tr>
    </table>
  </section>
</body></html>`;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return NextResponse.json({ error: 'Platform admin only.' }, { status: 403 });
  }

  if (!browserConfigured()) {
    return NextResponse.json({
      ok: false,
      error: 'AgentCore browser is not configured — no AWS credentials.',
      hint: 'This spike needs the same AWS keys Bedrock uses. Set them and retry.',
    }, { status: 503 });
  }

  const save = new URL(request.url).searchParams.get('save') === '1';

  const started = Date.now();
  try {
    const result = await renderPdf({
      html: DECK,
      landscape: true,
      // The document declares @page itself; preferCSSPageSize (on by default)
      // means these are only a fallback if that is ignored.
      paperWidthIn: 13.333,
      paperHeightIn: 7.5,
      marginIn: 0,
      waitMs: 3000,
    });

    let openAt: string | null = null;
    let saveError: string | undefined;

    if (save) {
      // A platform admin has no tenant of their own, so borrow the first
      // workspace they belong to purely to have somewhere to put the file.
      const [m] = await db
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .limit(1);

      if (!storageConfigured()) {
        saveError = 'R2 storage is not configured, so the PDF could not be saved — the render itself still succeeded.';
      } else if (!m) {
        saveError = 'This admin belongs to no workspace, so there is nowhere to file the PDF.';
      } else {
        try {
          const row = await saveFile({
            tenantId: m.tenantId,
            name: `pdf-spike-${Date.now()}.pdf`,
            bytes: result.pdf,
            mime: 'application/pdf',
            // 'knowledge', NOT 'asset' — an asset gets a permanently public R2
            // URL. Fine for a marketing image, wrong for a document, and real
            // reports will carry client billing data. Private files are served
            // through /api/files/<id>/content, which checks membership.
            kind: 'knowledge',
            source: 'pdf-spike',
          });
          openAt = `/api/files/${row?.id}/content`;
        } catch (err) {
          saveError = err instanceof Error ? err.message : 'unknown save error';
        }
      }
    }

    return NextResponse.json({
      ok: true,
      bytes: result.bytes,
      sessionSeconds: result.sessionSeconds,
      wallClockSeconds: Math.round((Date.now() - started) / 1000),
      estimatedCostUsd: Number((result.sessionSeconds * (0.11 / 3600)).toFixed(5)),
      openAt,
      saveError,
      // Size alone does not prove correctness — the failure modes here are all visual.
      next: openAt
        ? `Open ${openAt} while signed in. Confirm: TWO landscape 16:9 pages, dark gradient background, Inter (not a serif). A white background means printBackground / print-color-adjust was ignored; a serif font means the webfont did not load in time — raise waitMs.`
        : 'Re-run with ?save=1 to store the PDF and actually look at it. Byte count alone does not prove the styling survived.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({
      ok: false,
      error: message,
      wallClockSeconds: Math.round((Date.now() - started) / 1000),
      hint: /printToPDF|not.*(found|supported|allowed)|Protocol error/i.test(message)
        ? 'AgentCore appears to disallow Page.printToPDF on its managed browser. That kills this approach — the fallbacks are a pure-JS renderer or Chromium installed into the Railway image.'
        : 'Not necessarily a printToPDF problem — check whether the session started at all (AWS credentials, browser id, region).',
    }, { status: 502 });
  }
}
