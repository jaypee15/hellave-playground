import { useState, useCallback } from "react";
import { HellaveClient, type HellaveConfig } from "@hellave/js-sdk";
import HomePage from "./components/HomePage.js";
import ConferenceRoom from "./components/ConferenceRoom.js";

type Screen =
  | { name: "home" }
  | { name: "conference"; client: HellaveClient; roomId: string; peerId: string };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const handleCreated = useCallback(async (peerId: string, displayName: string) => {
    const res = await fetch("/api/create-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId, displayName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to create room");
    }
    const { token, roomInstanceId } = await res.json();
    const roomId = roomInstanceId;
    const config: HellaveConfig = {
      controlUrl: "https://hellave-api.maiaddy.com",
      tokenProvider: async () => ({ token }),
    };
    const client = new HellaveClient(config);
    setScreen({ name: "conference", client, roomId, peerId });
  }, []);

  const handleJoined = useCallback(async (roomInstanceId: string, peerId: string, displayName: string) => {
    const res = await fetch("/api/join-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomInstanceId, peerId, displayName }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to join room");
    }
    const { token } = await res.json();
    const roomId = roomInstanceId;
    const config: HellaveConfig = {
      controlUrl: "https://hellave-api.maiaddy.com",
      tokenProvider: async () => ({ token }),
    };
    const client = new HellaveClient(config);
    setScreen({ name: "conference", client, roomId, peerId });
  }, []);

  if (screen.name === "home") {
    return <HomePage onCreated={handleCreated} onJoined={handleJoined} />;
  }

  return (
    <ConferenceRoom
      client={screen.client}
      roomId={screen.roomId}
      peerId={screen.peerId}
      onLeave={() => setScreen({ name: "home" })}
    />
  );
}
