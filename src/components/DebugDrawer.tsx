import { useEffect, useRef, useState } from "react";

interface Props {
  events: Array<{ time: string; msg: string }>;
  roomId: string;
  roomInstanceId: string;
  peerId: string;
  spotlight: string | null;
  raisedHands: readonly string[];
  /**
   * Video this participant is actually receiving, as `source:publicationId`.
   *
   * Worth surfacing because the SFU bounds how much video any one subscriber receives, so in a
   * busy room "why can I not see them" is usually answered by what is missing from this list —
   * and that is invisible from the grid, which looks the same whether a publication was never
   * sent or merely never rendered.
   */
  receivedVideo: readonly string[];
}

/**
 * Developer diagnostics, collapsed by default.
 *
 * This is a playground, so the event log and identities earn their place — but they are not
 * part of a meeting, so they stay behind a toggle. Anything a test reads with innerText must
 * live in the header instead, because hidden elements report no text.
 */
export default function DebugDrawer({
  events,
  roomId,
  roomInstanceId,
  peerId,
  spotlight,
  raisedHands,
  receivedVideo,
}: Props) {
  const [open, setOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        data-testid="debug-toggle"
        aria-label={open ? "Hide diagnostics" : "Debug"}
        title={open ? "Hide diagnostics" : "Debug"}
        className="shrink-0 rounded-lg bg-room-800 px-2.5 py-1.5 text-xs font-medium text-room-400 transition-colors hover:bg-room-700 hover:text-room-200 sm:px-3"
      >
        <span aria-hidden="true" className="sm:hidden">{open ? "✕" : "🐞"}</span>
        <span className="hidden sm:inline">{open ? "Hide" : "Debug"}</span>
      </button>

      {open && (
        <div
          data-testid="debug-drawer"
          className="absolute bottom-20 left-1/2 z-30 max-h-72 w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-xl bg-room-900 p-4 font-mono text-xs shadow-2xl ring-1 ring-room-700"
        >
          <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-room-400">
            <dt>room</dt>
            <dd className="truncate text-room-200">{roomId}</dd>
            <dt>instance</dt>
            <dd className="truncate text-room-200">{roomInstanceId}</dd>
            <dt>peer</dt>
            <dd className="truncate text-room-200">{peerId}</dd>
            <dt>spotlight</dt>
            <dd data-testid="spotlight" className="truncate text-room-200">
              {spotlight ?? "none"}
            </dd>
            <dt>hands</dt>
            <dd data-testid="raised-hands" className="truncate text-room-200">
              {raisedHands.length > 0 ? raisedHands.join(", ") : "none"}
            </dd>
            <dt>video in</dt>
            <dd data-testid="received-video" className="break-all text-room-200">
              {receivedVideo.length > 0 ? receivedVideo.join(" ") : "none"}
            </dd>
          </dl>

          <div className="border-t border-room-700 pt-2">
            {events.length === 0 && <div className="text-room-600">No events yet</div>}
            {events.map((event, index) => (
              <div key={index} className="leading-relaxed">
                <span className="text-room-600">[{event.time}]</span>{" "}
                <span className="text-room-200">{event.msg}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </>
  );
}
