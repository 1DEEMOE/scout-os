import { Suspense } from "react";
import { googleSignInEnabled } from "@/server/auth";
import { AcceptInvite } from "./accept";

export const dynamic = "force-dynamic";
export const metadata = { title: "Open your workspace" };

/** The one link a new client gets: set a password (or use Google) and land in a ready workspace. */
export default function AcceptInvitePage() {
  return (
    <div className="mx-auto flex max-w-md flex-col gap-8">
      <Suspense>
        <AcceptInvite google={googleSignInEnabled()} />
      </Suspense>
    </div>
  );
}
