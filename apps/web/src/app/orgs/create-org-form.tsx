"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../ui";

export function CreateOrgForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(form: FormData) {
    setBusy(true);
    setError(null);
    try {
      const { orgId } = await trpc.org.create.mutate({ name: String(form.get("name") ?? "") });
      router.push(`/orgs/${orgId}/setup`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h2 className="font-semibold">Create an organization</h2>
      <label className="flex flex-col gap-1 text-sm">
        Organization name
        <input name="name" required maxLength={120} className={inputCls} />
      </label>
      <ErrorText message={error} />
      <button disabled={busy} className={`${buttonCls} self-start`}>{busy ? "Creating…" : "Create"}</button>
    </form>
  );
}
