import { useMemo } from "react";
import type { RunEvent } from "../api.js";

interface RunTimelineProps {
  events: RunEvent[];
}

export function RunTimeline({ events }: RunTimelineProps) {
  const orderedEvents = useMemo(
    () =>
      [...events].sort((left, right) => {
        const leftTime = Date.parse(left.created_at ?? "");
        const rightTime = Date.parse(right.created_at ?? "");
        return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
      }),
    [events]
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Run Timeline</h2>
          <span>{orderedEvents.length}</span>
        </div>
      </div>
      <ol className="timeline">
        {orderedEvents.map((event, index) => (
          <li key={String(event.id ?? `${event.event_type ?? event.eventType}-${index}`)}>
            <time>{formatDate(event.created_at)}</time>
            <div>
              <strong>{event.event_type ?? event.eventType ?? "event"}</strong>
              <span>{event.phase ?? "-"}</span>
            </div>
            <p>{event.message ?? "-"}</p>
            <small>{event.source ?? "system"} {event.attempt ? `attempt ${event.attempt}` : ""}</small>
          </li>
        ))}
        {orderedEvents.length === 0 ? <li className="empty-copy">No events recorded.</li> : null}
      </ol>
    </section>
  );
}

function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(time);
}
