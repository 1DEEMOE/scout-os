// Next.js instrumentation hook: starts OTel in the nodejs runtime when a
// collector endpoint is configured. Without OTEL_EXPORTER_OTLP_ENDPOINT this
// is a no-op.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initOtel } = await import("@wos/core");
    await initOtel("scout-os-web");
  }
}
