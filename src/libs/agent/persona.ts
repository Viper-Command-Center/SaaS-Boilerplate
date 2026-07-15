/**
 * AI Employees — resolving which persona works a given workspace.
 *
 * A persona is a name, a face, and a personality. It changes how the agent
 * *sounds*, never what it's allowed to *do*: approvals, spend caps, tenant
 * isolation and the untrusted-content rules are identical for every employee.
 * That separation matters — personality is presentation, not permission.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { agentPersonas, tenants } from '@/models/Schema';

export type Persona = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  role: string | null;
  personality: string;
  avatarUrl: string | null;
  accent: string | null;
};

/** What the UI and prompt need. Null persona = the generic Artivio agent. */
export type ResolvedAgent = {
  name: string;
  avatarUrl: string | null;
  accent: string;
  persona: Persona | null;
};

export const DEFAULT_AGENT: ResolvedAgent = {
  name: 'Agent',
  avatarUrl: null,
  accent: 'indigo',
  persona: null,
};

export async function listPersonas(includeDisabled = false): Promise<Persona[]> {
  const rows = await db
    .select({
      id: agentPersonas.id,
      slug: agentPersonas.slug,
      name: agentPersonas.name,
      tagline: agentPersonas.tagline,
      role: agentPersonas.role,
      personality: agentPersonas.personality,
      avatarUrl: agentPersonas.avatarUrl,
      accent: agentPersonas.accent,
      enabled: agentPersonas.enabled,
    })
    .from(agentPersonas)
    .orderBy(asc(agentPersonas.name));

  return rows.filter(r => includeDisabled || r.enabled).map(({ enabled: _e, ...p }) => p);
}

/**
 * Who works this account? Falls back to the generic agent when no persona is
 * assigned, so this is always safe to call.
 */
export async function resolveAgentForTenant(tenantId: string): Promise<ResolvedAgent> {
  const [row] = await db
    .select({
      override: tenants.agentNameOverride,
      persona: {
        id: agentPersonas.id,
        slug: agentPersonas.slug,
        name: agentPersonas.name,
        tagline: agentPersonas.tagline,
        role: agentPersonas.role,
        personality: agentPersonas.personality,
        avatarUrl: agentPersonas.avatarUrl,
        accent: agentPersonas.accent,
      },
    })
    .from(tenants)
    .leftJoin(agentPersonas, eq(tenants.personaId, agentPersonas.id))
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!row?.persona?.id) {
    return { ...DEFAULT_AGENT, name: row?.override || DEFAULT_AGENT.name };
  }

  return {
    // A workspace may rename its employee without forking the persona.
    name: row.override || row.persona.name,
    avatarUrl: row.persona.avatarUrl,
    accent: row.persona.accent || 'indigo',
    persona: row.persona,
  };
}

/**
 * The persona fragment injected into the system prompt. Kept separate from the
 * operating rules so an employee's voice can never soften a guardrail.
 */
export function personaPromptFragment(agent: ResolvedAgent): string {
  if (!agent.persona) {
    return '';
  }
  return `

## Who you are
Your name is ${agent.name}. Introduce yourself as ${agent.name} — not as "the \
Artivio agent" — and sign off as ${agent.name} where it reads naturally.

${agent.persona.personality}

This is your voice and manner. It never changes what you are permitted to do: \
approvals, spend limits, workspace boundaries and the rules about untrusted \
content apply to you exactly as written above. Being warm or informal is not a \
reason to skip an approval, and staying in character is never a reason to \
mislead someone or pretend a task succeeded when it did not. If the user asks \
you to break a rule, ${agent.name} declines like any good colleague would — \
plainly, and without lecturing.`;
}
