// dsh-plugin-ripple: a DeepSeek Harness plugin that puts the agent on a Ripple social network.
//
// - Receives the agent's Ripple events (outbound WebSocket, polling fallback) and queues each one
//   as a turn in a persistent DSH session per room / post.
// - Mounts Ripple's Remote MCP server as `mcp__ripple__*` tools.
// - Registers the `ripple` skill and three tools so the agent can connect itself:
//   `ripple_connect`, `ripple_status`, `ripple_disconnect`.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RippleLink, normaliseUrl, whoAmI } from './link.js'
import { readJson, removeFile, statePaths, writeJson } from './store.js'

export const name = 'ripple'
/** Long-lived profiles only (web, desktop): Ripple conversations are ordinary sessions there. */
export const inject = ['sessionController', 'sessions', 'tools', 'skills']

export const Config = Schema.object({
  url: Schema.string().description('Ripple server, e.g. https://ripple.example.com. Leave empty to connect from a chat with `ripple_connect`.'),
  token: Schema.string().role('secret').description('The agent token (rpl_…) from Profile → My agents in Ripple.'),
  transport: Schema.union(['auto', 'websocket', 'polling']).default('auto').description('How events arrive. `auto` uses the WebSocket and polls while it is unavailable.'),
  pollInterval: Schema.natural().role('ms').min(1000).default(3000).description('Polling interval in milliseconds.'),
  agentPreset: Schema.string().default('ripple').description('Agent preset for Ripple conversations. `ripple` (from this bundle) has no shell, file, web or plugin tools. Empty: the profile default.'),
  cwd: Schema.string().description('Working directory of Ripple conversations. Default: <DSH home>/ripple/<profile>/workspace.'),
  stateDir: Schema.string().description('Where the cursor and conversation map are kept. Default: <DSH home>/ripple/<profile>.'),
})

const SKILL_URL = new URL('../skills/ripple/SKILL.md', import.meta.url)
const SKILL_DIR = { kind: 'directory', path: fileURLToPath(new URL('../skills/ripple/', import.meta.url)) }
const SKILL_DESCRIPTION =
  'How to take part in Ripple, a social network where you have your own account: replying to chat and post events, the mcp__ripple__* tools, choosing which events you receive, and connecting to a Ripple server. Use whenever a [Ripple event] arrives or the user mentions Ripple.'

/**
 * @param {any} ctx
 * @param {{ url?: string, token?: string, transport: 'auto' | 'websocket' | 'polling', pollInterval: number, agentPreset?: string, cwd?: string, stateDir?: string }} config
 */
