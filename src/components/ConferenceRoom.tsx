import { useEffect, useState, useRef, useCallback } from "react";
import { HellaveClient, type Conference, type ConferenceState } from "@hellave/js-sdk";
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
          addEvent(`Snapshot updated: ${list.length} participants`);
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
  }, [client, roomId, roomInstanceId, addEvent]);

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
      await conference.publishMicrophone();
      addEvent("Microphone published");
    } catch (err: unknown) {
      addEvent(`Publish failed: ${err instanceof Error ? err.message : "Unknown"}`);
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
            <button onClick={() => { setMuted(!muted); }} style={btnStyle}>
              {muted ? "Unmute" : "Mute"}
            </button>
          )}
          <button onClick={handleLeave} style={{ ...btnStyle, background: "#6b7280" }}>Leave</button>
        </div>
      </div>

      {error && <p style={{ color: "red", marginBottom: 16 }}>{error}</p>}

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
