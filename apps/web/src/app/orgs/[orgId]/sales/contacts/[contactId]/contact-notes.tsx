"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { Card, ErrorText, inputCls, quietButtonCls, When } from "../../../../../ui";

interface NoteShape {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
}

export function ContactNotes({ orgId, contactId, canWrite, notes }: { orgId: string; contactId: string; canWrite: boolean; notes: NoteShape[] }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await trpc.crm.addNote.mutate({ orgId, contactId, content });
      setContent("");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Notes (${notes.length})`}>
      {canWrite && (
        <form onSubmit={submit} className="mb-4 flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="sr-only">Add a note</span>
            <textarea
              className={inputCls}
              rows={3}
              maxLength={1000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Add a note — calls, context, promises made…"
            />
          </label>
          <div>
            <button type="submit" className={quietButtonCls} disabled={busy || !content.trim()}>
              Add note
            </button>
          </div>
          <ErrorText message={error} />
        </form>
      )}
      {notes.length === 0 ? (
        <p className="text-sm text-muted">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((n) => (
            <li key={n.id} className="py-3">
              <p className="whitespace-pre-wrap text-base">{n.body}</p>
              <p className="mt-1 text-sm text-muted">
                {n.authorName ?? "Someone"} · <When date={n.createdAt} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
