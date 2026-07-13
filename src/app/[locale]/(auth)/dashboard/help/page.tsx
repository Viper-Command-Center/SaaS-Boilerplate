import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { TitleBar } from '@/features/dashboard/TitleBar';

export const metadata: Metadata = {
  title: 'Help & support',
  description: 'How to use your Artivio Command Center.',
};

const SECTIONS: Array<{ heading: string; items: Array<{ q: string; a: string }> }> = [
  {
    heading: 'Getting started',
    items: [
      {
        q: 'What is the agent, exactly?',
        a: 'Each workspace has its own AI agent — think of it as an employee for that business. It has the workspace\'s context and tools, it can plan and execute work, and it routes anything risky to you for approval. Talk to it in the chat box on the dashboard the way you\'d brief a colleague: give it context, a goal, and any constraints.',
      },
      {
        q: 'What can it do without any setup?',
        a: 'Out of the box it can advise, plan, draft copy, analyse what you give it, build dashboard panels, store data, and schedule its own recurring missions. Everything that touches the outside world — publishing, spending, editing your website — needs a tool connection first.',
      },
      {
        q: 'How do I add another business or client?',
        a: 'In the Workspace panel at the bottom of the dashboard, create a new workspace (one per business or client). Switch between them with the chips at the top of the dashboard. Workspaces are fully isolated: separate agent, tools, credentials, data and approvals.',
      },
    ],
  },
  {
    heading: 'Tools (MCP servers)',
    items: [
      {
        q: 'How do I give the agent a new capability?',
        a: 'In the Tools panel, click "Add MCP server" and paste the server\'s URL plus any auth header it needs (e.g. Authorization: Bearer <key>). The agent discovers that server\'s tools on your next message. Credentials are encrypted in a vault — they are never shown again, never leave the workspace, and are never sent to the AI model.',
      },
      {
        q: 'Which servers should I connect?',
        a: 'Ask the agent. If a task needs a capability it doesn\'t have, it will recommend a specific MCP server and tell you what credentials it needs. Common ones: GitHub (edit your websites), an SEO data provider, a social publishing service, analytics, and e-commerce platforms.',
      },
      {
        q: 'Can I stop the agent using a particular tool?',
        a: 'Yes. Every tool is one of three policies: auto (runs immediately — good for read-only tools), approval (default — waits for your sign-off), or deny (blocked entirely). New tools are always approval-gated until you decide otherwise.',
      },
    ],
  },
  {
    heading: 'Approvals & safety',
    items: [
      {
        q: 'How do approvals work?',
        a: 'When the agent wants to take a side-effecting action, it stops and files it in the Approvals panel with the exact arguments it intends to use. Nothing happens until you press "Approve & run" — at which point it executes and the result is stored. Reject and it\'s discarded.',
      },
      {
        q: 'Is there an audit trail?',
        a: 'Yes — every tool call, approval decision, connection change and member change is recorded with who did it and when.',
      },
      {
        q: 'What can clients see?',
        a: 'Roles control it. Viewer: chat and dashboards only. Editor: adds the approvals inbox. Admin/Owner: adds tools and member management. You (the platform admin) see everything and can create workspaces.',
      },
    ],
  },
  {
    heading: 'Dashboard & missions',
    items: [
      {
        q: 'How do I get charts and KPIs?',
        a: 'Just ask. "Track our weekly signups as a chart" — the agent stores the data and creates the panel itself. You can ask it to change, retitle or delete any panel.',
      },
      {
        q: 'How do I set up recurring work?',
        a: 'Ask for it in plain language: "Publish an SEO blog post every Monday morning" or "Every night, collect our analytics and update the dashboard." The agent creates a scheduled task and runs it automatically. Ask it to list, pause or delete its scheduled tasks any time.',
      },
      {
        q: 'Can I give it a business goal?',
        a: 'Yes — that\'s the point. "Get us 100 new customers by Friday" makes it work backwards through the funnel math, use whatever tools it has, and report progress honestly, including telling you when a goal isn\'t reachable and what would make it reachable.',
      },
    ],
  },
];

export default async function HelpPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  setRequestLocale(locale);

  return (
    <>
      <TitleBar
        title="Help & support"
        description="How the Command Center works — and how to get the most out of your agent."
      />

      <div className="space-y-6">
        {SECTIONS.map(section => (
          <div key={section.heading} className="rounded-lg border bg-background">
            <div className="border-b px-4 py-3 text-sm font-semibold">{section.heading}</div>
            <div className="divide-y">
              {section.items.map(item => (
                <div key={item.q} className="px-4 py-4">
                  <p className="text-sm font-medium">{item.q}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="rounded-lg border bg-background p-4">
          <p className="text-sm font-semibold">Still stuck?</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Two good options: ask the agent directly — it knows how this platform
            works and can walk you through it — or email us at
            {' '}
            <a href="mailto:hello@artivio.ai" className="font-medium underline">hello@artivio.ai</a>
            .
          </p>
        </div>
      </div>
    </>
  );
};
