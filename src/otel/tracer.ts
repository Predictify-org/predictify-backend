import { type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});

const tracerInstance: Tracer = provider.getTracer("predictify-backend", "0.1.0");

export function getTracer(): Tracer {
  return tracerInstance;
}
