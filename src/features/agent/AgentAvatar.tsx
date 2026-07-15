'use client';

import { BrandMark } from '@/components/BrandLogo';

const FALLBACK_ACCENT = 'from-indigo-500 to-violet-600';

const ACCENTS: Record<string, string> = {
  indigo: 'from-indigo-500 to-violet-600',
  violet: 'from-violet-500 to-fuchsia-600',
  emerald: 'from-emerald-500 to-teal-600',
  amber: 'from-amber-500 to-orange-600',
  sky: 'from-sky-500 to-cyan-600',
  rose: 'from-rose-500 to-pink-600',
};

/**
 * The face of the workspace's AI employee.
 *
 * Falls back gracefully: a real photo if the persona has one, otherwise a
 * gradient initial in the persona's accent, otherwise the Artivio mark for
 * workspaces that haven't picked an employee.
 */
export const AgentAvatar = (props: {
  name?: string | null;
  avatarUrl?: string | null;
  accent?: string | null;
  size?: number;
}) => {
  const size = props.size ?? 22;

  if (props.avatarUrl) {
    return (
      <img
        src={props.avatarUrl}
        alt={props.name ?? 'Agent'}
        width={size}
        height={size}
        className="rounded-lg object-cover ring-1 ring-white/15"
        style={{ width: size, height: size }}
      />
    );
  }

  if (!props.name || props.name === 'Agent') {
    return <BrandMark size={size} />;
  }

  const grad = ACCENTS[props.accent ?? 'indigo'] ?? FALLBACK_ACCENT;
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${grad} font-semibold text-white ring-1 ring-white/15`}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.45) }}
      aria-hidden
    >
      {props.name.trim().charAt(0).toUpperCase()}
    </span>
  );
};
