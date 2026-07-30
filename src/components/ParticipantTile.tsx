import { useEffect, useRef } from "react";

interface Props {
  id: string;
  displayName: string;
  role: string;
  stream?: MediaStream;
}

export default function ParticipantTile({ id, displayName, role, stream }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: 16,
      background: "#f9fafb",
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{displayName}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
        {id.slice(0, 12)}... · {role}
      </div>
      {stream && <audio ref={audioRef} autoPlay />}
      {!stream && <div style={{ fontSize: 12, color: "#9ca3af" }}>No audio</div>}
    </div>
  );
}
