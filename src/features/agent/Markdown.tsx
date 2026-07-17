'use client';

/**
 * Minimal markdown renderer for dashboard panels.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The `markdown` panel type never rendered markdown. `PanelBody` printed
 * `config.text` inside a `whitespace-pre-wrap` <p> — so a panel the agent was
 * TOLD was markdown displayed `## Heading` and `| a | b |` as literal text.
 *
 * That produced a classic false bug report: Ryan asked the agent for a bookmarks
 * panel with clickable links; the agent wrote a perfectly good markdown table;
 * the dashboard showed raw pipes and unclickable URLs; and the agent apologised
 * for a mistake it hadn't made and offered to connect a Notion MCP instead. The
 * platform lied about what a panel type does, and the agent paid for it.
 *
 * Same lesson as Phase 21: when the agent hand-rolls something broken, look for
 * the missing primitive before "improving" the prompt.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY REACT ELEMENTS AND NOT HTML
 *
 * The obvious build is marked/markdown-it → dangerouslySetInnerHTML. That gives
 * you an XSS hole in a multi-tenant app: panel text is written by an AGENT, and
 * the agent reads untrusted web pages. A prompt-injected page could get
 * `<script>` or an onerror payload into a panel, which then executes in another
 * user's session on your domain.
 *
 * Building React elements means the output is text nodes and typed props —
 * there is no path from panel text to executable HTML, so no sanitizer is
 * needed and none can be forgotten. It also keeps the repo dep-free, matching
 * the dep-free SVG charts next door.
 *
 * Supported deliberately: headings, tables, links, bold, inline code, lists,
 * blockquotes, hr, paragraphs. That is what a dashboard panel needs. It is NOT a
 * CommonMark implementation and should not grow into one — if a panel needs more
 * than this, it wants a different panel type.
 */

import type { ReactNode } from 'react';

/**
 * Only http(s) links become anchors. `javascript:` and `data:` URLs are the
 * classic markdown XSS vector — `[click](javascript:alert(1))` — and the agent
 * can be fed a link by a page it fetched, so this is not theoretical.
 */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed, 'https://artivio.ai');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Inline: **bold**, `code`, [text](url). Applied inside every block type. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, three alternatives — order matters: code first so `**` inside
  // backticks stays literal.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null = pattern.exec(text);
  let i = 0;

  while (m !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const token = m[0];
    i += 1;

    if (token.startsWith('`')) {
      out.push(
        <code key={`${keyPrefix}-c${i}`} className="rounded bg-white/10 px-1 py-0.5 text-[0.85em] text-white/85">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${i}`} className="font-semibold text-white/90">{token.slice(2, -2)}</strong>);
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = safeHref(token.slice(token.indexOf('(') + 1, -1));
      if (href) {
        out.push(
          <a
            key={`${keyPrefix}-l${i}`}
            href={href}
            target="_blank"
            // noopener: stop the new tab reaching back via window.opener.
            // noreferrer: don't leak the dashboard URL (it carries the tenant).
            rel="noopener noreferrer"
            className="text-indigo-300 underline decoration-indigo-300/40 underline-offset-2 transition hover:text-indigo-200 hover:decoration-indigo-200"
          >
            {label}
          </a>,
        );
      } else {
        // Unsafe scheme — show the label as plain text rather than silently
        // dropping it, so the panel doesn't quietly lose content.
        out.push(label);
      }
    }
    last = m.index + token.length;
    m = pattern.exec(text);
  }

  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

export const Markdown = ({ text }: { text: string }) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // ── Table ───────────────────────────────────────────────────────────────
    // The reason this renderer exists: the agent reaches for tables constantly
    // (bookmarks, metrics, comparisons) and they were the worst-looking thing
    // on the dashboard as raw pipes.
    if (trimmed.includes('|') && isTableDivider(lines[i + 1] ?? '')) {
      const headers = splitRow(trimmed);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? '').includes('|') && (lines[j] ?? '').trim()) {
        rows.push(splitRow(lines[j] ?? ''));
        j += 1;
      }
      blocks.push(
        <div key={`t${i}`} className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {headers.map((h, hi) => (
                  <th key={hi} className="px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-white/45">
                    {renderInline(h, `th${i}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-white/5 last:border-0">
                  {headers.map((_, ci) => (
                    <td key={ci} className="px-2 py-1.5 align-top text-white/75">
                      {renderInline(r[ci] ?? '', `td${i}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }

    // ── Heading ─────────────────────────────────────────────────────────────
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const content = renderInline(heading[2] ?? '', `h${i}`);
      const cls = level <= 2
        ? 'mt-1 text-sm font-semibold text-white/90'
        : 'mt-1 text-xs font-semibold uppercase tracking-wide text-white/50';
      blocks.push(<div key={`h${i}`} className={cls}>{content}</div>);
      i += 1;
      continue;
    }

    // ── Horizontal rule ─────────────────────────────────────────────────────
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`r${i}`} className="border-white/10" />);
      i += 1;
      continue;
    }

    // ── Blockquote ──────────────────────────────────────────────────────────
    if (trimmed.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('> ')) {
        quote.push((lines[i] ?? '').trim().slice(2));
        i += 1;
      }
      blocks.push(
        <blockquote key={`q${i}`} className="border-l-2 border-indigo-400/40 pl-3 text-sm italic text-white/60">
          {renderInline(quote.join(' '), `q${i}`)}
        </blockquote>,
      );
      continue;
    }

    // ── List ────────────────────────────────────────────────────────────────
    const bullet = /^[-*+]\s+/;
    const numbered = /^\d+\.\s+/;
    if (bullet.test(trimmed) || numbered.test(trimmed)) {
      const ordered = numbered.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? '').trim();
        if (!bullet.test(t) && !numbered.test(t)) {
          break;
        }
        items.push(t.replace(bullet, '').replace(numbered, ''));
        i += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List
          key={`l${i}`}
          className={`ml-4 space-y-1 text-sm text-white/70 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-white/30`}
        >
          {items.map((it, ii) => <li key={ii}>{renderInline(it, `li${i}-${ii}`)}</li>)}
        </List>,
      );
      continue;
    }

    // ── Paragraph ───────────────────────────────────────────────────────────
    // Consume consecutive non-blank lines that aren't another block type, so a
    // soft-wrapped paragraph renders as one paragraph.
    const para: string[] = [];
    while (i < lines.length) {
      const t = (lines[i] ?? '').trim();
      if (!t || /^#{1,4}\s/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)
        || bullet.test(t) || numbered.test(t) || t.startsWith('> ')
        || (t.includes('|') && isTableDivider(lines[i + 1] ?? ''))) {
        break;
      }
      para.push(t);
      i += 1;
    }
    blocks.push(
      <p key={`p${i}`} className="text-sm leading-relaxed text-white/70">
        {renderInline(para.join(' '), `p${i}`)}
      </p>,
    );
  }

  return <div className="space-y-2">{blocks}</div>;
};
