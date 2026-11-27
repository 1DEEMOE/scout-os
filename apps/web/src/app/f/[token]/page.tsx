import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError, getPublicLeadForm } from "@wos/core";
import { LeadForm } from "./lead-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact us", robots: { index: false, follow: false } };

/**
 * Public lead-capture page for a business's website ("Contact us"). No
 * sign-in. Shares the front-desk link's token: pausing the booking link
 * closes this page too. Every submission lands on the business's sales board.
 */
export default async function LeadFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const form = await getPublicLeadForm(token).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold break-words">Contact {form.businessName}</h1>
        <p className="mt-1 text-sm text-muted">{form.intro || `Send ${form.businessName} a message and they'll get back to you.`}</p>
      </div>
      <LeadForm
        token={token}
        successMessage={form.successMessage}
        askPhone={form.askPhone}
        askCompany={form.askCompany}
        askMessage={form.askMessage}
        disclosure={form.disclosure}
      />
    </div>
  );
}
