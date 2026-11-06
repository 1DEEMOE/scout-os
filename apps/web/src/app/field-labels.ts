/**
 * Plain-English names for action fields shown to people (approval warnings).
 * Internal argument names like "customerEmail" never reach the screen.
 */
const LABELS: Record<string, string> = {
  to: "recipient address",
  cc: "copy address",
  bcc: "blind copy address",
  from: "sender address",
  subject: "subject line",
  body: "message text",
  text: "message text",
  email: "email address",
  contactEmail: "contact's email",
  customerEmail: "customer's email",
  customerName: "customer's name",
  customerPhone: "customer's phone",
  name: "name",
  phone: "phone number",
  notes: "notes",
  note: "note",
  amountCents: "amount",
  amount: "amount",
  currency: "currency",
  dueDate: "due date",
  description: "description",
  company: "company name",
  dealName: "deal name",
  stage: "deal stage",
  accountLast4: "account number",
  routingNumber: "routing number",
};

export function fieldLabel(key: string): string {
  if (LABELS[key]) return LABELS[key];
  // Unknown key: "billingAddress_line1" → "billing address line 1".
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** "the customer's email, the customer's name and the notes" */
export function fieldList(keys: string[]): string {
  const words = [...new Set(keys.map(fieldLabel))].map((w) => `the ${w}`);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
