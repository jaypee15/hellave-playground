import { useEffect, useRef, useState } from "react";

export interface TileParticipant {
  id: string;
  displayName: string;
  role: string;
  audioStream?: MediaStream;
  videoStream?: MediaStream;
  handRaised: boolean;
  activeSpeaker: boolean;
  muted: boolean;
  isLocal: boolean;
}

interface Props {
  participant: TileParticipant;
  /** Larger name and badges, for the speaker-view hero tile. */
  prominent?: boolean;
}

/** Deterministic tile colour, so a participant keeps the same avatar between renders. */
const AVATAR_COLORS = [
  "bg-indigo-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-sky-600",
  "bg-violet-600",
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export default function VideoTile({ participant, prominent = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // The Public Edge sends no message when a remote publication stops, so the track's own
  // `ended`/`mute` events are the only signal that the video should stop being shown.
  // Without this the last decoded frame stays on screen as if the camera were still live.
  const [videoLive, setVideoLive] = useState(false);

  useEffect(() => {
    const stream = participant.videoStream;
    if (!stream) {
      setVideoLive(false);
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      setVideoLive(false);
      return;
    }
    setVideoLive(track.readyState === "live" && !track.muted);
    const onEnded = () => setVideoLive(false);
    const onMute = () => setVideoLive(false);
    const onUnmute = () => setVideoLive(true);
    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    return () => {
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
    };
  }, [participant.videoStream]);

  // Assigned in its own effect keyed on videoLive: the element only exists once the track is
  // live, so setting srcObject alongside the listeners above ran while the ref was still null
  // and the tile stayed black.
  useEffect(() => {
    if (videoLive && videoRef.current && participant.videoStream) {
      videoRef.current.srcObject = participant.videoStream;
      // Played explicitly rather than left to the autoplay attribute. The element mounts before
      // this effect runs, so its one automatic attempt happens while it still has no source, and
      // the algorithm does not retry when one arrives — which left a tile black, with the track
      // live and frames arriving, until something else happened to call play(). It showed up as a
      // screen share that worked for the person sharing and appeared blank to everyone else.
      void videoRef.current.play().catch(() => {});
    }
  }, [videoLive, participant.videoStream]);

  useEffect(() => {
    if (audioRef.current && participant.audioStream) {
      audioRef.current.srcObject = participant.audioStream;
    }
  }, [participant.audioStream]);

  return (
    <div
      data-testid={`tile-${participant.id}`}
      className={`group relative aspect-video w-full overflow-hidden rounded-xl bg-room-850 ring-1 ring-room-700 ${
        participant.handRaised ? "ring-2 ring-amber-400" : ""
      } ${
        participant.activeSpeaker && !participant.isLocal
          ? "ring-2 ring-live"
          : ""
      }`}
    >
      {videoLive ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          // The local preview is mirrored because people expect their own image to behave
          // like a mirror; remote video must not be.
          className={`h-full w-full object-cover ${participant.isLocal ? "-scale-x-100" : ""}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div
            className={`flex items-center justify-center rounded-full font-semibold text-white ${avatarColor(
              participant.id,
            )} ${prominent ? "h-28 w-28 text-3xl" : "h-16 w-16 text-lg"}`}
          >
            {initials(participant.displayName)}
          </div>
        </div>
      )}

      {/* Remote audio is played but never rendered; the local participant hears themselves
          only through their own hardware, so no element is attached for them. */}
      {participant.audioStream && !participant.isLocal && <audio ref={audioRef} autoPlay />}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-3">
        {participant.activeSpeaker && !participant.isLocal && (
          <span
            aria-label="Speaking"
            className="flex animate-pulse items-center gap-1 rounded bg-live px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-black" />
            Speaking
          </span>
        )}
        <span className={`truncate font-medium ${prominent ? "text-base" : "text-sm"}`}>
          {participant.displayName}
          {participant.isLocal && <span className="text-room-400"> (you)</span>}
        </span>
        {participant.role === "host" && (
          <span className="rounded bg-room-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-room-200">
            Host
          </span>
        )}
        <span className="grow" />
        {participant.handRaised && <span aria-label="Hand raised">✋</span>}
        {participant.muted && (
          <span aria-label="Muted" className="text-room-400">
            🔇
          </span>
        )}
      </div>
    </div>
  );
}
