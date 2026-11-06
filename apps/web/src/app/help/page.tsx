import { BRAND } from "@/brand";
import { LevelsLegend } from "../ui";

export const metadata = { title: "Help & install" };

const h2 = "text-xl font-semibold";
const card = "flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-7";
const steps = "list-decimal space-y-2 pl-5";

/** Help: nothing to install, optional home-screen and desktop shortcuts, and keyboard shortcuts. */
export default function HelpPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-10">
      <header>
        <h1 className="text-display font-semibold">Help &amp; install</h1>
        <p className="mt-3 text-lg text-muted">
          {BRAND.name} runs in your web browser. There&apos;s nothing to download or install. Sign in from any phone or computer and your workspace is there.
        </p>
      </header>

      <section aria-labelledby="phone" className={card}>
        <h2 id="phone" className={h2}>Put it on your phone&apos;s home screen</h2>
        <p className="text-muted">It opens full screen like an app, with its own icon.</p>
        <h3 className="font-semibold">iPhone or iPad (Safari)</h3>
        <ol className={steps}>
          <li>Open your workspace in Safari.</li>
          <li>Tap the Share button.</li>
          <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        </ol>
        <h3 className="font-semibold">Android (Chrome)</h3>
        <ol className={steps}>
          <li>Open your workspace in Chrome.</li>
          <li>Tap the menu (three dots).</li>
          <li>Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li>
        </ol>
      </section>

      <section aria-labelledby="desktop" className={card}>
        <h2 id="desktop" className={h2}>Optional: a desktop shortcut</h2>
        <p className="text-muted">Only if you&apos;d like one. A bookmark works just as well.</p>
        <ul className="list-disc space-y-2 pl-5">
          <li><strong>Chrome:</strong> menu, then <strong>Cast, save and share</strong>, then <strong>Install page as app</strong> (or <strong>Create shortcut</strong>).</li>
          <li><strong>Microsoft Edge:</strong> menu, then <strong>Apps</strong>, then <strong>Install this site as an app</strong>.</li>
          <li><strong>Safari on Mac:</strong> <strong>File</strong>, then <strong>Add to Dock</strong>.</li>
        </ul>
        <p className="text-small text-muted">Menu names change between browser versions, so yours may differ slightly.</p>
      </section>

      <section aria-labelledby="levels" className={card}>
        <h2 id="levels" className={h2}>Approval levels</h2>
        <p className="text-muted">Every action Scout&apos;s teammates take has a level. The level decides whether it runs on its own or waits for you.</p>
        <LevelsLegend />
        <p className="text-small text-muted">Owner only: bank-detail changes, invoices held as possibly forged, and Scout&apos;s first message to a new prospect. Nothing is ever paid automatically.</p>
      </section>

      <section aria-labelledby="keys" className={card}>
        <h2 id="keys" className={h2}>Keyboard shortcuts</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
          <dt><kbd className="rounded-md border border-line px-2 py-0.5">Ctrl K</kbd> or <kbd className="rounded-md border border-line px-2 py-0.5">⌘K</kbd></dt>
          <dd>Search and jump to any page or action</dd>
          <dt><kbd className="rounded-md border border-line px-2 py-0.5">Ctrl \</kbd> or <kbd className="rounded-md border border-line px-2 py-0.5">⌘\</kbd></dt>
          <dd>Collapse or expand the sidebar</dd>
          <dt><kbd className="rounded-md border border-line px-2 py-0.5">Tab</kbd></dt>
          <dd>Move between controls; the first stop skips straight to the page</dd>
        </dl>
      </section>

      <p><a className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4" href="/orgs">Back to your workspaces</a></p>
    </div>
  );
}
