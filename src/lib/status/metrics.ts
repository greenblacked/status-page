import type { BoardSnapshot, Health } from "./types.ts";

// The Prometheus text exposition format, version 0.0.4:
// https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const STATES: Health[] = ["operational", "maintenance", "degraded", "outage", "unknown"];

// Label values escape backslash, double quote and newline, in that order.
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string>): string {
  const body = Object.entries(pairs)
    .map(([key, value]) => `${key}="${label(value)}"`)
    .join(",");
  return `{${body}}`;
}

type Family = {
  name: string;
  help: string;
  samples: Array<{ labels?: Record<string, string>; value: number }>;
};

function render(family: Family): string {
  return [
    `# HELP ${family.name} ${family.help}`,
    `# TYPE ${family.name} gauge`,
    ...family.samples.map((sample) => `${family.name}${sample.labels ? labels(sample.labels) : ""} ${sample.value}`),
  ].join("\n");
}

/**
 * The board as Prometheus gauges, for scraping into Prometheus, Grafana
 * Agent, VictoriaMetrics or anything else that reads the text format.
 *
 * Health is a state set (one series per state, exactly one of them 1), so an
 * alert reads `statusbar_service_status{status="outage"} == 1` instead of
 * depending on a numeric ranking of states. The snapshot's own timestamp is
 * exported rather than its age, so `time() - statusbar_snapshot_timestamp_seconds`
 * stays correct however long a scrape or an edge cache holds the response.
 */
export function prometheusMetrics(board: BoardSnapshot): string {
  const service = (item: BoardSnapshot["services"][number]) => ({
    service: item.id,
    category: item.category,
  });

  const families: Family[] = [
    {
      name: "statusbar_service_status",
      help: "Official status of a service: 1 for its current state, 0 for the others.",
      samples: board.services.flatMap((item) =>
        STATES.map((state) => ({
          labels: { ...service(item), status: state },
          value: item.health === state ? 1 : 0,
        })),
      ),
    },
    {
      name: "statusbar_service_incidents",
      help: "Incidents the official source lists for a service.",
      samples: board.services.map((item) => ({
        labels: service(item),
        value: item.incidentCount ?? item.incidents.length,
      })),
    },
    {
      name: "statusbar_source_up",
      help: "1 if the service's official source was read, 0 if the collector failed.",
      samples: board.services.map((item) => ({ labels: service(item), value: item.failure ? 0 : 1 })),
    },
    {
      name: "statusbar_source_latency_seconds",
      help: "Time the official source took to answer.",
      samples: board.services.map((item) => ({ labels: service(item), value: item.latencyMs / 1000 })),
    },
    {
      name: "statusbar_services",
      help: "Services in each state.",
      samples: STATES.map((state) => ({ labels: { status: state }, value: board.counts[state] })),
    },
    {
      name: "statusbar_snapshot_timestamp_seconds",
      help: "Unix time the board snapshot was collected.",
      samples: [{ value: Date.parse(board.generatedAt) / 1000 }],
    },
    {
      name: "statusbar_snapshot_duration_seconds",
      help: "Time the snapshot took to read every source.",
      samples: [{ value: board.durationMs / 1000 }],
    },
  ];

  return `${families.map(render).join("\n")}\n`;
}
