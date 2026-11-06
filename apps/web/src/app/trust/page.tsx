import type { Metadata } from "next";

export const metadata: Metadata = { title: "How Scout OS handles trust" };

const card = "flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-7 sm:p-8";

/**
 * Public explanation. No customer counts, no certifications, no performance claims.
 */
export default function TrustPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-12 px-6 py-16">
      <header className="flex flex-col gap-4">
        <p className="text-muted">Scout OS</p>
        <h1 className="text-display font-semibold">How decisions are kept</h1>
        <p className="text-lg leading-relaxed text-muted">
          This page describes how the product is built. It is not a customer list, not a security certification, and not a promise about any particular business.
        </p>
      </header>

      <section className={card} aria-labelledby="approvals">
        <h2 id="approvals" className="text-xl font-semibold">Approvals live in the software, not in a prompt</h2>
        <p className="leading-relaxed">Reading and internal notes can run on their own. Sending a message, changing a price, or paying someone waits for a person.</p>
        <ul className="flex flex-col gap-3 leading-relaxed">
          <li>Everyday reads and internal notes are the only things that run without a person.</li>
          <li>Email, text, and other messages wait for a person, unless that person already approved that exact template.</li>
          <li>Money and contracts always wait for a person. Nothing is paid automatically.</li>
          <li>Deleting or changing access needs a second, different owner.</li>
          <li>A routine can only list or draft. It cannot send or pay on its own.</li>
        </ul>
      </section>

      <section className={card} aria-labelledby="isolation">
        <h2 id="isolation" className="text-xl font-semibold">One business cannot see another</h2>
        <p className="leading-relaxed">Each workspace&apos;s rows are filtered in the database. A person signed into one business is not handed another business&apos;s leads, invoices, or messages.</p>
      </section>

      <section className={card} aria-labelledby="audit">
        <h2 id="audit" className="text-xl font-semibold">The audit log is chained</h2>
        <p className="leading-relaxed">Important actions are appended with a hash of the previous entry. The app does not offer a way to edit or delete those rows.</p>
      </section>

      <section className={card} aria-labelledby="outreach">
        <h2 id="outreach" className="text-xl font-semibold">Outreach asks first</h2>
        <p className="leading-relaxed">Texts are not sent without a recorded yes. STOP and the usual opt-out words are honored. Texts stay between 8am and 9pm in the recipient&apos;s local time. A pre-approved template is a human approval of that wording. A reply that is not that template waits in Approvals.</p>
      </section>

      <p><a className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4" href="/help">Help &amp; install</a></p>
    </div>
  );
}
