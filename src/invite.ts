/**
 * The room identity carried in the address bar.
 *
 * Rooms have no names — Hellave identifies them by instance UUID — so sharing one otherwise
 * means reading 36 characters off the screen and retyping them. Keeping the id in the URL makes
 * the address bar itself the invite.
 */
const ROOM_PARAM = "room";

/** A link that opens the playground ready to join `roomInstanceId`. */
export function inviteLink(roomInstanceId: string): string {
  const url = new URL(window.location.href);
  // Cleared first so an invite copied from a room you joined via an invite does not accumulate
  // stale query state.
  url.search = "";
  url.hash = "";
  url.searchParams.set(ROOM_PARAM, roomInstanceId);
  return url.toString();
}

/** The room instance id this page was opened with, if any. */
export function invitedRoomInstanceId(): string {
  const value = new URLSearchParams(window.location.search).get(ROOM_PARAM) ?? "";
  // Bounded and trimmed rather than trusted: it is user-supplied text on its way into a form.
  return value.trim().slice(0, 200);
}

/**
 * Reflect the room in the address bar without adding a history entry.
 *
 * replaceState rather than pushState: joining a room is not a navigation the back button should
 * step through, and the room screen is not restorable from the URL alone.
 */
export function showRoomInAddressBar(roomInstanceId: string | null): void {
  const url = new URL(window.location.href);
  if (roomInstanceId) {
    url.searchParams.set(ROOM_PARAM, roomInstanceId);
  } else {
    url.searchParams.delete(ROOM_PARAM);
  }
  window.history.replaceState(null, "", url.toString());
}
