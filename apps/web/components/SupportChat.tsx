'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const WELCOME: ChatMessage = {
  role: 'assistant',
  content: "Hi! 👋 I'm the Clowe assistant. Ask me about orders, returns, shipping, the AI try-on, or selling on Clowe.",
};

export default function SupportChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const data = await api<{ reply: string }>('/api/ai/support-chat', {
        // Welcome message is client-side only — send real turns.
        body: { messages: next.slice(1).slice(-10) },
      });
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            err instanceof ApiRequestError
              ? err.message
              : 'Sorry, I could not reach the server. Please try again.',
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open support chat"
          className="fixed bottom-5 right-5 z-40 flex h-13 w-13 items-center justify-center rounded-full bg-brand-600 p-3.5 text-2xl shadow-lg transition hover:scale-105 hover:bg-brand-700"
        >
          💬
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-40 flex h-[28rem] w-[min(22rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between bg-brand-600 px-4 py-3 text-white">
            <div>
              <p className="text-sm font-bold">Clowe Support</p>
              <p className="text-[11px] opacity-80">AI assistant · instant replies</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="text-xl opacity-80 hover:opacity-100">
              ×
            </button>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'rounded-br-sm bg-brand-600 text-white'
                      : 'rounded-bl-sm bg-gray-100 text-gray-800'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-sm bg-gray-100 px-3 py-2 text-sm text-gray-400">
                  typing…
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form
            className="flex gap-2 border-t border-gray-200 p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your question…"
              className="flex-1 rounded-full border border-gray-300 px-3.5 py-2 text-sm outline-none focus:border-brand-600"
            />
            <button
              disabled={busy || !input.trim()}
              className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              ➤
            </button>
          </form>
        </div>
      )}
    </>
  );
}
