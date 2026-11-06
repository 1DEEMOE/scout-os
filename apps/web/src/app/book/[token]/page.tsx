import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError, listAvailability } from "@wos/core";
import { BookingForm } from "./booking-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Book a time", robots: { index: false, follow: false } };

/**
 * Public booking page for a front-desk link. No sign-in. Shows open times in
 * the business's time zone and sends a request that a person at the business
 * approves; nothing is confirmed here.
 */
export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await listAvailability(token, new Date(), new Date(Date.now() + 30 * 86_400_000)).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const tz = data.channel.timezone;
  const days = new Map<string, { id: string; label: string; remaining: number }[]>();
  for (const s of data.slots) {
    const start = new Date(s.startsAt);
    const day = start.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
    const time = `${start.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })} – ${new Date(s.endsAt).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
    days.set(day, [...(days.get(day) ?? []), { id: s.id, label: time, remaining: s.remaining }]);
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-display font-semibold">Book a time with {data.channel.displayName}</h1>
        <p className="mt-1 text-sm text-muted">Times shown in {tz.replace(/_/g, " ")}. Someone at {data.channel.displayName} will confirm your request.</p>
      </div>
      {days.size === 0 ? (
        <p className="rounded-md border border-line p-4 text-sm">No open times in the next 30 days. Please contact {data.channel.displayName} directly.</p>
      ) : (
        <BookingForm token={token} days={[...days.entries()]} disclosure={data.channel.disclosure} businessName={data.channel.displayName} />
      )}
    </div>
  );
}
