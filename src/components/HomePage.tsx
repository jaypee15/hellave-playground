import { useState, type FormEvent } from "react";

interface Props {
  onCreated: (displayName: string) => Promise<void>;
  onJoined: (roomInstanceId: string, displayName: string) => Promise<void>;
}

export default function HomePage({ onCreated, onJoined }: Props) {
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [displayName, setDisplayName] = useState("");
  const [roomInstanceId, setRoomInstanceId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onCreated(displayName);
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

  if (mode === "choose") {
    return (
      <div style={{ maxWidth: 400, margin: "100px auto", textAlign: "center" }}>
        <h1>Hellave Playground</h1>
        <p style={{ marginBottom: 32 }}>
          Test the Hellave real-time communication SDK
        </p>
        <button onClick={() => setMode("create")} style={btnStyle}>
          Create a Room
        </button>
        <br /><br />
        <button onClick={() => setMode("join")} style={btnStyle}>
          Join a Room
        </button>
      </div>
    );
  }

  const form = mode === "create" ? (
    <form onSubmit={handleCreate}>
      <h2>Create a Room</h2>
      <input
        placeholder="Your name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
        style={inputStyle}
      />
      <button type="submit" disabled={loading} style={btnStyle}>
        {loading ? "Creating..." : "Create & Join"}
      </button>
    </form>
  ) : (
    <form onSubmit={handleJoin}>
      <h2>Join a Room</h2>
      <input
        placeholder="Room Instance ID"
        value={roomInstanceId}
        onChange={(e) => setRoomInstanceId(e.target.value)}
        required
        style={inputStyle}
      />
      <input
        placeholder="Your name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        required
        style={inputStyle}
      />
      <button type="submit" disabled={loading} style={btnStyle}>
        {loading ? "Joining..." : "Join"}
      </button>
    </form>
  );

  return (
    <div style={{ maxWidth: 400, margin: "100px auto" }}>
      {form}
      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}
      <button
        onClick={() => { setMode("choose"); setError(""); }}
        style={{ marginTop: 16, background: "none", border: "none", color: "#666", cursor: "pointer", textDecoration: "underline" }}
      >
        Back
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "12px 24px",
  fontSize: 16,
  cursor: "pointer",
  background: "#4f46e5",
  color: "#fff",
  border: "none",
  borderRadius: 6,
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "10px 12px",
  marginBottom: 12,
  fontSize: 16,
  border: "1px solid #ccc",
  borderRadius: 6,
  boxSizing: "border-box",
};
