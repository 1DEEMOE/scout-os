/**
 * Navigation icons: simple geometric line drawings made for Scout OS (24px
 * grid, 1.75 stroke). Decorative only; every use sits next to a text label or
 * an accessible name.
 */
export type IconName =
  | "today"
  | "approvals"
  | "work"
  | "customers"
  | "scout"
  | "leads"
  | "more"
  | "search"
  | "rail"
  | "teammates"
  | "routines"
  | "library"
  | "workspace"
  | "chevron"
  | "close";

const PATHS: Record<IconName, React.ReactNode> = {
  today: <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6.5L6 19.5V16a1.5 1.5 0 0 1-1.5-1.5Z" />,
  approvals: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="m8.75 12.25 2.25 2.25 4.25-4.75" />
    </>
  ),
  work: (
    <>
      <rect x="3.75" y="7.5" width="16.5" height="11.5" rx="2.25" />
      <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.75 12.5h16.5" />
    </>
  ),
  customers: (
    <>
      <circle cx="9.5" cy="8.5" r="3.25" />
      <path d="M3.75 19c.7-3.1 3-4.75 5.75-4.75S14.55 15.9 15.25 19M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.5 14.6c1.5.6 2.5 2.1 2.75 4.4" />
    </>
  ),
  scout: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="m14.75 9.25-1.6 3.9-3.9 1.6 1.6-3.9Z" />
    </>
  ),
  leads: <path d="M4 13.5 6 5.5h12l2 8V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18ZM4 13.5h4.5l1 2h5l1-2H20" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.75 15.75 3.75 3.75" />
    </>
  ),
  rail: (
    <>
      <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
      <path d="M9.5 4.75v14.5" />
    </>
  ),
  teammates: <path d="M12 4.5 13.6 9l4.4 1.5-4.4 1.5L12 16.5 10.4 12 6 10.5 10.4 9ZM18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />,
  routines: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  library: <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v13H6.5A1.5 1.5 0 0 0 5 18.5Zm0 13A1.5 1.5 0 0 0 6.5 20H18M9 8h5" />,
  workspace: (
    <>
      <path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9" />
      <circle cx="15" cy="7.5" r="2" />
      <circle cx="9" cy="16.5" r="2" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
};

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name]}
    </svg>
  );
}
