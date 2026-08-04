import { useState, type FormEvent } from "react";

interface Props {
  onCreated: (displayName: string, lobbyEnabled: boolean) => Promise<void>;
  onJoined: (roomInstanceId: string, displayName: string) => Promise<void>;
  /** Room carried in by an invite link, if this page was opened with one. */
  invitedRoomInstanceId?: string;
}

const INPUT_CLASS =
  "w-full rounded-lg bg-room-850 px-3.5 py-2.5 text-sm text-room-200 outline-none ring-1 " +
  "ring-room-700 placeholder:text-room-400 focus:ring-2 focus:ring-accent";

const PRIMARY_CLASS =
  "w-full rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-white " +
  "transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

export default function HomePage({
  onCreated,
  onJoined,
  invitedRoomInstanceId = "",
}: Props) {
  // An invite already answers both "create or join" and "which room", so it opens on the join
  // form with only a name left to give.
  const [mode, setMode] = useState<"choose" | "create" | "join">(
    invitedRoomInstanceId ? "join" : "choose",
  );
  const [displayName, setDisplayName] = useState("");
  const [roomInstanceId, setRoomInstanceId] = useState(invitedRoomInstanceId);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [lobbyEnabled, setLobbyEnabled] = useState(false);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onCreated(displayName, lobbyEnabled);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onJoined(roomInstanceId, displayName);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-room-950 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Hellave</h1>
          <p className="mt-1 text-sm text-room-400">
            A playground for the real-time communication SDK
          </p>
        </div>

        <div className="rounded-2xl bg-room-900 p-6 ring-1 ring-room-700">
          {mode === "choose" && (
            <div className="space-y-3">
              <button type="button" onClick={() => setMode("create")} className={PRIMARY_CLASS}>
                Create a Room
              </button>
              <button
                type="button"
                onClick={() => setMode("join")}
                className="w-full rounded-lg bg-room-800 px-4 py-2.5 text-sm font-medium text-room-200 transition-colors hover:bg-room-700"
              >
                Join a Room
              </button>
            </div>
          )}

          {mode === "create" && (
            <form onSubmit={handleCreate} className="space-y-4">
              <h2 className="text-sm font-medium text-white">Create a Room</h2>
              <input
                placeholder="Your name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                autoFocus
                className={INPUT_CLASS}
              />
              <label className="flex cursor-pointer items-center gap-2 text-sm text-room-400">
                <input
                  type="checkbox"
                  checked={lobbyEnabled}
                  onChange={(e) => setLobbyEnabled(e.target.checked)}
                  data-testid="lobby-toggle"
                  className="h-4 w-4 accent-indigo-500"
                />
                Require admission (lobby)
              </label>
              <button type="submit" disabled={loading} className={PRIMARY_CLASS}>
                {loading ? "Creating..." : "Create & Join"}
              </button>
            </form>
          )}

          {mode === "join" && (
            <form onSubmit={handleJoin} className="space-y-4">
              <h2 className="text-sm font-medium text-white">
                {invitedRoomInstanceId ? "You have been invited" : "Join a Room"}
              </h2>
              <input
                placeholder="Room Instance ID"
                value={roomInstanceId}
                onChange={(e) => setRoomInstanceId(e.target.value)}
                required
                autoFocus={!invitedRoomInstanceId}
                data-testid="join-room-instance-id"
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
              <input
                placeholder="Your name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                autoFocus={Boolean(invitedRoomInstanceId)}
                className={INPUT_CLASS}
              />
              <button type="submit" disabled={loading} className={PRIMARY_CLASS}>
                {loading ? "Joining..." : "Join"}
              </button>
            </form>
          )}

          {error && (
            <p
              data-testid="home-error"
              className="mt-4 rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}

          {mode !== "choose" && (
            <button
              type="button"
              onClick={() => { setMode("choose"); setError(""); }}
              className="mt-4 w-full text-xs text-room-400 transition-colors hover:text-room-200"
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
