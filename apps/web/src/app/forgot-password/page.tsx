import { platformEmailConfigured } from "@wos/core";
import { ForgotPasswordForm } from "./form";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm emailConfigured={platformEmailConfigured()} />;
}
