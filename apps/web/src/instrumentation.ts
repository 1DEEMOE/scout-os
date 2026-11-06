import { registerOTel } from "@vercel/otel";

// Traces are exported only when a collector is configured.
export function register() {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    registerOTel({ serviceName: "workforce-os" });
  }
}
