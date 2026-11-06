"use client";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/server/root";

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

export function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError) return err.message;
  return "Something went wrong. Please try again.";
}
