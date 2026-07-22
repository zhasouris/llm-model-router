/**
 * OpenTelemetry bootstrap — traces, metrics, and logs (ADR 0004, ADR 0008).
 *
 * Instrumentation is vendor-neutral; the backend is an exporter choice selected
 * in server.yaml: console (dev), OTLP (generic collector), and/or Azure Monitor
 * (Application Insights). Best-effort — a telemetry failure never stops the proxy.
 */

import { logs } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { AppConfig } from "./config.js";

let configured = false;

/** Derive a sibling OTLP signal endpoint from the configured traces endpoint. */
function otlpEndpoint(tracesEndpoint: string, signal: "metrics" | "logs"): string {
  return tracesEndpoint.replace(/\/v1\/traces\/?$/, `/v1/${signal}`);
}

function azureConnectionString(): string | undefined {
  return process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
}

export function setupTelemetry(config: AppConfig): void {
  if (configured) return;
  configured = true;

  const tel = config.server.telemetry;
  const resource = new Resource({ [ATTR_SERVICE_NAME]: tel.service_name });
  const azureConn = azureConnectionString();
  const azureOn = tel.azure_monitor.enabled && Boolean(azureConn);
  if (tel.azure_monitor.enabled && !azureConn) {
    console.warn("azure_monitor enabled but APPLICATIONINSIGHTS_CONNECTION_STRING is unset");
  }

  setupTraces(resource, tel, azureOn, azureConn).catch(warn("traces"));
  if (tel.metrics.enabled) setupMetrics(resource, tel, azureOn, azureConn).catch(warn("metrics"));
  if (tel.logs.enabled) setupLogs(resource, tel, azureOn, azureConn).catch(warn("logs"));
}

// Pass the signal name as a separate argument rather than interpolating it into
// the format string (keeps static analysers happy and logs structured).
const warn = (what: string) => (err: unknown) =>
  console.warn("telemetry setup failed, continuing:", what, (err as Error).message);

async function setupTraces(
  resource: Resource,
  tel: AppConfig["server"]["telemetry"],
  azureOn: boolean,
  azureConn?: string,
): Promise<void> {
  const provider = new NodeTracerProvider({ resource });
  if (tel.console_export) {
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }
  if (tel.otlp.enabled) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    provider.addSpanProcessor(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tel.otlp.endpoint })),
    );
  }
  if (azureOn) {
    const { AzureMonitorTraceExporter } = await import("@azure/monitor-opentelemetry-exporter");
    // Cast bridges a bundled-OTel version skew between the Azure exporter and our SDK.
    const exporter = new AzureMonitorTraceExporter({
      connectionString: azureConn,
    }) as unknown as SpanExporter;
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  }
  provider.register();
}

async function setupMetrics(
  resource: Resource,
  tel: AppConfig["server"]["telemetry"],
  azureOn: boolean,
  azureConn?: string,
): Promise<void> {
  const readers: PeriodicExportingMetricReader[] = [];
  if (tel.console_export) {
    readers.push(new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() }));
  }
  if (tel.otlp.enabled) {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpEndpoint(tel.otlp.endpoint, "metrics") }),
      }),
    );
  }
  if (azureOn) {
    const { AzureMonitorMetricExporter } = await import("@azure/monitor-opentelemetry-exporter");
    const exporter = new AzureMonitorMetricExporter({
      connectionString: azureConn,
    }) as unknown as PushMetricExporter;
    readers.push(new PeriodicExportingMetricReader({ exporter }));
  }
  const provider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(provider);
}

async function setupLogs(
  resource: Resource,
  tel: AppConfig["server"]["telemetry"],
  azureOn: boolean,
  azureConn?: string,
): Promise<void> {
  const provider = new LoggerProvider({ resource });
  if (tel.console_export) {
    provider.addLogRecordProcessor(new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()));
  }
  if (tel.otlp.enabled) {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
    provider.addLogRecordProcessor(
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: otlpEndpoint(tel.otlp.endpoint, "logs") }),
      ),
    );
  }
  if (azureOn) {
    const { AzureMonitorLogExporter } = await import("@azure/monitor-opentelemetry-exporter");
    provider.addLogRecordProcessor(
      new BatchLogRecordProcessor(new AzureMonitorLogExporter({ connectionString: azureConn })),
    );
  }
  logs.setGlobalLoggerProvider(provider);
}
