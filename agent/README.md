# ULTRON local agent (optional)

The web UI runs in a browser tab, which is sandboxed and can never launch
native applications or control your OS directly — no website can, by design.
This small local process is the one piece that can, and it's opt-in.

You run it yourself, on your own machine, and the web UI talks to it over a
`localhost`-only WebSocket. Without it, voice commands like "open Spotify"
still work by falling back to the web version in a new tab.

## Run it

```bash
npm run agent
```

On first run it generates a random auth token and prints it, e.g.:

```
ULTRON local agent
  listening: ws://127.0.0.1:8765 (localhost only)
  platform:  darwin
  token:     3f9a1c...  (also saved to agent/.token)
```

In the web UI, click **AGENT OFFLINE** in the HUD and paste that token in.
It's saved in your browser's `localStorage` so you only do this once per
browser.

## What's in the allowlist

[`apps.json`](./apps.json) ships with ~75 aliases out of the box:

| Category | Examples |
| --- | --- |
| Browsers | `chrome`, `firefox`, `edge`, `brave`, `safari` |
| Media | `spotify`, `music`, `vlc`, `itunes` |
| Mail / calendar / photos | `mail`, `outlook`, `calendar`, `photos`, `camera` |
| Dev tools | `vscode`, `terminal`, `iterm`, `docker`, `postman`, `xcode`, `android studio`, `github desktop` |
| Files / cloud | `finder`/`files`, `settings`, `dropbox`, `onedrive`, `google drive` |
| Communication | `slack`, `discord`, `whatsapp`, `messages`, `zoom`, `teams`, `telegram`, `signal` |
| Office / creative | `word`, `excel`, `powerpoint`, `notion`, `obsidian`, `figma`, `photoshop`, `illustrator` |
| Power | `lock`, `sleep`, `restart`, `shutdown`, `sign out` |
| Volume / brightness | `mute`, `unmute`, `volume up`/`down`, `brightness up`/`down` |
| Media keys | `play pause`, `next track`, `previous track` |
| Toggles | `wifi on`/`off`, `bluetooth on`/`off`, `dnd on`/`off`, `dark mode` |
| Misc | `calculator`, `notes`, `task manager`, `screenshot`, `empty trash`, `steam` |

`lib/commandParser.ts` on the web side already recognizes natural phrasings
for all the system actions above (e.g. "lock the screen", "turn up the
volume", "take a screenshot", "shut down my pc") and maps them onto these
exact aliases — you don't need to say the alias verbatim.

**Windows and Linux commands vary far more by install than macOS's `open -a`
does.** A few need a helper tool you may not have — `nircmd` (Windows volume
keys), `playerctl`/`brightnessctl`/`nmcli`/`bluetoothctl` (Linux media/power),
`blueutil` and a "Set Focus"/"Turn Off Focus" Shortcuts automation (macOS
Bluetooth/DND). Treat anything that doesn't fire on your machine as a hint to
edit that one line, not as broken — that's the point of this being a plain
JSON file instead of code.

**"Add all apps" isn't literally possible** — there's no fixed universe of
every app on every machine, so this can't be a complete list. It's meant to
cover common categories generously and be trivial to extend: add a line with
your app's launch command per OS and it's immediately voice-reachable, no
code changes.

## Security model

- It only ever runs commands that already exist in `apps.json`, looked up by
  alias (e.g. `"spotify"` → `open -a Spotify` on macOS). Voice or UI text is
  used **only** to pick an alias — it is never concatenated into a shell
  command, so there is no "run arbitrary text" path. This is deliberate: a
  voice-triggered shell would mean anything the mic mishears could execute
  on your machine, and that's not a tradeoff worth making even for
  convenience.
- It binds to `127.0.0.1` only, so nothing off your machine can reach it.
- It requires the token above before accepting any command.
- It rejects WebSocket connections whose `Origin` isn't the ULTRON dev
  server (`localhost:3000` / `127.0.0.1:3000`), so a random other tab open
  on your machine can't quietly drive it either.

A few entries (`shutdown`, `restart`, `empty trash`) are destructive by
nature — they're included because "full control" was the ask and this is
your own machine, opt-in, run by you. Delete any line from `apps.json` you
don't want voice-reachable; the agent only ever knows about what's in that
file.

Because this process can execute commands on your machine, only run it
locally, keep `agent/.token` out of version control (already gitignored),
and only add entries to `apps.json` you'd be fine running yourself.
