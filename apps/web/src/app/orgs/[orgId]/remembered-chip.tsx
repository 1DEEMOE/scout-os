"use client";
import { ActionButton } from "../../actions";

/** In-chat chip for a fact Scout just stored. Undo calls the real forget action. */
export function RememberedChip({ orgId, memoryId, text }: { orgId: string; memoryId: string; text: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2">
      <span className="inline-flex min-h-10 items-center rounded-full border border-accent/40 bg-accent-soft px-4 text-base text-ink">Remembered: {text}</span>
      <ActionButton path="memory.forget" input={{ orgId, memoryId }} label="Undo" variant="quiet" confirm="Forget this?" />
    </p>
  );
}
