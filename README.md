# opencode-luxafor-status

OpenCode plugin that mirrors the focused OpenCode session on a USB [Luxafor Flag](https://luxafor.com/flag-usb-busylight-availability-indicator/).

The Flag follows only the *focused* session (the one a TUI is showing) plus its subagent sessions. Other sessions, including background sessions resumed after a service restart, do not affect it.

| Focused session state | Flag (default) |
|---|---|
| Idle, or no session focused yet | dim green |
| Busy (focused session or one of its subagents running) | solid red |
| Waiting for you (permission prompt / question in the focused session or a subagent) | amber strobe |
| Run failed (focused session or a subagent) | red strobe for 8 s |
| Plugin unloaded, last terminal closed, or focused session deleted/archived | off |

Priority: off > waiting > failed > busy > idle. "Off" also applies when no interactive `opencode` terminal is running. After the focused session is deleted or archived the Flag stays off until another session is focused (viewed, selected, or a new root session is created) or that session is unarchived.

## Install

Requires Node.js (on `PATH`), macOS with the Flag attached (VID `0x04D8`, PID `0xF372`) and OpenCode v2.

```sh
git clone <this repo> && cd opencode-luxafor-status && npm install
```

### Hook it up to a project

Create `.opencode/opencode.json` in the project whose OpenCode sessions the Flag should follow. This is all that is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../../opencode-luxafor-status"]
}
```

- The path is relative to the `.opencode` directory and must start with `../` or `./` (a bare `..` is not recognised). In the example the package is a sibling of the project; adjust the number of `../` for your layout, or use an absolute path.
- OpenCode reloads config on save; no restart is needed. The server log should show `loading plugin id=.../opencode-luxafor-status`.
- With one physical Flag, keep the plugin in one place: a project-local config as above, or the global `~/.config/opencode/opencode.json` (`"plugins": ["/absolute/path/to/opencode-luxafor-status"]`), not both.
- Once published to npm: `"plugins": ["opencode-luxafor-status"]`.
- To develop the plugin itself, use the same entry in this repository's own `.opencode/opencode.json`.

Test the hardware first: `node src/flag.mjs solid 0 255 0` (off: `solid 0 0 0`). If nothing happens, grant your terminal Input Monitoring in System Settings → Privacy & Security.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-luxafor-status",
      "options": {
        "node": "/opt/homebrew/bin/node",   // default: "node" from PATH (+ /opt/homebrew/bin, /usr/local/bin)
        "errorFlashMs": 8000,
        "closeOnTerminalExit": true,        // Flag off when no interactive opencode TUI process remains
        "pollMs": 3000,
        "terminalScope": "project",         // "project": only terminals whose cwd is inside this project; "any": every opencode terminal
        "colors": {                          // any of: idle, busy, input, error, off
          "busy": { "r": 0, "g": 0, "b": 255 },
          "input": { "mode": "strobe", "r": 255, "g": 110, "b": 0 }
        }
      }
    }
  ]
}
```

## How it works

The plugin subscribes to server events (`session.execution.*`, `session.deleted|archived|unarchived`, `permission.asked|replied`, `form.created|replied|cancelled`) and, when the aggregate state changes, runs `node src/flag.mjs <solid|strobe> R G B`, which writes a HID report with `node-hid`. A separate process is used because `process.execPath` inside the OpenCode server is the `opencode` binary, not Node.

Focus comes from `session.viewed` and `tui.session.select` events and from newly created root sessions (`session.created` without `parentID`); focusing a subagent focuses its root session. Subagents are linked to their parent via `session.created.parentID`, and at load via `session.list` (up to 100 sessions at the plugin's location), which also picks the initial focus: the most recently viewed, non-archived root session. Busy, pending and failure state is tracked for every session, so switching focus shows the right colour at once.

Pending prompts are also cleared when their session's run ends (succeeded, failed, interrupted), because an interrupt cancels a prompt without a reply event. The event stream has no replay, so on every focus change and every `pollMs` the plugin replaces the pending permissions of the focused session and its subagents with the server's list (`permission.list`); a sync that overlaps a permission/form/session-end event is discarded and retried on the next tick. Questions (forms) cannot be listed through the plugin API and rely on events only.

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Plugin: events → state → colour. |
| `src/flag.mjs` | HID writer; also the `luxafor-flag` bin. |
| `package.json` | Exports, `node-hid` dependency. |

## Notes

- `npm` may warn that `node-hid`'s install script is not approved; the prebuilt binding still works.
- One Flag only (first VID/PID match).

## Terminal close detection

The shared background service keeps running after a TUI closes, so the plugin polls `ps` every `pollMs` and looks for processes that have a tty and are `opencode` without a subcommand (`opencode`, `opencode -s ...`, `opencode <dir>`). With the default `terminalScope: "project"` only terminals whose working directory (via `lsof`) is inside the plugin's project count; with `"any"` every opencode terminal counts. When none are left the Flag goes off; when one appears again it resumes.
