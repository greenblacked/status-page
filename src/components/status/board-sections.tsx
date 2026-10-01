import type { ReactNode } from "react";
import { ServiceCard } from "@/components/status/service-card";
import { CATEGORIES } from "@/lib/status/catalog";
import type { BoardGroups } from "@/lib/status/layout";
import type { CategoryId, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

/** The healthy status services by category, in catalog order (Cloud, Gaming, Platforms, AI), empty categories left out. */
export function upByCategory(
  services: ServiceSnapshot[],
): Array<{ id: CategoryId; label: string; services: ServiceSnapshot[] }> {
  return CATEGORIES.filter((category) => category.id !== "updates")
    .map((category) => ({
      id: category.id,
      label: category.label,
      services: services.filter((service) => service.category === category.id),
    }))
    .filter((category) => category.services.length > 0);
}

/**
 * A section of the board: its heading and count in the margin column on wide
 * screens (above the list on a phone), and its content in the main column.
 */
function Section({
  group,
  id,
  title,
  count,
  flush = false,
  children,
}: {
  /** The e2e and CSS hook: attention, unread, up or releases. */
  group: "attention" | "unread" | "up" | "releases";
  id: string;
  title: string;
  count: number;
  /** The heading lines up with the top of a card grid rather than the first row of a list. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section data-group={group} aria-labelledby={`${id}-heading`} className="board-grid">
      <div className="board-margin">
        <h2
          id={`${id}-heading`}
          className={cn("mb-2 text-caption font-semibold text-muted md:mb-0", !flush && "md:pt-4")}
        >
          {title} <span className="font-normal text-subtle">{count}</span>
        </h2>
      </div>
      <div className="board-main">{children}</div>
    </section>
  );
}

type Handlers = {
  changedIds: ReadonlySet<ServiceId>;
  starred: ReadonlySet<ServiceId>;
  onToggleStar: (id: ServiceId) => void;
  now: number;
};

/** A grouped list: one card holding a row per service, told apart by an inset hairline. */
function RowList({
  services,
  describedBy,
  changedIds,
  starred,
  onToggleStar,
  now,
}: Handlers & { services: ServiceSnapshot[]; describedBy?: string }) {
  return (
    <ul aria-describedby={describedBy} className="surface spotlight card-list">
      {services.map((service) => (
        <li key={service.id}>
          <ServiceCard
            service={service}
            emphasized={changedIds.has(service.id)}
            starred={starred.has(service.id)}
            onToggleStar={onToggleStar}
            now={now}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Every group of the board, in the order a person reads it: what needs a
 * look (cards), the `feed` (Recent changes), what could not be read (rows),
 * the healthy services by category (rows), and the release trackers (rows).
 * A group with nothing in it is not drawn. A card keeps one
 * <article id="service-x"> wherever it sits.
 *
 * `feed` is a slot: it follows Needs a look, or leads the board when nothing
 * needs a look. It is drawn even when no group is, and always at the same
 * place in the tree, so it is never remounted as the groups come and go.
 * `placeholder` stands where the groups would be while there are none (the
 * loading skeleton, or the message for filters that match nothing).
 *
 * `mostUrgentId` is the board's most urgent service; it carries
 * `data-highlight` only while it leads the attention list.
 */
export function BoardSections({
  groups,
  mostUrgentId,
  changedIds,
  starred,
  onToggleStar,
  now,
  feed,
  placeholder,
}: {
  groups: BoardGroups;
  mostUrgentId?: ServiceId;
  changedIds: ReadonlySet<ServiceId>;
  starred: ReadonlySet<ServiceId>;
  onToggleStar: (id: ServiceId) => void;
  now: number;
  feed?: ReactNode;
  placeholder?: ReactNode;
}) {
  const { attention, unread } = groups;
  const up = upByCategory(groups.operational);
  const handlers = { changedIds, starred, onToggleStar, now };

  return (
    <div className="flex flex-col gap-8">
      {placeholder}

      {attention.length > 0 ? (
        <Section group="attention" id="attention" title="Needs a look" count={attention.length} flush>
          {/* A size container: the grid inside lays out by the width of the column, not the window. */}
          <div className="@container">
            <div className="grid gap-3 @xl:grid-cols-2">
              {attention.map((service, index) => (
                // One element type at every position, so a card that moves in or out of first
                // place is moved, not remounted: keyboard focus stays on its Star button.
                <ServiceCard
                  key={service.id}
                  service={service}
                  highlight={index === 0 && service.id === mostUrgentId}
                  emphasized={changedIds.has(service.id)}
                  starred={starred.has(service.id)}
                  onToggleStar={onToggleStar}
                  now={now}
                />
              ))}
            </div>
          </div>
        </Section>
      ) : null}

      {feed}

      {unread.length > 0 ? (
        <Section group="unread" id="unread" title="Couldn't read" count={unread.length}>
          <p id="unread-note" className="mb-2 text-caption text-subtle">
            I couldn't reach these. That says nothing about whether they're up.
          </p>
          <RowList services={unread} describedBy="unread-note" {...handlers} />
        </Section>
      ) : null}

      {up.map((category) => (
        <Section
          key={category.id}
          group="up"
          id={`up-${category.id}`}
          title={category.label}
          count={category.services.length}
        >
          <RowList services={category.services} {...handlers} />
        </Section>
      ))}

      {groups.releases.length > 0 ? (
        <Section group="releases" id="releases" title="Releases" count={groups.releases.length}>
          <RowList services={groups.releases} {...handlers} />
        </Section>
      ) : null}
    </div>
  );
}
