import type { ConnectionAttribution } from "@hellave/js-sdk";

interface Props {
  attribution: ConnectionAttribution;
}

const MESSAGES: Record<string, string> = {
  your_network: "Your network is affecting call quality — check your connection.",
  hellave_service: "Hellave is experiencing issues right now.",
};

/**
 * Surfaces a degraded-connection notice and whether the cause is the participant's own
 * network or the Hellave service, from the SDK's network attribution.
 */
export default function NetworkNotice({ attribution }: Props) {
  const message = MESSAGES[attribution];
  if (!message) return null;
  const service = attribution === "hellave_service";
  const tone = service
    ? "bg-danger/15 text-danger ring-danger/40"
    : "bg-live/15 text-live ring-live/40";
  return (
    <div
      data-testid="network-notice"
      className={`mx-3 mb-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 sm:mx-4 ${tone}`}
    >
      {message}
    </div>
  );
}
