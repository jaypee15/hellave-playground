import type { LobbyParticipant } from "@hellave/js-sdk";

interface Props {
  waiting: readonly LobbyParticipant[];
  onAdmit: (participantId: string) => void;
  onDeny: (participantId: string) => void;
}

/**
 * Admission requests, as a stack of cards over the grid.
 *
 * Deliberately not a blocking modal: a host should be able to keep talking while someone
 * waits, which is also how the lobby behaves on the server.
 */
export default function LobbyRequests({ waiting, onAdmit, onDeny }: Props) {
  if (waiting.length === 0) return null;

  return (
    <div
      data-testid="lobby-panel"
      className="absolute right-4 top-4 z-20 w-72 space-y-2"
    >
      {waiting.map((participant) => (
        <div
          key={participant.id}
          className="rounded-xl bg-room-800 p-3 shadow-lg ring-1 ring-room-600"
        >
          <p className="text-sm">
            <span className="font-medium">{participant.profile.displayName}</span>
            <span className="text-room-400"> wants to join</span>
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onAdmit(participant.id)}
              className="flex-1 rounded-lg bg-accent-strong px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent"
            >
              Admit
            </button>
            <button
              type="button"
              onClick={() => onDeny(participant.id)}
              className="flex-1 rounded-lg bg-room-700 px-3 py-1.5 text-sm font-medium text-room-200 transition-colors hover:bg-room-600"
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
