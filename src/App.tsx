import { useState, useCallback } from "react";
import { HellaveClient, type HellaveConfig } from "@hellave/js-sdk";
import HomePage from "./components/HomePage.js";
import ConferenceRoom from "./components/ConferenceRoom.js";
import { invitedRoomInstanceId, showRoomInAddressBar } from "./invite.js";

type Screen =
  | { name: "home" }
  | {
      name: "conference";
      client: HellaveClient;
      roomId: string;
      roomInstanceId: string;
      peerId: string;
    };

/**
 * Ask our own backend for a fresh meeting token whenever the SDK needs one.
 *
 * Returning a captured token instead — which this did — defeats the point of a short-lived join
 * credential: the SDK calls this again on every reconnect, and a token minted minutes ago has
 * expired by then. The peerId must be carried through, because the server derives a new one from
 * the display name and the room would see a different participant.
 */
function tokenRefresher(
  roomInstanceId: string,
  displayName: string,
  peerId: string,
  role: string,
): HellaveConfig["tokenProvider"] {
  return async () => {
    const res = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomInstanceId, displayName, peerId, role }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? "Failed to refresh the meeting token");
    }
    const { token } = await res.json();
    return { token };
  };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const handleCreated = useCallback(async (displayName: string, lobbyEnabled = false) => {
    const res = await fetch("/api/create-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, lobbyEnabled }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to create room");
    }
    const { roomInstanceId, roomId, peerId, controlUrl } = await res.json();
    // Told by the server rather than hardcoded, so the browser always attaches to the same
    // stack that minted the token. Pointing them at different deployments produces an
    // authentication failure that looks nothing like a configuration mistake.
    const config: HellaveConfig = {
      controlUrl,
      tokenProvider: tokenRefresher(roomInstanceId, displayName, peerId, "host"),
    };
    const client = new HellaveClient(config);
    showRoomInAddressBar(roomInstanceId);
    setScreen({ name: "conference", client, roomId, roomInstanceId, peerId });
  }, []);

  const handleJoined = useCallback(async (roomInstanceId: string, displayName: string) => {
    const res = await fetch("/api/join-room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomInstanceId, displayName, lobby: true }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error ?? "Failed to join room");
    }
    const { roomId, peerId, controlUrl } = await res.json();
    const config: HellaveConfig = {
      controlUrl,
      tokenProvider: tokenRefresher(roomInstanceId, displayName, peerId, "participant"),
    };
    const client = new HellaveClient(config);
    showRoomInAddressBar(roomInstanceId);
    setScreen({ name: "conference", client, roomId, roomInstanceId, peerId });
  }, []);

  // Read once, at startup: it seeds the join form, and leaving clears it so the home screen
  // does not keep offering a room the person has just left.
  const [invitedRoom] = useState(invitedRoomInstanceId);
  const handleLeave = useCallback(() => {
    showRoomInAddressBar(null);
    setScreen({ name: "home" });
  }, []);

  if (screen.name === "home") {
    return (
      <HomePage
        onCreated={handleCreated}
        onJoined={handleJoined}
        invitedRoomInstanceId={invitedRoom}
      />
    );
  }

  return (
    <ConferenceRoom
      client={screen.client}
      roomId={screen.roomId}
      roomInstanceId={screen.roomInstanceId}
      peerId={screen.peerId}
      onLeave={handleLeave}
    />
  );
}
