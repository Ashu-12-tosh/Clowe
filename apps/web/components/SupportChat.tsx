'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RuleBasedEngine, type BotMessage, type ChatEngine } from '@/lib/support/engine';

interface ChatItem {
  role: 'bot' | 'user';
  message: BotMessage; // for user turns only `text` is used
}

/**
 * Menu-driven support bot (rule-based — no AI calls). All content lives in
 * lib/support/faq-content.ts; the engine behind ChatEngine is swappable.
 */
export default function SupportChat() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const engineRef = useRef<ChatEngine | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, open, busy]);

  // Lock body scroll while the mobile sheet is open.
  useEffect(() => {
    if (open && window.innerWidth < 640) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  async function openChat() {
    setOpen(true);
    if (!engineRef.current) {
      engineRef.current = new RuleBasedEngine();
      const reply = await engineRef.current.start();
      setItems(reply.messages.map((message) => ({ role: 'bot' as const, message })));
    }
  }

  async function run(action: () => Promise<{ messages: BotMessage[] }>) {
    setBusy(true);
    try {
      const reply = await action();
      setItems((prev) => [
        ...prev,
        ...reply.messages.map((message) => ({ role: 'bot' as const, message })),
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onChip(id: string, label: string) {
    if (busy) return;
    setItems((prev) => [...prev, { role: 'user', message: { text: label } }]);
    void run(() => engineRef.current!.handleChip(id));
  }

  function onSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setItems((prev) => [...prev, { role: 'user', message: { text } }]);
    void run(() => engineRef.current!.handleText(text));
  }

  // Chips are shown only under the LAST bot message (like WhatsApp bots).
  const lastBotIndex = [...items].map((i) => i.role).lastIndexOf('bot');

  // Customer-facing widget only — hidden on login and the admin/seller shells.
  if (pathname === '/login' || pathname.startsWith('/admin') || pathname.startsWith('/seller')) {
    return null;
  }

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => void openChat()}
          aria-label="Open support chat"
          className="fixed bottom-5 right-5 z-40 flex items-center justify-center rounded-full bg-ink-900 p-3.5 text-2xl shadow-lg transition hover:scale-105 hover:bg-ink-800"
        >
          💬
        </button>
      )}

      {/* Panel — full-height sheet on mobile, card on desktop */}
      {open && (
        <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-white sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[32rem] sm:w-[min(24rem,calc(100vw-2.5rem))] sm:rounded-2xl sm:border sm:border-gray-200 sm:shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between bg-ink-900 px-4 py-3 text-white">
            <div>
              <p className="font-display text-sm font-bold uppercase tracking-[0.15em] text-brand-400">
                Clowe Support
              </p>
              <p className="text-[11px] text-gray-400">Instant answers · tap an option below</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="rounded-full p-1 text-xl text-gray-300 hover:bg-white/10 hover:text-white"
            >
              ×
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 space-y-2.5 overflow-y-auto bg-cream-50 p-3">
            {items.map((item, index) => (
              <div key={index}>
                <div className={item.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <div
                    className={`max-w-[88%] whitespace-pre-line rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      item.role === 'user'
                        ? 'rounded-br-sm bg-ink-900 text-white'
                        : 'rounded-bl-sm border border-gray-100 bg-white text-gray-800'
                    }`}
                  >
                    {item.message.text}
                    {item.message.links && item.message.links.length > 0 && (
                      <span className="mt-2.5 flex flex-wrap gap-2">
                        {item.message.links.map((link) => (
                          <Link
                            key={link.href + link.label}
                            href={link.href}
                            onClick={() => setOpen(false)}
                            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-700"
                          >
                            {link.label} →
                          </Link>
                        ))}
                      </span>
                    )}
                  </div>
                </div>

                {/* Quick-reply chips under the latest bot message */}
                {item.role === 'bot' &&
                  index === lastBotIndex &&
                  !busy &&
                  item.message.chips &&
                  item.message.chips.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-1">
                      {item.message.chips.map((chip) => (
                        <button
                          key={chip.id + chip.label}
                          onClick={() => onChip(chip.id, chip.label)}
                          className="rounded-full border border-brand-600 bg-white px-3 py-1.5 text-xs font-semibold text-brand-700 transition hover:bg-brand-50"
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  )}
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm border border-gray-100 bg-white px-3.5 py-2.5 text-sm text-gray-400">
                  typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input (text fallback — keyword matched, no AI) */}
          <form
            className="flex gap-2 border-t border-gray-100 bg-white p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your question…"
              className="flex-1 rounded-full border border-gray-200 bg-cream-50 px-3.5 py-2 text-sm outline-none focus:border-brand-600"
            />
            <button
              disabled={busy || !input.trim()}
              className="rounded-full bg-ink-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              ➤
            </button>
          </form>
        </div>
      )}
    </>
  );
}
