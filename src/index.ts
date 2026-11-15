import { Plugin } from "@opencode/plugin"
import { execFile, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// Mirrors the focused OpenCode session (and its subagents) onto a Luxafor Flag.
//   idle -> green, busy -> red, needs input (permission/question) -> amber strobe,
//   failed -> red strobe for `errorFlashMs`, plugin unload -> off.
type State = "idle" | "busy" | "input" | "error" | "off"
type Color = { mode?: "solid" | "strobe"; r: number; g: number; b: number }

const DEFAULTS: Record<State, Color> = {
  idle: { r: 0, g: 80, b: 0 },
  busy: { r: 255, g: 0, b: 0 },
  input: { mode: "strobe", r: 255, g: 110, b: 0 },
  error: { mode: "strobe", r: 255, g: 0, b: 0 },
  off: { r: 0, g: 0, b: 0 },
}

// True for an interactive opencode TUI process (has a tty, no subcommand like `serve`/`api`/`run`).
function tuiPid(line: string): string | undefined {
  const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
  if (!m || m[2] === "??") return undefined
  const [argv0 = "", first] = (m[3] ?? "").split(/\s+/)
  if (argv0.split("/").pop() !== "opencode") return undefined
  const ok = first === undefined || first === "" || first.startsWith("-") || /[/.~]/.test(first)
  return ok ? m[1] : undefined
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) =>
    execFile(cmd, args, { maxBuffer: 4_000_000 }, (err, out) => resolve(err ? "" : out)),
  )

// Count interactive opencode terminals; with `dir`, only those whose cwd is inside that directory.
async function countTuis(dir?: string): Promise<number> {
  const ps = await run("ps", ["-axo", "pid=,tty=,command="])
  if (!ps) return -1 // ps failed: unknown
  const pids = ps.split("\n").map(tuiPid).filter(Boolean) as string[]
  if (!dir || pids.length === 0) return pids.length
  const out = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"])
  const root = dir.replace(/\/+$/, "")
  return out.split("\n").filter((l) => l.startsWith("n") && (l.slice(1) === root || l.startsWith(`n${root}/`))).length
}

const FLAG = fileURLToPath(new URL("./flag.mjs", import.meta.url))