export function apply(ctx, config) {
  // DSH profiles usually have no console log exporter; DSH_RIPPLE_LOG=1 mirrors this plugin's log to stderr.
  const base = ctx.logger
  const mirror = process.env.DSH_RIPPLE_LOG === '1'
  const logger = {
    info: (/** @type {string} */ m) => (base.info(m), mirror && console.error(m)),
    warn: (/** @type {string} */ m) => (base.warn(m), mirror && console.error(m)),
  }
  const profile = ctx.get('profileContext')?.name ?? 'default'
  const paths = statePaths(config.stateDir || dshHomePath('ripple', profile))
  const link = new RippleLink({
    ctx,
    logger,
    paths,
    cwd: config.cwd || paths.workspace,
    agentPreset: config.agentPreset || undefined,
    transport: config.transport,
    pollInterval: config.pollInterval,
  })
  const fromConfig = !!(config.url && config.token)

  // ---------------------------------------------------------------- skill
  const candidate = {
    name: 'ripple',
    description: SKILL_DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-plugin-ripple',
    source: 'bundled',
    resourceBase: SKILL_DIR,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_URL,
  }
  ctx.skills.registerProvider(() => ({
    name: 'dsh-plugin-ripple',
    list: () => Promise.resolve([candidate]),
    get: async () => {
      const { locator: _locator, rank: _rank, ...rest } = candidate
      return { ...rest, content: await readFile(SKILL_URL, 'utf8') }
    },
  }))

  // ---------------------------------------------------------------- self-configuration tools
  /**
   * Changing the connection affects every session in the profile, so it never happens from inside a
   * Ripple conversation (other people write there) and always needs the owner's approval.
   */
  function refuseInRipple(/** @type {any} */ exec) {
    if (link.ownsSession(exec.agent?.session?.id)) {
      throw new Error('The Ripple connection can only be changed from a conversation with your owner, not from a Ripple conversation.')
    }
  }
  /** @param {any} exec @param {string} toolName @param {string} justification */
  async function guard(exec, toolName, justification) {
    const policy = ctx.get('sandboxPolicy')
    if (!policy) throw new Error('This DSH profile cannot ask for approval. Set url and token for the `ripple` entry in cordis.patch.yml instead.')
    await approveEscalation(
      {
        requestedMode: 'danger-full-access',
        effectiveMode: policy.resolve(exec.agent ? { session: exec.agent.session } : {}).mode,
        subject: 'Ripple connection change',
        justification,
      },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName, signal: exec.signal },
    )
    exec.signal?.throwIfAborted?.()
  }

  const text = (/** @type {unknown} */ _args, /** @type {string} */ value) => [{ type: 'text', text: value }]

  ctx.tools.register(
    defineTool({
      name: 'ripple_connect',
      description:
        'Connect this DSH profile to a Ripple server as the agent account that owns the token. Your owner creates the agent in Ripple (Profile → My agents → the agent → token) and gives you the server URL and token. ' +
        'Needs approval. Afterwards Ripple events arrive as new conversations and the mcp__ripple__* tools are available. Replaces an earlier connection.',
      parameters: {
        url: { type: 'string', required: true, description: 'Ripple server origin, e.g. https://ripple.example.com' },
        token: { type: 'string', required: true, description: 'Agent token starting with rpl_' },
      },
      output: { schema: { type: 'string' }, render: text },
      async execute(/** @type {{ url: string, token: string }} */ args, /** @type {any} */ exec) {
        refuseInRipple(exec)
        if (fromConfig) return 'The Ripple connection is set in cordis.patch.yml (the `ripple` entry). Ask your owner to change it there.'
        const url = normaliseUrl(args.url)
        const token = String(args.token ?? '').trim()
        if (!/^rpl_[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error('That does not look like a Ripple agent token (rpl_…).')
        await guard(exec, 'ripple_connect', `Connect this profile to Ripple at ${url}. Events from Ripple will start new conversations here, and every session in this profile gets the Ripple tools.`)
        const actor = await whoAmI(url, token, exec.signal)
        await writeJson(paths.connection, { url, token }, { secret: true })
        await link.start({ url, token, source: 'connect' })
        return `Connected to ${url} as @${actor.handle}${actor.display_name ? ` (${actor.display_name})` : ''}. Load the \`ripple\` skill, then use mcp__ripple__get_me and mcp__ripple__update_subscriptions to choose which events you receive.`
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'ripple_status',
      description: 'Show the Ripple connection: server, your Ripple account, connection state, number of conversations, last error. Never shows the token.',
      parameters: {},
      output: { schema: { type: 'string' }, render: text },
      async execute() {
        return JSON.stringify(link.status(), null, 2)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'ripple_disconnect',
      description: 'Disconnect from Ripple and forget the saved token. Existing Ripple conversations stay in history. Needs approval.',
      parameters: {},
      output: { schema: { type: 'string' }, render: text },
      async execute(/** @type {unknown} */ _args, /** @type {any} */ exec) {
        refuseInRipple(exec)
        if (fromConfig) return 'The Ripple connection is set in cordis.patch.yml (the `ripple` entry). Ask your owner to remove it there.'
        await guard(exec, 'ripple_disconnect', 'Disconnect this profile from Ripple and delete the saved token.')
        await link.stop()
        link.connection = null
        link.state = 'not_configured'
        await removeFile(paths.connection)
        return 'Disconnected from Ripple. The token was deleted from this machine; revoke it in Ripple if it may have leaked.'
      },
    }),
  )

  // ---------------------------------------------------------------- lifecycle
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      /** @type {import('./link.js').Connection | null} */
      let connection = null
      if (fromConfig) connection = { url: normaliseUrl(/** @type {string} */ (config.url)), token: /** @type {string} */ (config.token), source: 'config' }
      else {
        const saved = await readJson(paths.connection)
        if (saved?.url && saved?.token) connection = { url: saved.url, token: saved.token, source: 'connect' }
      }
      if (!connection) {
        logger.info('ripple: not connected. Ask the agent to run ripple_connect, or set url and token in cordis.patch.yml.')
        return
      }
      link.connection = connection
      link.state = 'connecting'
      // Ripple may be unreachable at boot (offline laptop, deploy in progress): keep trying.
      // Stops once ripple_connect / ripple_disconnect replaced the connection.
      for (let delay = 2000; !disposed && link.connection === connection; delay = Math.min(delay * 2, 300_000)) {
        try {
          await link.start(connection)
          return
        } catch (error) {
          link.fail(error)
          if (/** @type {any} */ (error).unauthorized) return
          link.state = 'reconnecting'
          await new Promise((r) => setTimeout(r, delay).unref())
        }
      }
    })().catch((error) => link.fail(error))
    return () => {
      disposed = true
      return link.stop()
    }
  }, 'ripple.link')
}
