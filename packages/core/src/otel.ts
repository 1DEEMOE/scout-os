import { logger } from "./logger";

/** The slice of the OTel NodeSDK we use, typed structurally. */
interface OtelSdk {
  start(): void;
  shutdown(): Promise<void>;
}

let sdk: OtelSdk | undefined;

/**
 * Registers the OpenTelemetry NodeSDK when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (traces then flow to that collector, with pg/HTTP auto-instrumentation).
 * Without the endpoint, tracing stays a no-op and this does nothing. Safe to
 * call more than once.
 *
 * The SDK is loaded through a variable specifier on purpose: its type graph
 * (every auto-instrumentation package) is heavy, and keeping it out of static
 * analysis is the difference between the Next.js build fitting in memory or
 * not. At runtime Node resolves it from @wos/core's dependencies as usual.
 */
export async function initOtel(serviceName: string): Promise<void> {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const sdkModule = "@opentelemetry/sdk-node";
  const { NodeSDK } = (await import(sdkModule)) as { NodeSDK: new (cfg: { serviceName: string }) => OtelSdk };
  const instance = new NodeSDK({ serviceName });
  instance.start();
  sdk = instance;
  logger.info({ serviceName }, "opentelemetry sdk started");
}

/** Flushes pending spans. Call before process exit. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const s = sdk;
  sdk = undefined;
  await s.shutdown().catch((err) => logger.warn({ err }, "otel shutdown failed"));
}
