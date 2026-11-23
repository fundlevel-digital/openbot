import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import {
  attentionNotificationIdentity,
  notificationRequestKey,
  pendingAttentionNotificationEvents,
} from "@openbot/team-client/agent-notifications";
import { playActionSound } from "../../action-sounds";

export function createAgentEventSounds(
  notifies: (agentId: string) => boolean,
  play: typeof playActionSound = playActionSound,
): (event: AgentEvent | TeamRealtimeEvent) => void {
  // Requests in different threads must not replace each other's repeat markers.
  const askedRequests = new Set<string>();
  const ask = (event: AgentEvent, agentId: string) => {
    const key = notificationRequestKey("", event);
    const identity = attentionNotificationIdentity(event);
    if (key === null || identity === null) return;
    const seenKey = JSON.stringify([key, identity]);
    if (askedRequests.has(seenKey)) return;
    askedRequests.add(seenKey);
    for (const oldest of askedRequests.keys()) {
      if (askedRequests.size <= 512) break;
      askedRequests.delete(oldest);
    }
    if (notifies(agentId)) play("attention");
  };
  const handle = (event: AgentEvent | TeamRealtimeEvent) => {
    switch (event.type) {
      case "runtime-snapshot":
        for (const pending of pendingAttentionNotificationEvents(event.snapshot)) handle(pending);
        return;
      case "approval":
        ask(event, event.approval.agentId);
        return;
      case "prompt":
        ask(event, event.agentId);
        return;
      case "browser-takeover-requested":
        ask(event, event.request.agentId);
        return;
      case "turn-completed":
        if (
          event.status === "failed" &&
          event.origin !== "routine" &&
          event.origin !== "agent" &&
          notifies(event.agentId)
        ) {
          play("error");
        }
        return;
    }
  };
  return handle;
}
