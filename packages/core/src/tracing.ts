import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("workforce-os");

/** Wraps fn in an OpenTelemetry span. A no-op if no SDK is registered. */
export async function withSpan<T>(name: string, attrs: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
