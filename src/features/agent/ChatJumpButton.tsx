'use client';

import { useEffect, useState } from 'react';

/**
 * "Jump to chat" pill — the MOBILE half of keeping chat reachable.
 *
 * On desktop the chat column is `position: sticky`, so it simply stays on
 * screen. Sticky does nothing in a single-column layout, though: on a phone the
 * chat is still rendered after the whole dashboard, and the more panels the
 * agent builds the further down it goes. That is the original complaint, and it
 * is worst precisely where scrolling costs the most.
 *
 * So below `lg` this watches the chat and offers one tap to reach it.
 *
 * It renders NOTHING while the chat is on screen — a permanent floating button
 * over a chat box you are already looking at is just an obstruction.
 */
export function ChatJumpButton(props: { targetId: string; agentName: string }) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const el = document.getElementById(props.targetId);
    if (!el) {
      return;
    }

    // IntersectionObserver rather than a scroll listener: no work on the main
    // thread while scrolling, and it self-corrects when panels load in and
    // change the page height underneath us.
    const observer = new IntersectionObserver(
      ([entry]) => setHidden(Boolean(entry?.isIntersecting)),
      // 0.15 so the button disappears once a useful amount of the chat is
      // visible, not the moment one pixel of its top edge appears.
      { threshold: 0.15 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [props.targetId]);

  if (hidden) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById(props.targetId);
        if (!el) {
          return;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Do NOT focus the textarea here. On iOS that summons the keyboard,
        // which resizes the viewport mid-scroll and lands the user somewhere
        // other than where they were heading.
      }}
      aria-label={`Jump to chat with ${props.agentName}`}
      className="
        fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border
        border-white/15 bg-slate-900/90 px-4 py-3 text-sm font-medium text-white
        shadow-lg backdrop-blur-sm transition
        hover:bg-slate-800/90
        active:scale-95
        lg:hidden
      "
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-4 fill-none stroke-current stroke-2"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      Ask
      {' '}
      {props.agentName}
    </button>
  );
}
