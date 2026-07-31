import { useState, useCallback } from "react";
import { HellaveClient, type HellaveConfig } from "@hellave/js-sdk";
import HomePage from "./components/HomePage.js";
import ConferenceRoom from "./components/ConferenceRoom.js";

type Screen =
  | { name: "home" }
  | {
      name: "conference";
      client: HellaveClient;
      roomId: string;
      roomInstanceId: string;
      peerId: string;
    };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const handleCreated = useCallback(async (displayName: string) => {
    const res = await fetch("/api/create-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to create room");
    }
    const { token, roomInstanceId, roomId, peerId } = await res.json();
    const config: HellaveConfig = {
      controlUrl: "https://hellave-api.maiaddy.com",
      tokenProvider: async () => ({ token }),
    };
    const client = new HellaveClient(config);
    setScreen({ name: "conference", client, roomId, roomInstanceId, peerId });
  }, []);

  const handleJoined = useCallback(async (roomInstanceId: string, displayName: string) => {
    const res = await fetch("/api/join-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomInstanceId, displayName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to join room");
    }
    const { token, roomId, peerId } = await res.json();
    const config: HellaveConfig = {
      controlUrl: "https://hellave-api.maiaddy.com",
      tokenProvider: async () => ({ token }),
    };
    const client = new HellaveClient(config);
    setScreen({ name: "conference", client, roomId, roomInstanceId, peerId });
  }, []);

  if (screen.name === "home") {
    return <HomePage onCreated={handleCreated} onJoined={handleJoined} />;
  }

  return (
    <ConferenceRoom
      client={screen.client}
      roomId={screen.roomId}
      roomInstanceId={screen.roomInstanceId}
      peerId={screen.peerId}
      onLeave={() => setScreen({ name: "home" })}
    />
  );
}
