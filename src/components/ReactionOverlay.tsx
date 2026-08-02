export interface FloatingReaction {
  key: number;
  from: string;
  reaction: string;
  /** Horizontal position as a percentage, so simultaneous reactions do not overlap. */
  offset: number;
}

const REACTION_EMOJI: Record<string, string> = {
  thumbs_up: "👍",
  thumbs_down: "👎",
  clap: "👏",
  heart: "❤️",
  laugh: "😂",
  surprised: "😮",
};

interface Props {
  reactions: FloatingReaction[];
}

/**
 * Reactions floating up over the grid.
 *
 * Rendered in a pointer-events-none layer so it never intercepts clicks meant for the tiles
 * or the control bar underneath.
 */
export default function ReactionOverlay({ reactions }: Props) {
  return (
    <div
      data-testid="reactions"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {reactions.map((reaction) => (
        <div
          key={reaction.key}
          className="animate-float-up absolute bottom-4 flex flex-col items-center"
          style={{ left: `${reaction.offset}%` }}
        >
          <span className="text-4xl">{REACTION_EMOJI[reaction.reaction] ?? "✨"}</span>
          <span className="max-w-24 truncate rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white">
            {reaction.from}
          </span>
        </div>
      ))}
    </div>
  );
}
