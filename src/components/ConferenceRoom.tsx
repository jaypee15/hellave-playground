import { useEffect, useState, useRef, useCallback } from "react";
import {
  HellaveClient,
  type Conference,
  type ConferenceState,
  type LobbyParticipant,
  type MediaPublication,
} from "@hellave/js-sdk";
import ParticipantTile from "./ParticipantTile.js";
import EventsPanel from "./EventsPanel.js";

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

export default function ConferenceRoom({ client, roomId, roomInstanceId, peerId, onLeave }: Props) {
  const [conference, setConference] = useState<Conference | null>(null);
  const [state, setState] = useState<ConferenceState>("waiting");
  const [participants, setParticipants] = useState<Array<{ id: string; displayName: string; role: string }>>([]);
  const [publishing, setPublishing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [remoteTracks, setRemoteTracks] = useState<Array<{ participantId: string; stream: MediaStream }>>([]);
  const [error, setError] = useState("");
  const [mediaPath, setMediaPath] = useState("");
  const [publication, setPublication] = useState<MediaPublication | null>(null);
  const [lobby, setLobby] = useState<readonly LobbyParticipant[]>([]);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  const [canModerateLobby, setCanModerateLobby] = useState(false);
  const [canSetSpotlight, setCanSetSpotlight] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const eventsRef = useRef<LogEvent[]>([]);
  const [, forceUpdate] = useState(0);

  const addEvent = useCallback((msg: string) => {
    eventsRef.current = [...eventsRef.current, { time: new Date().toLocaleTimeString(), msg }];
    forceUpdate((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        addEvent("Attaching to room...");
        const conf = await client.attach({ roomId, roomInstanceId });
        if (cancelled) return;
        setConference(conf);
        setState(conf.state);
        addEvent(`Connected. State: ${conf.state}`);

        conf.on("stateChanged", (s) => {
          setState(s);
          addEvent(`State changed: ${s}`);
        });

        conf.on("snapshotChanged", (snap) => {
          const list = snap.participants.map((p) => ({
            id: p.id,
            displayName: p.profile.displayName,
            role: p.role,
          }));
          setParticipants(list);
          setLobby(snap.lobby);
          setSpotlight(snap.spotlightPublicationId);
          // Only offer moderation the token actually grants.
          const me = snap.participants.find((p) => p.id === peerId);
          if (me) {
            setCanModerateLobby(me.capabilities.moderateLobby);
            setCanSetSpotlight(me.capabilities.setSpotlight);
          }
          addEvent(
            `Snapshot updated: ${list.length} participants` +
              (snap.lobby.length > 0 ? `, ${snap.lobby.length} waiting` : ""),
          );
        });

        conf.on("remoteMicrophoneTrack", (remote) => {
          const stream = new MediaStream([remote.mediaStreamTrack]);
          setRemoteTracks((prev) => [...prev, { participantId: remote.ownerParticipantId, stream }]);
          addEvent(`Remote mic track from ${remote.ownerParticipantId}`);
        });

        conf.on("error", (err) => {
          addEvent(`Error: ${err.code}`);
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
  }, [client, roomId, roomInstanceId, peerId, addEvent]);

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
      const devices = await conference.mediaDeviceController.enumerateAudioInputs();
      setAudioInputs(devices);
      addEvent(`Microphone published (${pub.id})`);
    } catch (err: unknown) {
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

  const handleStopPublishing = async () => {
    if (!publication) return;
    try {
      await publication.stop();
      setPublication(null);
      setPublishing(false);
      setMuted(false);
      addEvent("Publication stopped");
    } catch (err: unknown) {
      addEvent(`Stop failed: ${err instanceof Error ? err.message : "Unknown"}`);
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

  const handleSpotlight = async (publicationId: string | null) => {
    if (!conference) return;
    try {
      await conference.setSpotlight(publicationId);
      addEvent(publicationId ? `Spotlight set to ${publicationId}` : "Spotlight cleared");
    } catch (err: unknown) {
      addEvent(`Spotlight failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleDeviceChange = async (deviceId: string) => {
    if (!conference || !publication) return;
    try {
      // switchDevice swaps the track on the existing publication, so the publication id and
      // the SFU binding survive the change.
      const next = await conference.mediaDeviceController.switchDevice(publication, { deviceId });
      setPublication(next);
      addEvent(`Switched microphone to ${deviceId.slice(0, 12)}...`);
    } catch (err: unknown) {
      addEvent(`Device switch failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  };

  const handleLeave = () => {
    client.leave();
    onLeave();
  };

  // Show the full Room Instance ID: it is what a joiner pastes into "Join a Room".
  // roomId is the short application-level id and is not enough to join.

  const stateColor = state === "admitted" ? "#16a34a"
    : state === "denied" || state === "failed" ? "#dc2626"
    : "#ca8a04";

  return (
    <div style={{ maxWidth: 800, margin: "20px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <strong>Room Instance:</strong>{" "}
          <code data-testid="room-instance-id">{roomInstanceId}</code>
          <span style={{ marginLeft: 16 }}><strong>Room:</strong> {roomId}</span>
          <span style={{ marginLeft: 16 }}>
            <strong>Status:</strong>{" "}
            <span style={{ color: stateColor }}>{state}</span>
          </span>
          <span style={{ marginLeft: 16 }}><strong>You:</strong> {peerId}</span>
          {mediaPath && (
            <span style={{ marginLeft: 16 }}>
              <strong>Path:</strong>{" "}
              <code data-testid="media-path">{mediaPath}</code>
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {state === "admitted" && !publishing && (
            <button onClick={handlePublish} style={btnStyle}>Publish Mic</button>
          )}
          {publishing && (
            <button onClick={handleMute} style={btnStyle} data-testid="mute">
              {muted ? "Unmute" : "Mute"}
            </button>
          )}
          {publishing && (
            <button onClick={handleStopPublishing} style={{ ...btnStyle, background: "#b45309" }}>
              Stop Publishing
            </button>
          )}
          <button onClick={handleLeave} style={{ ...btnStyle, background: "#6b7280" }}>Leave</button>
        </div>
      </div>

      {error && <p style={{ color: "red", marginBottom: 16 }}>{error}</p>}

      {canModerateLobby && lobby.length > 0 && (
        <div
          data-testid="lobby-panel"
          style={{ border: "1px solid #ca8a04", borderRadius: 6, padding: 12, marginBottom: 16 }}
        >
          <strong>Waiting for admission ({lobby.length})</strong>
          {lobby.map((waiting) => (
            <div key={waiting.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <span style={{ flex: 1 }}>
                {waiting.profile.displayName} <code>{waiting.id}</code>
              </span>
              <button onClick={() => void handleAdmit(waiting.id)} style={btnStyle}>Admit</button>
              <button
                onClick={() => void handleDeny(waiting.id)}
                style={{ ...btnStyle, background: "#dc2626" }}
              >
                Deny
              </button>
            </div>
          ))}
        </div>
      )}

      {publishing && audioInputs.length > 1 && (
        <div style={{ marginBottom: 16 }}>
          <label>
            <strong>Microphone:</strong>{" "}
            <select onChange={(e) => void handleDeviceChange(e.target.value)}>
              {audioInputs.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || device.deviceId.slice(0, 16)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {canSetSpotlight && publication && (
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <strong>Spotlight:</strong>
          <code data-testid="spotlight">{spotlight ?? "none"}</code>
          <button onClick={() => void handleSpotlight(publication.id)} style={btnStyle}>
            Spotlight mine
          </button>
          {spotlight && (
            <button
              onClick={() => void handleSpotlight(null)}
              style={{ ...btnStyle, background: "#6b7280" }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: 12,
        marginBottom: 24,
      }}>
        {participants.map((p) => (
          <ParticipantTile
            key={p.id}
            id={p.id}
            displayName={p.displayName}
            role={p.role}
            stream={remoteTracks.find((t) => t.participantId === p.id)?.stream}
          />
        ))}
        {participants.length === 0 && (
          <div style={{ color: "#9ca3af", gridColumn: "1 / -1", textAlign: "center", padding: 24 }}>
            Waiting for participants...
          </div>
        )}
      </div>

      <EventsPanel events={eventsRef.current} />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontSize: 14,
  cursor: "pointer",
  background: "#4f46e5",
  color: "#fff",
  border: "none",
  borderRadius: 6,
};
