import { BRAND } from "@/brand";

/** Wordmark: an original compass-style mark plus the product name. */
export function BrandMark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6">
        <rect width="24" height="24" rx="6" className="fill-accent" />
        <circle cx="12" cy="12" r="6.5" fill="none" strokeWidth="1.6" className="stroke-on-accent" opacity="0.55" />
        <path d="M12 6.5 L14.2 12 L12 17.5 L9.8 12 Z" className="fill-on-accent" />
      </svg>
      {BRAND.name}
    </span>
  );
}
