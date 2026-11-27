"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "@/lib/trpc";
import { buttonCls, ErrorText, inputCls } from "../../../../ui";

export function DealForm({
  orgId,
  contacts,
  members,
  currentUserId,
}: {
  orgId: string;
  contacts: { id: string; name: string; email: string | null }[];
  members: { userId: string; name: string }[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [contactId, setContactId] = useState("");
  const [amount, setAmount] = useState("");
  const [expectedClose, setExpectedClose] = useState("");
  const [ownerUserId, setOwnerUserId] = useState(currentUserId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = amount.trim() ? Math.round(Number(amount) * 100) : null;
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError("Amount must be a positive number.");
      return;
    }
    setBusy(true);
    try {
      const r = await trpc.crm.createDeal.mutate({
        orgId,
        name,
        contactId: contactId || null,
        amountCents: parsed,
        expectedClose: expectedClose || null,
        ownerUserId: ownerUserId || null,
      });
      router.push(`/orgs/${orgId}/sales/deals/${r.dealId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-5">
      <label className="flex flex-col gap-2">
        <span className="font-medium">Deal name</span>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="e.g. Roof replacement — Chen" />
      </label>
      <label className="flex flex-col gap-2">
        <span className="font-medium">Contact</span>
        <select className={inputCls} value={contactId} onChange={(e) => setContactId(e.target.value)}>
          <option value="">No contact yet</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || c.email || "Unnamed"}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="font-medium">Amount ($)</span>
          <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="5000.00" />
        </label>
        <label className="flex flex-col gap-2">
          <span className="font-medium">Expected close</span>
          <input className={inputCls} type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-2">
        <span className="font-medium">Owner</span>
        <select className={inputCls} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <ErrorText message={error} />
      <div className="sticky bottom-20 lg:bottom-4">
        <button type="submit" className={buttonCls} disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create deal"}
        </button>
      </div>
    </form>
  );
}
