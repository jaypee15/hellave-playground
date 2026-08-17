import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  HellaveClient,
  type Conference,
  type ConferenceState,
  type LobbyParticipant,
  type MediaPublication,
  type RoomSnapshot,
} from "@hellave/js-sdk";
import VideoGrid from "./VideoGrid.js";
import type { TileParticipant } from "./VideoTile.js";
import ControlBar from "./ControlBar.js";
import SidePanel, { type ChatMessage } from "./SidePanel.js";
import { inviteLink } from "../invite.js";
import LobbyRequests from "./LobbyRequests.js";
import ReactionOverlay, { type FloatingReaction } from "./ReactionOverlay.js";
import DebugDrawer from "./DebugDrawer.js";
import NetworkNotice from "./NetworkNotice.js";

interface Props {
  client: HellaveClient;
  roomId: string;
  roomInstanceId: string;
  peerId: string;
  onLeave: () => void;
}

interface LogEvent {
  time: string;
  msg: string;
}

/** How long a floating reaction stays on screen; matches the float-up animation. */
const REACTION_TTL_MS = 2_800;

export default function ConferenceRoom({ client, roomId, roomInstanceId, peerId, onLeave }: Props) {
  const [conference, setConference] = useState<Conference | null>(null);
  const [state, setState] = useState<ConferenceState>("waiting");
  const [participants, setParticipants] = useState<
    Array<{ id: string; displayName: string; role: string; mutedAudio: boolean }>
  >([]);
  const [publishing, setPublishing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [remoteAudio, setRemoteAudio] = useState<Array<{ participantId: string; stream: MediaStream }>>([]);
  /**
   * Received video, keyed by publication rather than by participant.
   *
   * Keyed by participant, a second video from the same person replaced the first: a screen share
   * evicted the camera it was published alongside, so one of the two was dropped before anything
   * was rendered. Whoever shared their screen looked to everyone else like they had simply changed
   * what their camera was pointing at.
   */
  const [remoteVideo, setRemoteVideo] = useState<
    Array<{ publicationId: string; participantId: string; stream: MediaStream }>
  >([]);
  /**
   * What each publication is, from the snapshot, because the received track does not say.
   *
   * `RemoteVideoTrack` carries `publicationId` and `ownerParticipantId` but no source, so a camera
   * and a screen share are indistinguishable until they are joined against the roster.
   */
  const [publicationSources, setPublicationSources] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [localVideo, setLocalVideo] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [mediaPath, setMediaPath] = useState("");
  const [attribution, setAttribution] = useState<
    "your_network" | "hellave_service" | "unknown"
  >("unknown");
  const [publication, setPublication] = useState<MediaPublication | null>(null);
  const [cameraPublication, setCameraPublication] = useState<MediaPublication | null>(null);
  const [screenPublication, setScreenPublication] = useState<MediaPublication | null>(null);
  const [lobby, setLobby] = useState<readonly LobbyParticipant[]>([]);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [spotlightOwner, setSpotlightOwner] = useState<string | null>(null);
  const [canModerateLobby, setCanModerateLobby] = useState(false);
  const [canControlRecording, setCanControlRecording] = useState(false);
  const [recording, setRecording] = useState<{ active: boolean; recordingId: string | null }>({
    active: false,
    recordingId: null,
  });
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [raisedHands, setRaisedHands] = useState<ReadonlySet<string>>(new Set());
  const [handRaised, setHandRaised] = useState(false);
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const [view, setView] = useState<"grid" | "speaker">("grid");
  const eventsRef = useRef<LogEvent[]>([]);
  const [, forceUpdate] = useState(0);
  const reactionKey = useRef(0);
  // Read inside the reaction handler, which is registered once; a state value would be
  // captured at registration and always read as closed.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  const addEvent = useCallback((msg: string) => {
    eventsRef.current = [...eventsRef.current, { time: new Date().toLocaleTimeString(), msg }];
    forceUpdate((n) => n + 1);
  }, []);

  const pushReaction = useCallback((from: string, reaction: string) => {
    reactionKey.current += 1;
    const key = reactionKey.current;
    setFloating((previous) => [
      ...previous,
      { key, from, reaction, offset: 15 + Math.random() * 70 },
    ]);
    setTimeout(() => {
      setFloating((previous) => previous.filter((item) => item.key !== key));
    }, REACTION_TTL_MS);
  }, []);

  /**
   * Project an authoritative snapshot onto local state.
   *
   * Applied to conference.snapshot at attach as well as to every later change: attaching does
   * not raise snapshotChanged, so reading the roster only from the event left a participant
   * who was alone in the room seeing an empty grid and none of their own capabilities.
   */
  const applySnapshot = useCallback((snap: RoomSnapshot) => {
    setParticipants(snap.participants.map((p) => ({
      id: p.id,
      displayName: p.profile.displayName,
      role: p.role,
      mutedAudio: p.muted.audio,
    })));
    setLobby(snap.lobby);
    setPublicationSources(new Map(snap.publications.map((pub) => [pub.id, pub.source])));
    setSpotlight(snap.spotlightPublicationId);
    // The snapshot spotlights a publication, but the grid features a participant.
    setSpotlightOwner(
      snap.publications.find((pub) => pub.id === snap.spotlightPublicationId)
        ?.ownerParticipantId ?? null,
    );
    // Only offer moderation the token actually grants.
    const me = snap.participants.find((p) => p.id === peerId);
    if (me) {
      setCanModerateLobby(me.capabilities.moderateLobby);
      setCanControlRecording(me.capabilities.controlRecording);
    }
  }, [peerId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        addEvent("Attaching to room...");
        const conf = await client.attach({ roomId, roomInstanceId });
        if (cancelled) return;
        setConference(conf);
        setState(conf.state);
        applySnapshot(conf.snapshot);
        setAttribution(conf.networkAttribution);
        addEvent(`Connected. State: ${conf.state}`);

        conf.on("stateChanged", (s) => {
          setState(s);
          applySnapshot(conf.snapshot);
          addEvent(`State changed: ${s}`);
        });

        conf.on("networkAttributionChanged", (attribution) => {
          setAttribution(attribution);
        });

        conf.on("snapshotChanged", (snap) => {
          applySnapshot(snap);
          addEvent(
            `Snapshot updated: ${snap.participants.length} participants` +
              (snap.lobby.length > 0 ? `, ${snap.lobby.length} waiting` : ""),
          );
        });

        conf.on("remoteMicrophoneTrack", (remote) => {
          const stream = new MediaStream([remote.mediaStreamTrack]);
          setRemoteAudio((prev) => [
            ...prev.filter((t) => t.participantId !== remote.ownerParticipantId),
            { participantId: remote.ownerParticipantId, stream },
          ]);
          addEvent(`Remote mic track from ${remote.ownerParticipantId}`);
        });

        conf.on("remoteVideoTrack", (remote) => {
          const stream = new MediaStream([remote.mediaStreamTrack]);
          setRemoteVideo((prev) => [
            ...prev.filter((t) => t.publicationId !== remote.publicationId),
            {
              publicationId: remote.publicationId,
              participantId: remote.ownerParticipantId,
              stream,
            },
          ]);
          // The Public Edge sends no message when a remote publication stops, so without this a
          // stopped camera or a finished screen share keeps its tile and its last decoded frame
          // for the rest of the meeting. Only `ended` clears it: a track also goes `mute` when
          // forwarding is merely paused, and that one comes back.
          remote.mediaStreamTrack.addEventListener("ended", () => {
            setRemoteVideo((prev) => prev.filter((t) => t.publicationId !== remote.publicationId));
          });
          addEvent(`Remote video ${remote.publicationId} from ${remote.ownerParticipantId}`);
        });

        conf.on("roomMessage", (message) => {
          setChat((prev) => [
            ...prev,
            { from: message.fromParticipantId, body: message.body, at: message.sentAt, mine: false },
          ]);
          if (!chatOpenRef.current) setUnread((count) => count + 1);
        });

        conf.on("handRaisedChanged", (participantId, raised) => {
          setRaisedHands(new Set(conf.raisedHands));
          addEvent(`${participantId} ${raised ? "raised" : "lowered"} their hand`);
        });

        conf.on("recordingChanged", (active, recordingId) => {
          setRecording({ active, recordingId });
          addEvent(active ? `Recording started (${recordingId ?? "no id"})` : "Recording stopped");
        });

        conf.on("reactionReceived", (reaction) => {
          pushReaction(reaction.fromParticipantId, reaction.reaction);
          addEvent(`${reaction.fromParticipantId} reacted: ${reaction.reaction}`);
        });

        conf.on("error", (err) => {
          // The code alone is not diagnosable: the SDK and the server between them raise
          // temporarily_unavailable from around thirty different places, and this panel was
          // discarding the one field that distinguishes them. Context is included when present
          // because it carries ids that tie the failure to a server-side log line.
          const context = err.context && Object.keys(err.context).length > 0
            ? ` ${JSON.stringify(err.context)}`
            : "";
          addEvent(`Error: ${err.code} — ${err.message}${context}`);
          console.error(`Hellave error: ${err.code} — ${err.message}${context}`);
        });
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          setError(msg);
          addEvent(`Failed: ${msg}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [client, roomId, roomInstanceId, peerId, addEvent, pushReaction, applySnapshot]);

  // Poll the transport so the actual ICE path is visible: "relay/tcp" means media is going
  // through TURN, which is the fallback for networks that block UDP.
  useEffect(() => {
    if (!conference || !publishing) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void conference
        .requestDiagnostics()
        .then((d) => {
          if (cancelled) return;
          const path = `${d.candidateType}/${d.protocol}`;
          setMediaPath((previous) => {
            if (previous !== path) addEvent(`Media path: ${path} (${d.quality})`);
            return path;
          });
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conference, publishing, addEvent]);

  const handlePublish = async () => {
    if (!conference) return;
    try {
      setPublishing(true);
      addEvent("Publishing microphone...");
      const pub = await conference.publishMicrophone();
      setPublication(pub);
      addEvent(`Microphone published (${pub.id})`);
    } catch (err: unknown) {
      setPublishing(false);
      addEvent(`Publish failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  // Local Mute is participant-owned and distinct from a moderator's Publish Block.
  const handleMute = () => {
    if (!publication) return;
    const next = !muted;
    publication.setLocalMuted(next);
    setMuted(next);
    addEvent(next ? "Local mute on" : "Local mute off");
  };

  const handleToggleCamera = async () => {
    if (!conference) return;
    try {
      if (cameraPublication) {
        await cameraPublication.stop();
        setCameraPublication(null);
        setLocalVideo(null);
        addEvent("Camera stopped");
        return;
      }
      // Captured here rather than through conference.publishCamera() because a
      // MediaPublication exposes no track, and the self-view needs one to render.
      const [capture] = await conference.mediaDeviceController.capturePreview({
        audio: false,
        video: true,
      });
      if (!capture) throw new Error("camera produced no track");
      const pub = await conference.mediaDeviceController.publishCapture(capture);
      setCameraPublication(pub);
      setLocalVideo(new MediaStream([capture.mediaStreamTrack]));
      addEvent(`Camera published (${pub.id})`);
    } catch (err: unknown) {
      addEvent(`Camera failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleToggleScreen = async () => {
    if (!conference) return;
    try {
      if (screenPublication) {
        await screenPublication.stop();
        setScreenPublication(null);
        addEvent("Screen share stopped");
        return;
      }
      const pub = await conference.publishScreen();
      setScreenPublication(pub);
      addEvent(`Screen shared (${pub.id})`);
    } catch (err: unknown) {
      addEvent(`Screen share failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleAdmit = async (participantId: string) => {
    if (!conference) return;
    try {
      await conference.admit(participantId);
      addEvent(`Admitted ${participantId}`);
    } catch (err: unknown) {
      addEvent(`Admit failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleDeny = async (participantId: string) => {
    if (!conference) return;
    try {
      await conference.deny(participantId, "denied from the playground");
      addEvent(`Denied ${participantId}`);
    } catch (err: unknown) {
      addEvent(`Deny failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!conference || !body) return;
    try {
      conference.sendMessage(body);
      // The server broadcasts to everyone except the sender, so echo locally.
      setChat((prev) => [...prev, { from: peerId, body, at: Date.now() / 1000, mine: true }]);
      setDraft("");
    } catch (err: unknown) {
      addEvent(`Chat failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleToggleHand = () => {
    if (!conference) return;
    const next = !handRaised;
    try {
      conference.setHandRaised(next);
      setHandRaised(next);
      addEvent(next ? "Hand raised" : "Hand lowered");
    } catch (err: unknown) {
      addEvent(`Hand raise failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleReaction = (reaction: string) => {
    if (!conference) return;
    try {
      conference.sendReaction(reaction);
      pushReaction("You", reaction);
    } catch (err: unknown) {
      addEvent(`Reaction failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleToggleRecording = async () => {
    if (!conference || recordingBusy) return;
    // Held across the await so a double click cannot put two commands in flight; the SDK
    // would refuse the second, but a disabled button explains itself better than an error.
    setRecordingBusy(true);
    try {
      if (recording.active) {
        await conference.stopRecording();
      } else {
        await conference.startRecording();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown";
      addEvent(`Recording failed: ${message}`);
      // Also to the console: the panel is invisible to the e2e tests, which turned a refused
      // recording into an unexplained timeout waiting for an indicator that never appeared.
      console.error(`Recording failed: ${message}`);
    } finally {
      setRecordingBusy(false);
    }
  };

  const [inviteCopy, setInviteCopy] = useState("Copy invite");

  /**
   * Copy a link that opens this room, rather than the bare id.
   *
   * The id alone still has to be pasted into a form; the link is the whole invite. Failure is
   * surfaced instead of swallowed — the clipboard API needs a secure context, and silently
   * doing nothing looks identical to a broken button.
   */
  const handleCopyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(roomInstanceId));
      setInviteCopy("Copied");
    } catch {
      setInviteCopy("Copy failed");
    }
    window.setTimeout(() => setInviteCopy("Copy invite"), 2_000);
  };

  const handleLeave = () => {
    // Fire-and-forget on purpose — the person is leaving, so nothing is gained by making them
    // wait on the acknowledgement. But the rejection has to be handled: unhandled, a server
    // that never acknowledges a leave showed up only as an unhandled promise rejection, which
    // is how a leave deadlock went unnoticed.
    client.leave().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown";
      console.error(`Leave failed: ${message}`);
    });
    onLeave();
  };

  const openChat = () => {
    setChatOpen((open) => {
      if (!open) setUnread(0);
      return !open;
    });
  };

  const isScreen = useCallback(
    (publicationId: string) => publicationSources.get(publicationId) === "screen",
    [publicationSources],
  );

  /** Received video as `source:publicationId`, for the header diagnostic and the debug drawer. */
  const receivedVideoIds = useMemo(
    () => remoteVideo.map(
      (track) => `${publicationSources.get(track.publicationId) ?? "unknown"}:${track.publicationId}`,
    ),
    [remoteVideo, publicationSources],
  );

  const tiles = useMemo<TileParticipant[]>(() => {
    const known = participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      role: participant.role,
      audioStream: remoteAudio.find((t) => t.participantId === participant.id)?.stream,
      // A person's own tile carries their camera. Their screen share, if any, is a tile of its
      // own below — putting it here would mean choosing between the two.
      videoStream: participant.id === peerId
        ? localVideo ?? undefined
        : remoteVideo.find((t) => t.participantId === participant.id && !isScreen(t.publicationId))
          ?.stream,
      handRaised: raisedHands.has(participant.id),
      muted: participant.id === peerId ? muted : participant.mutedAudio,
      isLocal: participant.id === peerId,
    }));
    // Before the first snapshot arrives the roster is empty, but the local camera preview
    // should still be visible rather than showing an empty room.
    if (known.length === 0 && localVideo) {
      return [{
        id: peerId,
        displayName: peerId,
        role: "participant",
        videoStream: localVideo,
        handRaised: handRaised,
        muted,
        isLocal: true,
      }];
    }
    // One tile per received screen share, named for whoever is sharing. A screen share is a second
    // video publication from a participant who usually still has a camera, so it is a thing in the
    // room in its own right rather than a different picture of that person.
    const shares = remoteVideo
      .filter((track) => isScreen(track.publicationId))
      .map((track) => ({
        id: `screen-${track.publicationId}`,
        displayName: `${
          participants.find((p) => p.id === track.participantId)?.displayName ?? track.participantId
        }'s screen`,
        role: "screen",
        videoStream: track.stream,
        handRaised: false,
        muted: false,
        isLocal: false,
      }));
    return [...known, ...shares];
  }, [
    participants,
    remoteAudio,
    remoteVideo,
    localVideo,
    raisedHands,
    muted,
    peerId,
    handRaised,
    isScreen,
  ]);

  // From the roster, not from the tiles: a screen share is a tile but not a person, and the People
  // panel is a list of people.
  const panelParticipants = useMemo(
    () => tiles
      .filter((tile) => tile.role !== "screen")
      .map((tile) => ({
        id: tile.id,
        displayName: tile.displayName,
        role: tile.role,
        handRaised: tile.handRaised,
        isLocal: tile.isLocal,
      })),
    [tiles],
  );

  const stateTone = state === "admitted" ? "text-live"
    : state === "denied" || state === "failed" ? "text-danger"
    : "text-amber-400";

  return (
    <div className="flex h-full flex-col bg-room-950">
      {/* min-w-0 on the row and on what truncates inside it, or a long room id forces the header
          wider than the screen instead of shortening. Three wrapped rows took 89px of a 664px
          phone viewport before this. */}
      <header className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">Hellave</span>

        <span className="hidden text-xs text-room-400 sm:inline">{roomId}</span>

        {/* Read with innerText by the audio test, so it must not live inside the collapsed
            debug drawer: hidden elements report no text. The copy button is a sibling rather
            than a child for the same reason — nested text would land in that innerText. */}
        <code
          data-testid="room-instance-id"
          className="min-w-0 max-w-[5.5rem] truncate rounded bg-room-850 px-2 py-1 font-mono text-[11px] text-room-400 sm:max-w-[16rem]"
        >
          {roomInstanceId}
        </code>

        <button
          type="button"
          onClick={handleCopyInvite}
          data-testid="copy-invite"
          title="Copy a link that opens this room"
          className="rounded bg-room-850 px-2 py-1 text-[11px] font-medium text-room-300 transition-colors hover:bg-room-700 hover:text-white"
        >
          {inviteCopy}
        </button>

        <span data-testid="conference-state" className={`text-xs font-medium ${stateTone}`}>
          {state}
        </span>

        {/*
          Always mounted and visually hidden, unlike the same list in the debug drawer: the drawer
          is an overlay that sits over the control bar, so a test that had to open it to read this
          could no longer click Stop camera. Read with textContent, which does not need the element
          to be visible.
        */}
        <span data-testid="received-video" className="sr-only">
          {receivedVideoIds.length > 0 ? receivedVideoIds.join(" ") : "none"}
        </span>

        {mediaPath && (
          <code
            data-testid="media-path"
            className="rounded bg-room-850 px-2 py-1 font-mono text-[11px] text-room-400"
          >
            {mediaPath}
          </code>
        )}

        {recording.active && (
          <span
            data-testid="recording-indicator"
            className="flex items-center gap-1.5 rounded-full bg-danger/15 px-2.5 py-1 text-[11px] font-medium text-danger ring-1 ring-danger/40"
          >
            <span className="animate-recording-pulse h-2 w-2 rounded-full bg-danger" />
            <span className="hidden sm:inline">Recording</span>
          </span>
        )}

        <span className="grow" />

        <button
          type="button"
          onClick={() => setView((current) => (current === "grid" ? "speaker" : "grid"))}
          data-testid="view-toggle"
          aria-label={view === "grid" ? "Speaker view" : "Grid view"}
          title={view === "grid" ? "Speaker view" : "Grid view"}
          className="shrink-0 rounded-lg bg-room-800 px-2.5 py-1.5 text-xs font-medium text-room-400 transition-colors hover:bg-room-700 hover:text-room-200 sm:px-3"
        >
          <span aria-hidden="true" className="sm:hidden">{view === "grid" ? "🗣" : "▦"}</span>
          <span className="hidden sm:inline">{view === "grid" ? "Speaker view" : "Grid view"}</span>
        </button>

        <DebugDrawer
          events={eventsRef.current}
          roomId={roomId}
          roomInstanceId={roomInstanceId}
          peerId={peerId}
          spotlight={spotlight}
          raisedHands={[...raisedHands]}
          receivedVideo={receivedVideoIds}
        />
      </header>

      {error && (
        <p className="mx-3 mb-2 rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger sm:mx-4">
          {error}
        </p>
      )}

      <main className="relative flex min-h-0 flex-1 gap-3 px-3 pb-2 sm:px-4">
        <div className="relative min-w-0 flex-1">
          <NetworkNotice attribution={attribution} />
          <VideoGrid participants={tiles} featuredId={spotlightOwner} view={view} />
          <ReactionOverlay reactions={floating} />
          {canModerateLobby && (
            <LobbyRequests
              waiting={lobby}
              onAdmit={(id) => void handleAdmit(id)}
              onDeny={(id) => void handleDeny(id)}
            />
          )}
        </div>

        <SidePanel
          open={chatOpen}
          chat={chat}
          participants={panelParticipants}
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSendChat}
          onClose={() => setChatOpen(false)}
        />
      </main>

      <footer className="relative flex shrink-0 justify-center px-4 py-3">
        <ControlBar
          publishing={publishing}
          muted={muted}
          cameraOn={cameraPublication !== null}
          screenOn={screenPublication !== null}
          handRaised={handRaised}
          recordingActive={recording.active}
          recordingBusy={recordingBusy}
          canControlRecording={canControlRecording}
          admitted={state === "admitted"}
          chatOpen={chatOpen}
          unreadCount={unread}
          onPublishMic={() => void handlePublish()}
          onToggleMute={handleMute}
          onToggleCamera={() => void handleToggleCamera()}
          onToggleScreen={() => void handleToggleScreen()}
          onToggleHand={handleToggleHand}
          onReaction={handleReaction}
          onToggleRecording={() => void handleToggleRecording()}
          onToggleChat={openChat}
          onLeave={handleLeave}
        />
      </footer>
    </div>
  );
}
