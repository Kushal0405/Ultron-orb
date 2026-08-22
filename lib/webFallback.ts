// Used to open something useful in a new tab when the local native agent
// (see /agent) isn't running — keeps "open X" voice commands working with
// zero setup, at the cost of only reaching web apps instead of native ones.
const WEB_APPS: Record<string, string> = {
  gmail: "https://mail.google.com",
  mail: "https://mail.google.com",
  email: "https://mail.google.com",
  youtube: "https://youtube.com",
  google: "https://google.com",
  search: "https://google.com",
  maps: "https://maps.google.com",
  calendar: "https://calendar.google.com",
  drive: "https://drive.google.com",
  docs: "https://docs.google.com",
  sheets: "https://sheets.google.com",
  photos: "https://photos.google.com",
  spotify: "https://open.spotify.com",
  music: "https://open.spotify.com",
  netflix: "https://netflix.com",
  github: "https://github.com",
  chatgpt: "https://chat.openai.com",
  claude: "https://claude.ai",
  whatsapp: "https://web.whatsapp.com",
  twitter: "https://x.com",
  x: "https://x.com",
  reddit: "https://reddit.com",
  amazon: "https://amazon.com",
  slack: "https://slack.com/signin",
  notion: "https://notion.so",
  linkedin: "https://linkedin.com",
  instagram: "https://instagram.com",
  facebook: "https://facebook.com",
  twitch: "https://twitch.tv",
  wikipedia: "https://wikipedia.org",
  news: "https://news.google.com",
  weather: "https://weather.com",
};

export function resolveWebApp(target: string): string | null {
  const key = target.toLowerCase().trim();
  if (WEB_APPS[key]) return WEB_APPS[key];

  const words = key.split(/\s+/);
  const wordMatch = Object.keys(WEB_APPS).find((alias) => words.includes(alias));
  if (wordMatch) return WEB_APPS[wordMatch];

  // Substring fallback for a truncated/partial name (e.g. "spot" -> "spotify").
  // Only the alias-contains-target direction: the reverse ("unlock" containing
  // "lock") would make almost any longer word fuzzy-match a short alias.
  const alias = Object.keys(WEB_APPS).find((k) => k.length >= 4 && k.includes(key));
  return alias ? WEB_APPS[alias] : null;
}

export function openWebApp(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
