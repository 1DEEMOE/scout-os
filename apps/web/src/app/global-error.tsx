"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "sans-serif", margin: "2rem" }}>
        <h1>Something went wrong</h1>
        <p>Scout OS hit a problem before the page could load. Your data was not changed.</p>
        <button type="button" onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
