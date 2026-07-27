import { trace, type Span, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const TRACER_NAME = 'unified-service-scheduler';

/**
 * Wires OpenTelemetry with a console exporter only.
 *
 * The scope here is deliberately narrow (CLAUDE.md observability): a production
 * deployment would point the exporter at a collector, but that is described in
 * the design document rather than built, because building it would demonstrate
 * no design decision. What matters and is real are the span boundaries — the
 * HTTP handler, the availability query, and the insert transaction — created via
 * `withSpan` below. Those calls are no-ops until this provider is registered, so
 * tests stay quiet and only the running server emits spans.
 */
export function startTracing(): NodeTracerProvider {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: TRACER_NAME }),
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  provider.register();
  return provider;
}

export function tracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Runs `work` inside a span, recording failure and always ending the span. */
export async function withSpan<T>(name: string, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });
}
