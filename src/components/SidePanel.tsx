import { useEffect, useRef, useState } from "react";

export interface ChatMessage {
  from: string;
  body: string;
  at: number;
  mine: boolean;
}

export interface PanelParticipant {
  id: string;
  displayName: string;
  role: string;
  handRaised: boolean;
  isLocal: boolean;
}

interface Props {
  open: boolean;
  chat: ChatMessage[];
  participants: PanelParticipant[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (event: React.FormEvent) => void;
  onClose: () => void;
}

function timeOf(at: number): string {
  // The Public Edge stamps chat in Unix seconds; Date expects milliseconds.
  return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SidePanel({
  open,
  chat,
  participants,
  draft,
  onDraftChange,
  onSend,
  onClose,
}: Props) {
  const [tab, setTab] = useState<"chat" | "people">("chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab === "chat") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat, tab]);

  if (!open) return null;

  return (
    <aside
      data-testid="side-panel"
      // Absolute on a phone, a column beside the grid from md up. Sharing the row on a narrow
      // screen squeezed the video area to zero width — the tiles were still mounted and still
      // playing, just not visible — so opening chat looked like the call had ended. Covering the
      // grid instead is honest about there being room for one at a time.
      className="absolute inset-0 z-20 flex flex-col rounded-xl bg-room-900 ring-1 ring-room-700 md:static md:z-auto md:w-80 md:shrink-0"
    >
      <div className="flex items-center gap-1 border-b border-room-700 p-2">
        {(["chat", "people"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium capitalize transition-colors ${
              tab === name ? "bg-room-800 text-white" : "text-room-400 hover:text-room-200"
            }`}
          >
            {name}
            {name === "people" && ` (${participants.length})`}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="ml-1 h-8 w-8 rounded-lg text-room-400 transition-colors hover:bg-room-800 hover:text-room-200"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {tab === "chat" ? (
        <>
          <div
            data-testid="chat-log"
            className="flex-1 space-y-3 overflow-y-auto p-3 text-sm"
          >
            {chat.length === 0 && (
              <p className="text-room-400">
                Messages are visible to everyone in the call and are not stored.
              </p>
            )}
            {chat.map((message, index) => (
              <div key={`${message.at}-${index}`}>
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span className="font-medium text-room-200">
                    {message.mine ? "You" : message.from}
                  </span>
                  <span className="text-[11px] text-room-400">{timeOf(message.at)}</span>
                </div>
                <p className="break-words text-room-200/90">{message.body}</p>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <form onSubmit={onSend} className="flex gap-2 border-t border-room-700 p-3">
            <input
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Send a message"
              className="min-w-0 flex-1 rounded-lg bg-room-800 px-3 py-2 text-sm text-room-200 outline-none ring-1 ring-room-700 placeholder:text-room-400 focus:ring-accent"
            />
            <button
              type="submit"
              className="rounded-lg bg-accent-strong px-4 text-sm font-medium text-white transition-colors hover:bg-accent"
            >
              Send
            </button>
          </form>
        </>
      ) : (
        <div data-testid="people-list" className="flex-1 space-y-1 overflow-y-auto p-3">
          {participants.map((participant) => (
            <div
              key={participant.id}
              className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-room-800"
            >
              <span className="truncate">
                {participant.displayName}
                {participant.isLocal && <span className="text-room-400"> (you)</span>}
              </span>
              {participant.role === "host" && (
                <span className="rounded bg-room-700 px-1.5 py-0.5 text-[10px] uppercase text-room-200">
                  Host
                </span>
              )}
              <span className="grow" />
              {participant.handRaised && <span aria-label="Hand raised">✋</span>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
