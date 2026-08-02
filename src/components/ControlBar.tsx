import { useState } from "react";

const REACTIONS = ["thumbs_up", "clap", "heart", "laugh", "surprised", "thumbs_down"] as const;

const REACTION_EMOJI: Record<string, string> = {
  thumbs_up: "👍",
  thumbs_down: "👎",
  clap: "👏",
  heart: "❤️",
  laugh: "😂",
  surprised: "😮",
};

interface Props {
  publishing: boolean;
  muted: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  handRaised: boolean;
  recordingActive: boolean;
  recordingBusy: boolean;
  canControlRecording: boolean;
  admitted: boolean;
  chatOpen: boolean;
  unreadCount: number;
  onPublishMic: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreen: () => void;
  onToggleHand: () => void;
  onReaction: (reaction: string) => void;
  onToggleRecording: () => void;
  onToggleChat: () => void;
  onLeave: () => void;
}

interface ButtonProps {
  label: string;
  icon: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  badge?: number;
}

function ControlButton({
  label,
  icon,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  testId,
  badge,
}: ButtonProps) {
  const tone = danger
    ? "bg-danger hover:bg-red-700 text-white"
    : active
      ? "bg-accent-strong hover:bg-accent text-white"
      : "bg-room-800 hover:bg-room-700 text-room-200";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // The accessible name is the label, so the button reads correctly to a screen reader
      // and stays addressable by name in tests even though it renders as an icon.
      aria-label={label}
      title={label}
      data-testid={testId}
      className={`relative flex h-11 w-11 items-center justify-center rounded-full text-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      <span aria-hidden="true">{icon}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}

export default function ControlBar(props: Props) {
  const [reactionsOpen, setReactionsOpen] = useState(false);

  return (
    <div className="relative flex items-center justify-center gap-2 rounded-full bg-room-900/90 px-3 py-2 ring-1 ring-room-700 backdrop-blur">
      {!props.publishing ? (
        <ControlButton
          label="Publish Mic"
          icon="🎤"
          onClick={props.onPublishMic}
          disabled={!props.admitted}
          active
        />
      ) : (
        <ControlButton
          label={props.muted ? "Unmute" : "Mute"}
          icon={props.muted ? "🔇" : "🎤"}
          onClick={props.onToggleMute}
          danger={props.muted}
          testId="mute"
        />
      )}

      <ControlButton
        label={props.cameraOn ? "Stop camera" : "Start camera"}
        icon={props.cameraOn ? "📹" : "📷"}
        onClick={props.onToggleCamera}
        disabled={!props.admitted}
        active={props.cameraOn}
        testId="camera-toggle"
      />

      <ControlButton
        label={props.screenOn ? "Stop sharing" : "Share screen"}
        icon="🖥️"
        onClick={props.onToggleScreen}
        disabled={!props.admitted}
        active={props.screenOn}
        testId="screen-toggle"
      />

      <ControlButton
        label={props.handRaised ? "Lower Hand" : "Raise Hand"}
        icon="✋"
        onClick={props.onToggleHand}
        // Hands, reactions and chat are ephemeral sends that the Public Edge only accepts
        // from an admitted attachment, so offering them while waiting in the lobby just
        // produces an error the participant cannot act on.
        disabled={!props.admitted}
        active={props.handRaised}
        testId="hand-toggle"
      />

      <div className="relative">
        <ControlButton
          label="Reactions"
          icon="😀"
          onClick={() => setReactionsOpen((open) => !open)}
          disabled={!props.admitted}
          active={reactionsOpen}
          testId="reactions-toggle"
        />
        {reactionsOpen && (
          <div
            data-testid="reaction-picker"
            className="absolute bottom-14 left-1/2 flex -translate-x-1/2 gap-1 rounded-full bg-room-800 p-2 ring-1 ring-room-700"
          >
            {REACTIONS.map((reaction) => (
              <button
                key={reaction}
                type="button"
                aria-label={reaction}
                onClick={() => {
                  props.onReaction(reaction);
                  setReactionsOpen(false);
                }}
                className="h-9 w-9 rounded-full text-lg transition-transform hover:scale-125"
              >
                <span aria-hidden="true">{REACTION_EMOJI[reaction]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <ControlButton
        label="Chat"
        icon="💬"
        onClick={props.onToggleChat}
        disabled={!props.admitted}
        active={props.chatOpen}
        badge={props.unreadCount}
        testId="chat-toggle"
      />

      {props.canControlRecording && (
        <ControlButton
          label={props.recordingActive ? "Stop Recording" : "Record"}
          icon="⏺"
          onClick={props.onToggleRecording}
          disabled={props.recordingBusy || !props.admitted}
          danger={props.recordingActive}
          testId="recording-toggle"
        />
      )}

      <div className="mx-1 h-7 w-px bg-room-700" />

      <button
        type="button"
        onClick={props.onLeave}
        aria-label="Leave"
        title="Leave"
        className="flex h-11 items-center gap-2 rounded-full bg-danger px-5 text-sm font-medium text-white transition-colors hover:bg-red-700"
      >
        <span aria-hidden="true">📞</span>
        Leave
      </button>
    </div>
  );
}
