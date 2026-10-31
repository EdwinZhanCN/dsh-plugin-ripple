// The connection to one Ripple agent account.
//
//   Ripple ──(WebSocket /ws/agents/<actor>, or polling /api/agent/events)──▶ RippleLink
//   RippleLink ──(followup into the room's / post's DSH session)──▶ agent
//   agent ──(Remote MCP `ripple`, mounted by RippleLink)──▶ Ripple /mcp
//
// The link only moves events. It never calls Ripple tools itself and never decides whether the
// agent should answer; the agent does that through MCP.
import { mkdir } from 'node:fs/promises'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { promptText, sessionKey, sessionTitle } from './prompt.js'
import { readJson, writeJson } from './store.js'

const PING_MS = 25_000
const RESUME_MS = 60_000
const SEEN_KEEP = 1000
const MAX_ATTEMPTS = 5

/**
 * @typedef {{ url: string, token: string, source: 'config' | 'connect' }} Connection
 * @typedef {'not_configured' | 'connecting' | 'connected' | 'polling' | 'reconnecting' | 'unauthorized' | 'stopped'} LinkState
 */

/** Normalise and check a Ripple origin. @param {string} raw */
export function normaliseUrl(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error(`Not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Ripple URL must start with https://')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')
  if (url.protocol === 'http:' && !local) throw new Error('Use https:// for a remote Ripple server; the token would travel in clear text')
  return url.origin
}

/**
 * Ask Ripple who a token belongs to.
 * @param {string} origin
 * @param {string} token
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ id: string, handle: string, display_name?: string, kind?: string }>}
 */
export async function whoAmI(origin, token, signal) {
  const res = await fetch(`${origin}/api/me/profile`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal })
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Ripple rejected the token (revoked, wrong, or the agent is disabled)'), { unauthorized: true })
  if (!res.ok) throw new Error(`Ripple answered HTTP ${res.status} at ${origin}/api/me/profile`)
  const body = await res.json()
  const me = body.actor ?? body
  if (!me?.id) throw new Error('Unexpected answer from Ripple: no actor id')
  if (me.kind && me.kind !== 'agent') throw new Error('This token belongs to a human account. Create an agent under Profile → My agents and use its token.')
  return me
}

export class RippleLink {
  /**
   * @param {object} options
   * @param {any} options.ctx plugin context (owns the MCP client fiber)
   * @param {any} options.logger
   * @param {ReturnType<import('./store.js').statePaths>} options.paths
   * @param {string} options.cwd working directory of Ripple sessions
   * @param {string | undefined} options.agentPreset
   * @param {'auto' | 'websocket' | 'polling'} options.transport
   * @param {number} options.pollInterval
   */
  constructor(options) {
    this.ctx = options.ctx
    this.logger = options.logger
    this.paths = options.paths
    this.cwd = options.cwd
    this.agentPreset = options.agentPreset
    this.transport = options.transport
    this.pollInterval = options.pollInterval
    this.sessionController = options.ctx.sessionController
    this.sessions = options.ctx.sessions
    /** @type {LinkState} */
    this.state = 'not_configured'
    /** @type {string | null} */
    this.lastError = null
    /** @type {Connection | null} */
    this.connection = null
    /** @type {{ id: string, handle: string, display_name?: string } | null} */
    this.actor = null
    /** @type {{ cursor: string | null, sessions: Record<string, string>, seen: string[] }} */
    this.data = { cursor: null, sessions: {}, seen: [] }
    this.seen = new Set()
    /** @type {Map<string, Promise<void>>} one delivery chain per conversation */
    this.chains = new Map()
    /** @type {Set<Promise<void>>} */
    this.inflight = new Set()
    /** @type {Map<string, number>} event id → failed hand-off attempts */
    this.failures = new Map()
    this.delivered = 0
    /** @type {AbortController | null} */
    this.abort = null
    /** @type {any} */
    this.mcp = null
    /** @type {WebSocket | null} */
    this.socket = null
    this.saveChain = Promise.resolve()
  }

  /** Whether a DSH session is one of the Ripple conversations. @param {string | undefined} sessionId */
  ownsSession(sessionId) {
    return !!sessionId && Object.values(this.data.sessions).includes(sessionId)
  }

  status() {
    return {
      state: this.state,
      url: this.connection?.url ?? null,
      configured_by: this.connection?.source ?? null,
      actor: this.actor ? { id: this.actor.id, handle: this.actor.handle, display_name: this.actor.display_name } : null,
      conversations: Object.keys(this.data.sessions).length,
      events_delivered_since_start: this.delivered,
      last_error: this.lastError,
    }
  }

  /**
   * Connect (or reconnect with new settings). Verifies the token first; the previous connection
   * keeps running if verification fails.
   * @param {Connection} connection
   */
  async start(connection) {
    const actor = await whoAmI(connection.url, connection.token)
    await this.stop()
    const abort = new AbortController()
    this.abort = abort
    this.connection = connection
    this.actor = actor
    this.lastError = null
    this.state = 'connecting'
    this.data = { cursor: null, sessions: {}, seen: [], ...((await readJson(this.paths.actorState(actor.id))) ?? {}) }
    this.seen = new Set(this.data.seen)
    this.failures = new Map()
    await mkdir(this.cwd, { recursive: true })
    // Ripple's MCP tools become `mcp__ripple__*` for agents in this profile. Config() validates and
    // fills defaults but does not keep `headers` (DSH's ACP bridge re-attaches them the same way).
    const headers = { Authorization: `Bearer ${connection.token}` }
    const mcpConfig = McpClient.Config({ transport: 'streamable-http', serverName: 'ripple', url: `${connection.url}/mcp`, headers, failOnStartupError: false })
    this.mcp = this.ctx.plugin(McpClient, { ...mcpConfig, headers })
    // Sessions capture their tool catalog, so the Ripple tools must be registered before the
    // first event creates one. The fiber settles once the client's first connection attempt did.
    await this.mcp
    await this.waitForTools(abort.signal)
    this.logger.info(`ripple: connected as @${actor.handle} (${actor.id}) at ${connection.url}`)
    void this.run(abort.signal).catch((error) => {
      if (abort.signal.aborted) return
      this.fail(error)
    })
    return actor
  }

  /**
   * Wait (up to 30 s) until Ripple's tools are registered. If Ripple's MCP endpoint is down, events
   * still flow; sessions created meanwhile simply lack the tools until DSH refreshes them.
   * @param {AbortSignal} signal
   */
  async waitForTools(signal) {
    const tools = this.ctx.tools
    const end = Date.now() + 30_000
    while (!signal.aborted && Date.now() < end) {
      if (tools.get('mcp__ripple__get_me')) return
      await sleep(200, signal)
    }
    if (!signal.aborted) this.logger.warn('ripple: Ripple MCP tools are not available yet; continuing without them')
  }

  /** Stop receiving events and unmount the MCP tools. Saved state stays. */
  async stop() {
    this.abort?.abort()
    this.abort = null
    try {
      this.socket?.close(1000, 'stopping')
    } catch {
      /* already closed */
    }
    this.socket = null
    const mcp = this.mcp
    this.mcp = null
    if (mcp) await Promise.resolve(mcp.dispose()).catch((/** @type {unknown} */ e) => this.logger.warn(`ripple: MCP client teardown: ${String(e)}`))
    await Promise.allSettled([...this.inflight])
    if (this.actor) await this.save()
    if (this.state !== 'unauthorized') this.state = this.connection ? 'stopped' : 'not_configured'
  }

  /** @param {unknown} error */
  fail(error) {
    const e = /** @type {Error & { unauthorized?: boolean }} */ (error)
    this.lastError = e.message ?? String(error)
    if (e.unauthorized) this.state = 'unauthorized'
    this.logger.warn(`ripple: ${this.lastError}`)
  }

  // ------------------------------------------------------------------ transports

  /** @param {AbortSignal} signal */
  async run(signal) {
    if (this.transport === 'polling') return this.pollLoop(signal, Infinity)
    let backoff = 1000
    while (!signal.aborted) {
      try {
        const code = await this.runSocket(signal)
        if (code === 4001) throw Object.assign(new Error('Ripple closed the connection: token revoked or agent disabled'), { unauthorized: true })
        backoff = 1000
      } catch (error) {
        if (/** @type {any} */ (error).unauthorized) {
          this.fail(error)
          return
        }
        if (signal.aborted) return
        this.lastError = /** @type {Error} */ (error).message
        if (this.transport === 'auto') {
          // WebSocket unavailable (proxy, outage): poll for a while, then try the socket again.
          const span = Math.max(backoff, 15_000)
          this.state = 'polling'
          await this.pollLoop(signal, span)
          if (this.state === 'unauthorized') return
        }
      }
      if (signal.aborted) return
      this.state = 'reconnecting'
      await sleep(backoff, signal)
      backoff = Math.min(60_000, backoff * 2)
    }
  }

  /** One WebSocket session. Resolves with the close code; rejects if the upgrade fails. @param {AbortSignal} signal */
  runSocket(signal) {
    const conn = /** @type {Connection} */ (this.connection)
    const actor = /** @type {{ id: string }} */ (this.actor)
    const url = new URL(`${conn.url}/ws/agents/${encodeURIComponent(actor.id)}`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new Promise((resolve, reject) => {
      let opened = false
      /** @type {NodeJS.Timeout | undefined} */ let resumer
      /** @type {NodeJS.Timeout | undefined} */ let pinger
      // Node's WebSocket (undici) accepts `headers`; the token never goes in the URL.
      const ws = new WebSocket(url, /** @type {any} */ ({ headers: { authorization: `Bearer ${conn.token}` } }))
      this.socket = ws
      const send = (/** @type {unknown} */ m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))
      const onAbort = () => ws.close(1000, 'stopping')
      signal.addEventListener('abort', onAbort, { once: true })
      ws.addEventListener('open', () => {
        opened = true
        this.state = 'connected'
        this.lastError = null
        send({ type: 'resume', cursor: this.data.cursor })
        resumer = setInterval(() => send({ type: 'resume', cursor: this.data.cursor }), RESUME_MS)
        pinger = setInterval(() => send({ type: 'ping' }), PING_MS)
      })
      ws.addEventListener('message', (m) => {
        let msg
        try {
          msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString())
        } catch {
          return
        }
        if (msg.type === 'event') {
          this.deliver(msg.event)
          send({ type: 'ack', event_id: msg.event?.id })
        } else if (msg.type === 'resumed') {
          void this.commitCursor(msg.cursor)
          if (msg.has_more) send({ type: 'resume', cursor: msg.cursor })
        } else if (msg.type === 'error') {
          this.logger.warn(`ripple: server error ${msg.code}: ${msg.message}`)
        }
      })
      ws.addEventListener('close', (ev) => {
        clearInterval(resumer)
        clearInterval(pinger)
        signal.removeEventListener('abort', onAbort)
        if (this.socket === ws) this.socket = null
        if (!opened) reject(Object.assign(new Error(`WebSocket upgrade failed (${ev.code})`), { unauthorized: ev.code === 4001 }))
        else resolve(ev.code)
      })
      ws.addEventListener('error', () => {
        /* close follows */
      })
    })
  }

  /** @param {AbortSignal} signal @param {number} spanMs */
  async pollLoop(signal, spanMs) {
    const end = Date.now() + spanMs
    if (this.transport === 'polling') this.state = 'polling'
    while (!signal.aborted && Date.now() < end) {
      try {
        if (await this.pollOnce(signal)) continue
        this.lastError = null
      } catch (error) {
        if (signal.aborted) return
        if (/** @type {any} */ (error).unauthorized) {
          this.fail(error)
          return
        }
        this.lastError = /** @type {Error} */ (error).message
      }
      await sleep(this.pollInterval, signal)
    }
  }

  /** @param {AbortSignal} signal @returns {Promise<boolean>} whether more events are waiting */
  async pollOnce(signal) {
    const conn = /** @type {Connection} */ (this.connection)
    const url = new URL(`${conn.url}/api/agent/events`)
    if (this.data.cursor) url.searchParams.set('cursor', this.data.cursor)
    url.searchParams.set('limit', '50')
    const res = await fetch(url, { headers: { authorization: `Bearer ${conn.token}` }, signal })
    if (res.status === 401) throw Object.assign(new Error('Ripple rejected the token (401)'), { unauthorized: true })
    if (!res.ok) throw new Error(`Polling failed: HTTP ${res.status}`)
    const page = await res.json()
    for (const event of page.items ?? []) this.deliver(event)
    await this.commitCursor(page.next_cursor)
    return !!page.has_more
  }

  // ------------------------------------------------------------------ events → sessions

  /** @param {import('./prompt.js').RippleEvent} event */
  deliver(event) {
    if (!event?.id || this.seen.has(event.id)) return
    this.seen.add(event.id)
    this.data.seen.push(event.id)
    if (this.data.seen.length > SEEN_KEEP) for (const old of this.data.seen.splice(0, SEEN_KEEP / 2)) this.seen.delete(old)
    const key = sessionKey(event)
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.prompt(key, event))
      .then(() => {
        this.failures.delete(event.id)
      })
      .catch((error) => {
        const attempts = (this.failures.get(event.id) ?? 0) + 1
        this.lastError = `Could not hand event ${event.id} to the agent (attempt ${attempts}): ${/** @type {Error} */ (error).message}`
        this.logger.warn(`ripple: ${this.lastError}`)
        if (attempts < MAX_ATTEMPTS) {
          // Hold the cursor and forget the id, so the next resume replays and retries it.
          this.failures.set(event.id, attempts)
          this.seen.delete(event.id)
          this.data.seen = this.data.seen.filter((id) => id !== event.id)
        } else {
          this.failures.delete(event.id)
          this.logger.warn(`ripple: giving up on event ${event.id}`)
        }
      })
    this.chains.set(key, next)
    this.inflight.add(next)
    void next.finally(() => this.inflight.delete(next))
  }

  /**
   * Queue the event as a turn in the conversation's session. Like DSH's own scheduler, the
   * delivery counts once the session log has the message; the agent's turn runs on its own.
   * @param {string} key @param {import('./prompt.js').RippleEvent} event
   */
  async prompt(key, event) {
    const agent = await this.agentFor(key)
    const message = createUserMessage({ content: [{ type: 'text', text: promptText(event) }], source: { kind: 'ripple' } })
    agent.followup(message)
    const flushed = await this.sessions.flush(agent.session)
    if (flushed === false) throw new Error('session log did not acknowledge the event')
    this.delivered++
  }

  /** The live agent of a conversation, resuming or creating its session. @param {string} key */
  async agentFor(key) {
    const known = this.data.sessions[key]
    if (known) {
      const resolved = await this.sessionController.resolveAgent(known)
      if (!('error' in resolved)) return resolved.agent
      if (resolved.error?.code !== 'session/not-found') throw resolved.error
      this.logger.info(`ripple: session for ${key} is gone, starting a new one`)
    }
    let created
    try {
      created = await this.sessionController.create({ cwd: this.cwd, ...(this.agentPreset ? { agentPreset: this.agentPreset } : {}) })
    } catch (error) {
      if (!this.agentPreset || /** @type {any} */ (error)?.code !== 'agent-preset/not-found') throw error
      this.logger.warn(`ripple: agent preset "${this.agentPreset}" not found; Ripple conversations use the profile default, which may include shell and file tools`)
      this.agentPreset = undefined
      created = await this.sessionController.create({ cwd: this.cwd })
    }
    const resolved = await this.sessionController.resolveAgent(created.sessionId)
    if ('error' in resolved) throw resolved.error
    const agent = resolved.agent
    this.data.sessions[key] = created.sessionId
    await this.save()
    const titles = this.ctx.get('sessionTitle')
    try {
      await titles?.rename?.(agent.session, sessionTitle(key))
    } catch {
      /* titles are cosmetic */
    }
    return agent
  }

  /** Persist a cursor once every event handed out so far is in a session log (at-least-once). @param {string | null | undefined} cursor */
  async commitCursor(cursor) {
    if (!cursor || cursor === this.data.cursor) return
    await Promise.allSettled([...this.inflight])
    // A failed hand-off keeps the old cursor so the event is replayed and retried.
    if (this.failures.size > 0) return
    this.data.cursor = cursor
    await this.save()
  }

  save() {
    const actor = this.actor
    if (!actor) return Promise.resolve()
    const snapshot = { ...this.data, seen: this.data.seen.slice(-SEEN_KEEP / 2) }
    this.saveChain = this.saveChain.then(() => writeJson(this.paths.actorState(actor.id), snapshot)).catch((e) => this.logger.warn(`ripple: could not save state: ${String(e)}`))
    return this.saveChain
  }
}

/** @param {number} ms @param {AbortSignal} signal */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined)
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve(undefined)
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
