"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { ErrorText } from "../../ui";

/**
 * The message box. On Today it starts a new conversation with Scout; in a
 * thread it continues it. Enter sends, Shift+Enter adds a line. What Scout
 * then does is an ordinary task: anything risky waits for approval.
 */
export function Composer({ orgId, threadId, suggestions = [], disabledReason }: { orgId: string; threadId?: string; suggestions?: string[]; disabledReason?: string }) {
  const router = useRouter();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One reference per message, so a double send can't post twice.
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());

  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      let id = threadId;
      if (!id) {
        const title = content.length > 60 ? `${content.slice(0, 57).trimEnd()}…` : content;
        id = (await trpc.chat.createThread.mutate({ orgId, title })).threadId;
      }
      await trpc.chat.send.mutate({ orgId, threadId: id, content, clientRef });
      setText("");
      setClientRef(crypto.randomUUID());
      if (ref.current) ref.current.style.height = "auto";
      if (threadId) router.refresh();
      else router.push(`/orgs/${orgId}/chat/${id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="composer" className="flex scroll-mt-24 flex-col">
      {suggestions.length > 0 && !text && (
        <ul aria-label="Suggestions" className="order-last mt-3 flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => {
                  setText(s);
                  ref.current?.focus();
                }}
                className="min-h-10 rounded-full border border-line bg-surface px-4 text-small text-muted transition-colors duration-150 hover:border-accent/40 hover:text-ink"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-end gap-2 rounded-[1.75rem] border border-line bg-surface p-2 pl-5 shadow-[var(--shadow-raised)] transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor={`composer-${threadId ?? "new"}`} className="sr-only">
          {threadId ? "Message Scout" : "Ask Scout to do something"}
        </label>
        <textarea
          id={`composer-${threadId ?? "new"}`}
          ref={ref}
          rows={1}
          maxLength={4000}
          value={text}
          disabled={!!disabledReason}
          placeholder={disabledReason ?? (threadId ? "Reply to Scout" : "Ask Scout to do something…")}
          onChange={(e) => {
            setText(e.target.value);
            grow(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-60 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-message leading-relaxed text-ink outline-none placeholder:text-muted disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !text.trim() || !!disabledReason}
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-accent px-5 font-medium text-on-accent transition-[filter,opacity] duration-150 hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
      <p className="mt-2 px-2 text-sm text-muted">Scout hands work to your teammates. Say “remember …” or “forget …” to change what Scout knows. “Every Friday …” schedules a read-only routine. Anything that sends, charges or changes something waits for your OK.</p>
      <div className="mt-2"><ErrorText message={error} /></div>
    </div>
  );
}
