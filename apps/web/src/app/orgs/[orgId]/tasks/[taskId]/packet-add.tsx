"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls, quietButtonCls } from "../../../../ui";

const MAX_BYTES = 15 * 1024 * 1024;

/** Add photos (hashed in the browser's upload, chained on the server) and written notes to a job's claim packet. */
export function PacketAdd({ orgId, jobId }: { orgId: string; jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"photo" | "note" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function uploadPhotos(files: FileList | null) {
    if (!files?.length) return;
    setBusy("photo");
    setError(null);
    try {
      for (const f of [...files]) {
        if (f.size > MAX_BYTES) throw new Error(`${f.name} is over 15 MB`);
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        await trpc.gaps2.jobPhotoUpload.mutate({
          orgId,
          jobId,
          filename: f.name.slice(0, 200),
          contentType: f.type || "image/jpeg",
          bytesBase64: btoa(bin),
          // The file's own timestamp is the best capture time a browser can see.
          captureAt: new Date(f.lastModified || Date.now()).toISOString(),
        });
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error && !("data" in err) ? err.message : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-2 text-base font-medium">
        Add photos
        <input type="file" accept="image/*" multiple disabled={busy !== null} onChange={(e) => void uploadPhotos(e.currentTarget.files)} className={`${inputCls} file:mr-4 file:rounded-full file:border-0 file:bg-soft file:px-4 file:py-2 file:text-ink`} />
      </label>
      <form
        className="flex flex-col gap-3"
        action={async () => {
          setBusy("note");
          setError(null);
          try {
            await trpc.gaps2.jobNoteAdd.mutate({ orgId, jobId, text: note });
            setNote("");
            router.refresh();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(null);
          }
        }}
      >
        <label className="flex flex-col gap-2 text-base font-medium">
          Add a note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={5000} placeholder="e.g. Hail bruising on the north slope, 8 per test square." className={inputCls} />
        </label>
        <button type="submit" disabled={busy !== null || note.trim().length < 2} className={`${note.trim().length >= 2 ? buttonCls : quietButtonCls} self-start`}>
          {busy === "note" ? "Adding…" : "Add note"}
        </button>
      </form>
      {busy === "photo" && <p role="status" className="text-muted">Uploading and hashing…</p>}
      <ErrorText message={error} />
    </div>
  );
}
