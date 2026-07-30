import { useEffect, useRef } from "react";

interface Props {
  events: Array<{ time: string; msg: string }>;
}

export default function EventsPanel({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      background: "#1f2937",
      color: "#e5e7eb",
      fontFamily: "monospace",
      fontSize: 13,
      padding: 12,
      maxHeight: 200,
      overflowY: "auto",
    }}>
      <div style={{ fontWeight: 600, marginBottom: 8, color: "#9ca3af" }}>Events</div>
      {events.length === 0 && <div style={{ color: "#6b7280" }}>No events yet</div>}
      {events.map((e, i) => (
        <div key={i}>
          <span style={{ color: "#6b7280" }}>[{e.time}]</span> {e.msg}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
