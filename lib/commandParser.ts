export type OrbAction =
  | "spin-left"
  | "spin-right"
  | "zoom-in"
  | "zoom-out"
  | "reset"
  | "gestures-on"
  | "gestures-off";

export type Command =
  | { type: "open"; target: string }
  | { type: "orb"; action: OrbAction }
  | { type: "cancel" }
  | { type: "unknown"; raw: string };

const OPEN_RE = /^(?:please\s+)?(?:open|launch|start|run|switch\s+to|go\s+to)\s+(?:up\s+)?(?:the\s+)?(.+?)(?:\s+app(?:lication)?)?$/i;

// System-level actions (lock, volume, brightness, power, media keys, …) have
// no "verb + noun" shape like "open X" — they're recognized by phrase and
// mapped onto the alias apps.json actually understands. These only ever do
// anything if the local agent (see /agent) is running and that alias exists
// in its allowlist; there is no web fallback for OS-level actions.
const SYSTEM_ACTIONS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /\b(take\s+a\s+)?screenshot\b/, target: "screenshot" },
  { pattern: /\block(\s+the)?(\s+screen|\s+computer|\s+pc)?\b/, target: "lock" },
  { pattern: /\b(go\s+to\s+)?sleep\b/, target: "sleep" },
  { pattern: /\bunmute\b/, target: "unmute" },
  { pattern: /\bmute\b/, target: "mute" },
  { pattern: /\b(turn\s+(the\s+)?volume\s+up|volume\s+up|increase\s+(the\s+)?volume)\b/, target: "volume up" },
  { pattern: /\b(turn\s+(the\s+)?volume\s+down|volume\s+down|decrease\s+(the\s+)?volume|lower\s+(the\s+)?volume)\b/, target: "volume down" },
  { pattern: /\bincrease\s+(the\s+)?brightness|brightness\s+up\b/, target: "brightness up" },
  { pattern: /\bdecrease\s+(the\s+)?brightness|brightness\s+down\b/, target: "brightness down" },
  { pattern: /\b(enable|turn\s+on)\s+(do\s+not\s+disturb|dnd)\b/, target: "dnd on" },
  { pattern: /\b(disable|turn\s+off)\s+(do\s+not\s+disturb|dnd)\b/, target: "dnd off" },
  { pattern: /\b(enable|turn\s+on)\s+wifi\b/, target: "wifi on" },
  { pattern: /\b(disable|turn\s+off)\s+wifi\b/, target: "wifi off" },
  { pattern: /\b(enable|turn\s+on)\s+bluetooth\b/, target: "bluetooth on" },
  { pattern: /\b(disable|turn\s+off)\s+bluetooth\b/, target: "bluetooth off" },
  { pattern: /\btoggle\s+dark\s+mode\b|\bdark\s+mode\b/, target: "dark mode" },
  { pattern: /\bempty\s+(the\s+)?(trash|recycle\s+bin)\b/, target: "empty trash" },
  { pattern: /\b(next\s+track|skip\s+track|skip\s+song)\b/, target: "next track" },
  { pattern: /\b(previous\s+track|last\s+track|previous\s+song)\b/, target: "previous track" },
  { pattern: /\b(play|pause)\s+(the\s+)?(music|media|song)\b/, target: "play pause" },
  { pattern: /\bshut\s*down(\s+(the\s+)?(computer|pc|system))?\b/, target: "shutdown" },
  { pattern: /\brestart(\s+(the\s+)?(computer|pc|system))?\b|\breboot\b/, target: "restart" },
  { pattern: /\b(sign|log)\s+out\b/, target: "sign out" },
];

export function parseCommand(raw: string): Command {
  const text = normalize(raw);
  if (!text) return { type: "unknown", raw };

  if (/\b(cancel|nevermind|never mind|nothing|forget it)\b/.test(text)) {
    return { type: "cancel" };
  }

  if (/\bzoom\s*in\b/.test(text)) return { type: "orb", action: "zoom-in" };
  if (/\bzoom\s*out\b/.test(text)) return { type: "orb", action: "zoom-out" };
  if (/\breset(\s+(the\s+)?view)?\b/.test(text)) return { type: "orb", action: "reset" };

  if (/\b(spin|rotate|turn)\s+left\b/.test(text)) return { type: "orb", action: "spin-left" };
  if (/\b(spin|rotate|turn)\s+right\b/.test(text)) return { type: "orb", action: "spin-right" };

  if (/\bgestures?\s+on\b/.test(text) || /\b(enable|turn on|start)\s+(hand\s+)?gestures?\b/.test(text)) {
    return { type: "orb", action: "gestures-on" };
  }
  if (/\bgestures?\s+off\b/.test(text) || /\b(disable|turn off|stop)\s+(hand\s+)?gestures?\b/.test(text)) {
    return { type: "orb", action: "gestures-off" };
  }

  for (const { pattern, target } of SYSTEM_ACTIONS) {
    if (pattern.test(text)) return { type: "open", target };
  }

  const open = text.match(OPEN_RE);
  if (open?.[1]) {
    const target = open[1].trim();
    if (target) return { type: "open", target };
  }

  return { type: "unknown", raw };
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?¿¡]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