export default Plugin.define({
  id: "luxafor-status",
  async setup(ctx) {
    const o = ctx.options as {
      node?: string
      errorFlashMs?: number
      closeOnTerminalExit?: boolean
      pollMs?: number
      terminalScope?: "project" | "any"
      colors?: Partial<Record<State, Color>>
    }
    const node = typeof o.node === "string" ? o.node : "node"
    const errorFlashMs = typeof o.errorFlashMs === "number" ? o.errorFlashMs : 8000
    const scopeDir = o.terminalScope === "any" ? undefined : ctx.location.directory
    const closeOnExit = o.closeOnTerminalExit !== false
    const pollMs = typeof o.pollMs === "number" ? o.pollMs : 3000
    const colors = { ...DEFAULTS, ...(o.colors ?? {}) }

    // busy/pending/failures are tracked for every session so a focus switch shows the right state at once;
    // only the focused session and its descendants (subagents) drive the Flag.
    const busy = new Set<string>()
    const pending = new Map<string, string | undefined>() // permission/form id -> sessionID awaiting an answer
    const forms = new Set<string>() // form ids in `pending`; the plugin API cannot list forms, so sync keeps them
    const failedAt = new Map<string, number>() // sessionID -> time of its last failed run
    const parent = new Map<string, string>() // child sessionID -> parentID
    let focus: string | undefined // root session a TUI is showing
    let focusGone = false // focused session deleted/archived: off until a new focus event
    let version = 0 // bumped by every pending-affecting event; a sync that raced one is discarded
    let syncing = false
    let syncFailed = false
    let noTui = false // no interactive opencode terminal left
    let shown: State | undefined
    let chain: Promise<void> = Promise.resolve()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const controller = new AbortController()

    const send = (state: State) =>
      (chain = chain.then(
        () =>
          new Promise<void>((resolve) => {
            const c = colors[state]
            // process.execPath is the opencode binary inside the server, not node.
            const p = spawn(node, [FLAG, c.mode ?? "solid", String(c.r), String(c.g), String(c.b)], {
              stdio: "ignore",
              env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` },
            })
            p.on("error", (err) => (console.error("luxafor-status: spawn failed", err), resolve()))
            p.on("exit", () => resolve())
          }),
      ))

    const rootOf = (sid: string) => {
      for (let n = 0; parent.has(sid) && n < 64; n++) sid = parent.get(sid)!
      return sid
    }
    const inFamily = (sid: string | undefined) => {
      for (let n = 0; sid && n < 64; sid = parent.get(sid), n++) if (sid === focus) return true
      return false
    }
    const family = () => new Set([focus!, ...[...parent.keys(), ...busy, ...pending.values()].filter(inFamily) as string[]])

    const compute = (): State => {
      if (focusGone || noTui) return "off"
      if (!focus) return "idle"
      if ([...pending.values()].some(inFamily)) return "input"
      const now = Date.now()
      for (const [sid, at] of failedAt) if (now < at + errorFlashMs && inFamily(sid)) return "error"
      if ([...busy].some(inFamily)) return "busy"
      return "idle"
    }
    const refresh = () => {
      if (controller.signal.aborted) return
      const next = compute()
      if (next === shown) return
      shown = next
      void send(next)
    }
    const setFocus = (sid: string | undefined) => {
      if (!sid) return
      focus = rootOf(sid)
      focusGone = false
      refresh()
      void syncPending()
    }

    const dropSession = (sessionID: string) => {
      for (const [id, owner] of pending) if (owner === sessionID) pending.delete(id), forms.delete(id)
    }

    // The event stream has no replay and some cancellations emit no reply event, so periodically
    // replace the tracked permissions of the focused family with the server's pending list.
    const syncPending = async () => {
      if (syncing || !focus) return
      syncing = true
      const v = version
      const sessions = family()
      try {
        const snap = new Map<string, string | undefined>()
        await Promise.all(
          [...sessions].map(async (sessionID) => {
            try {
              for (const p of await ctx.permission.list({ sessionID })) snap.set(p.id, p.sessionID)
              syncFailed = false
            } catch (err) {
              if (!syncFailed) console.error("luxafor-status: pending sync failed", err)
              syncFailed = true
              // Keep what we know about this session rather than guessing.
              for (const [id, owner] of pending) if (owner === sessionID && !forms.has(id)) snap.set(id, owner)
            }
          }),
        )
        if (v !== version) return
        for (const [id, owner] of pending) if (owner && sessions.has(owner) && !forms.has(id)) pending.delete(id)
        for (const [id, owner] of snap) pending.set(id, owner)
        refresh()
      } finally {
        syncing = false
      }
    }

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as any
        const d = e.data ?? {}
        switch (e.type) {
          case "session.viewed":
          case "tui.session.select":
            setFocus(d.sessionID)
            break
          case "session.created":
            if (d.parentID) parent.set(d.sessionID, d.parentID)
            else setFocus(d.sessionID)
            break
          case "session.unarchived":
            if (d.sessionID === focus) focusGone = false
            break
          case "session.deleted":
          case "session.archived":
            busy.delete(d.sessionID)
            dropSession(d.sessionID)
            version++
            if (d.sessionID === focus) focusGone = true
            break
          case "session.execution.started":
            busy.add(d.sessionID)
            break
          // A finished/interrupted run has nothing left to answer; interrupts cancel prompts without a reply event.
          case "session.execution.succeeded":
          case "session.execution.interrupted":
            busy.delete(d.sessionID)
            dropSession(d.sessionID)
            version++
            break
          case "session.execution.failed":
            busy.delete(d.sessionID)
            dropSession(d.sessionID)
            version++
            {
              const sid: string = d.sessionID
              const at = Date.now()
              failedAt.set(sid, at)
              const t = setTimeout(() => {
                timers.delete(t)
                if (failedAt.get(sid) === at) failedAt.delete(sid)
                refresh()
              }, errorFlashMs + 100)
              timers.add(t)
            }
            break
          case "permission.asked":
            pending.set(d.id, d.sessionID)
            version++
            break
          case "permission.replied":
            pending.delete(d.requestID)
            version++
            break
          case "form.created":
            pending.set(d.form?.id, d.form?.sessionID)
            forms.add(d.form?.id)
            version++
            break
          case "form.replied":
          case "form.cancelled":
            pending.delete(d.id)
            forms.delete(d.id)
            version++
            break
          default:
            continue
        }
        refresh()
      }
    })().catch((err) => console.error("luxafor-status: event stream ended", err))

    // The background service outlives the TUI, so watch for terminal processes instead.
    const poll = setInterval(async () => {
      void syncPending()
      if (!closeOnExit) return
      const found = await countTuis(scopeDir)
      if (found < 0) return
      const none = found === 0
      if (none === noTui) return
      noTui = none
      refresh()
    }, pollMs)

    // Initial focus: the most recently viewed root session at this location (none -> idle until one is viewed).
    void (async () => {
      try {
        const list = await ctx.session.list({ limit: 100, order: "desc" })
        let best: { id: string; viewed: number } | undefined
        for (const s of list.data) {
          if (s.parentID) parent.set(s.id, s.parentID)
          else if (!s.time.archived && s.time.viewed && (!best || s.time.viewed > best.viewed)) best = { id: s.id, viewed: s.time.viewed }
        }
        if (!focus && best) setFocus(best.id)
      } catch (err) {
        console.error("luxafor-status: session list failed", err)
      }
      refresh()
    })()

    refresh()
    return () => {
      clearInterval(poll)
      controller.abort()
      for (const t of timers) clearTimeout(t)
      void send("off")
    }
  },
})
