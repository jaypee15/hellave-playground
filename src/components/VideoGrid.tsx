import VideoTile, { type TileParticipant } from "./VideoTile.js";

interface Props {
  participants: TileParticipant[];
  /** Participant shown large in speaker view; falls back to the first tile. */
  featuredId: string | null;
  view: "grid" | "speaker";
}

/**
 * Column count for a balanced grid.
 *
 * Chosen from the participant count rather than by CSS auto-fill so tiles stay close to 16:9
 * and the last row is not left with one stretched tile.
 */
function columnsFor(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count <= 4) return "grid-cols-1 sm:grid-cols-2";
  if (count <= 9) return "grid-cols-2 lg:grid-cols-3";
  return "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";
}

export default function VideoGrid({ participants, featuredId, view }: Props) {
  if (participants.length === 0) {
    return (
      <div
        data-testid="empty-room"
        className="flex h-full items-center justify-center text-room-400"
      >
        <div className="text-center">
          <div className="mb-2 text-4xl">👋</div>
          <p className="font-medium">You are the only one here</p>
          <p className="text-sm">Share the room ID for others to join.</p>
        </div>
      </div>
    );
  }

  if (view === "speaker") {
    const featured =
      participants.find((participant) => participant.id === featuredId) ?? participants[0]!;
    const others = participants.filter((participant) => participant.id !== featured.id);
    return (
      <div data-testid="speaker-view" className="flex h-full flex-col gap-3">
        <div className="min-h-0 flex-1">
          <VideoTile participant={featured} prominent />
        </div>
        {others.length > 0 && (
          <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
            {others.map((participant) => (
              <div key={participant.id} className="w-44 shrink-0">
                <VideoTile participant={participant} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="video-grid"
      className={`grid h-full auto-rows-min content-center gap-3 overflow-y-auto ${columnsFor(
        participants.length,
      )}`}
    >
      {participants.map((participant) => (
        <VideoTile key={participant.id} participant={participant} />
      ))}
    </div>
  );
}
