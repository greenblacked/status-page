import { AttentionCard } from "@/components/status/attention-card";
import { ReleaseRow } from "@/components/status/release-row";
import type { ServiceCardProps } from "@/components/status/service-card-shared";
import { ServiceRow } from "@/components/status/service-row";

export type { ServiceCardProps } from "@/components/status/service-card-shared";

/**
 * The one entry for a service on the board. It picks the shape by what the
 * service needs, and every shape is one <article id="service-x">:
 *
 *   outage, degraded, maintenance   AttentionCard  (Needs a look)
 *   unknown                         ServiceRow     (Couldn't read: the unknown glyph, "No data")
 *   operational release tracker     ReleaseRow     (Releases)
 *   operational                     ServiceRow     (the compact list of its category)
 *
 * A card that moves between shapes is a new node (it changes sections too),
 * so its place is looked up by id, never by position.
 */
export function ServiceCard(props: ServiceCardProps) {
  const { health, category } = props.service;
  if (health === "outage" || health === "degraded" || health === "maintenance") return <AttentionCard {...props} />;
  if (health === "operational" && category === "updates") return <ReleaseRow {...props} />;
  return <ServiceRow {...props} />;
}
