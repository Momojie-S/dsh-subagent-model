/**
 * Model-selectable delegation: a fork of `@deepseek-ai/dsh-tool-subagent`
 * (v0.1.0-rc line) that exposes the child's model route AND context
 * inheritance as PER-CALL tool arguments. By default (`defaultContext:
 * 'inherit'`) the child is forked from the delegating conversation: seeded,
 * at the moment of the call, with its completed-turn prefix — the latest
 * state, not a snapshot frozen at session open. `fresh_context: true` starts
 * an empty-context child instead. Everything else — provider lifecycle,
 * background policy, continuable children, settlement — is upstream behavior
 * kept verbatim. Changes are marked with `// fork:` comments.
 * @module @momojie-s/dsh-subagent-model
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { assertSubagentMaxDepth, settleRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'

// fork: plugin name distinguishes this instance from the upstream tool.
export const name = 'subagent-model'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /**
   * The `ctx.subagents` provider name for FRESH-CONTEXT calls (e.g.
   * `spawn`): a child that starts with no inherited conversation. Must not
   * name a provider that seeds children with parent context.
   */
  provider: string
  /**
   * fork: the `ctx.subagents` provider name for INHERIT-CONTEXT calls —
   * one whose children are seeded with the delegating conversation's
   * completed-turn prefix AT THE MOMENT OF THE CALL (default `fork`). The
   * seed is recomputed on every start from the live session log, so each
   * inherited-context child sees the conversation's latest completed turns,
   * never a snapshot frozen at session open or at an earlier call.
   */
  inheritProvider?: string
  /**
   * fork: context mode used when a call omits `fresh_context` (default
   * `inherit` — the child is forked from this conversation). `fresh`
   * restores the upstream always-empty-context default; an explicit
   * `fresh_context` argument overrides this either way.
   */
  defaultContext?: 'inherit' | 'fresh'
  /**
   * Model-facing tool name (default `subagent_model`). Each loaded instance must
   * use a distinct name, and it must not collide with the upstream `subagent`
   * tool mounted by the deployment.
   */
  toolName?: string
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a
   * provider with the `prepareContinuable` capability, and returns the durable
   * child id. Follow-up adapters remain independently optional.
   *
   * fork: `continuable` routes background calls of BOTH context modes to
   * durable continuable children (fresh-context calls also DEFAULT to
   * background; inherited-context calls default to foreground and reach a
   * durable forked child only through an explicit `run_in_background: true`).
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child as DEFAULTS; omitted fields fall back
   * to the parent's route. Per-call `provider`/`model`/`max_tokens` arguments
   * shadow these fields on each call.
   */
  agentOptions?: AgentOptions
  /**
   * Validate call-selected routes against the `llm` registry before starting
   * the child (default true). An unknown provider or model fails fast with the
   * available directory listed in the error. The model check is authoritative
   * whenever the effective route has a listable `listModels` directory; a
   * route with no directory falls back to `resolveModelInfo` shape validation
   * and otherwise leaves the id to the endpoint.
   */
  validateModel?: boolean
  /**
   * Per-child persona that shadows `deployment:persona`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (default `3`; `0` forbids
   * delegation entirely), or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  // fork: per-call context inheritance configuration. Defaults mirror the
  // interface docs; direct apply() reads them through the same `??` fallbacks.
  inheritProvider: z.string().default('fork'),
  defaultContext: z.union(['inherit', 'fresh'] as const).default('inherit'),
  // fork: default toolName avoids colliding with the upstream `subagent` tool.
  toolName: z.string().default('subagent_model'),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as { provider: string; model: string; maxTokens: number }),
  // fork: route validation switch for call-selected provider/model values.
  validateModel: z.boolean().default(true),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default(3),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job. (rc.7 upstream)
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append the child's preserved partial answer to a stop-reason error so a
 * truncated or cancelled child's real text still reaches the parent model.
 * @param error - the stop-reason headline.
 * @param output - the child's selected output (`SubagentResult.output`).
 * @returns the headline, extended with the partial text when any exists.
 */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withPartialText(error, result.output))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        // Content blocks already cross durable JSON boundaries elsewhere;
        // the registry performs the authoritative lossless snapshot here.
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * fork: fail fast with a teaching error when a call-selected route names a
 * provider or model the `llm` registry does not know. The provider check is
 * exact against registered routes; the model check is AUTHORITATIVE over the
 * catalog whenever `listModels` returns one — an id the directory omits is
 * rejected before any child session exists, because `resolveModelInfo`
 * acceptance proves nothing (it validates metadata shape, not membership,
 * and passes ids the endpoint will later reject). A route with no listable
 * directory falls back to resolveModelInfo shape validation and otherwise
 * leaves the id to endpoint-side judgment.
 * @param llm - the live llm registry.
 * @param parent - the delegating agent whose route supplies an inherited provider.
 * @param requested - the call-selected route fields, when any.
 * @param signal - caller cancellation for the advisory lookups.
 */
async function assertCallRouteResolvable(
  llm: LlmRuntime,
  parent: Agent,
  requested: { provider?: string; model?: string },
  signal: AbortSignal | undefined,
): Promise<void> {
  if (requested.provider !== undefined) {
    const ids = llm.listProviders().map(info => info.id)
    if (!ids.includes(requested.provider)) {
      throw new Error(
        `unknown provider "${requested.provider}" — available provider routes: ${ids.length > 0 ? ids.join(', ') : '(none)'}`,
      )
    }
  }
  if (requested.model !== undefined) {
    const provider = requested.provider ?? parent.options.provider
    if (provider === undefined) return
    let catalog: string[] = []
    try {
      catalog = (await llm.listModels(provider)).map(info => info.id)
    } catch {
      // Unlistable route: no authoritative directory exists; fall through.
    }
    if (catalog.length > 0) {
      // fork: the directory is AUTHORITATIVE when it exists. resolveModelInfo
      // only validates metadata shape and accepts ids listModels omits, so a
      // cross-route model id (e.g. a GLM id inherited under a deepseek route)
      // used to pass here and die silently inside the child's first request.
      if (!catalog.includes(requested.model)) {
        throw new Error(
          `model "${requested.model}" is not available on provider "${provider}" — available models: ${catalog.join(', ')}. The model argument is interpreted by the EFFECTIVE route (explicit provider, else the inherited parent route); pass provider too when the model belongs to another route.`,
        )
      }
      return
    }
    // Directory absent: keep endpoint-side judgment, but let resolveModelInfo
    // shape validation catch what it can before any child session exists.
    await llm.resolveModelInfo(provider, requested.model, signal)
  }
}

/**
 * fork: model-facing wording for per-call context inheritance. An omitted
 * `fresh_context` follows {@link Config.defaultContext}; an explicit
 * argument flips the mode either way. Inherited-context children are seeded,
 * at the moment of the call, with the conversation's completed-turn prefix
 * (the delegating in-flight turn is structurally excluded — an unbalanced
 * turn cannot be replayed); fresh-context children start empty and need a
 * standalone prompt.
 * @param defaultInherit - whether an omitted `fresh_context` inherits.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function contextWording(defaultInherit: boolean): { description: string; promptDescription: string } {
  if (defaultInherit) {
    return {
      description:
        'Delegate a task to a subagent running on a model route you choose per call. By default the child '
        + 'is forked from this conversation: it is seeded, at the moment of the call, with all completed turns '
        + 'so far — the conversation\'s latest state, not an older snapshot (the current in-flight turn is '
        + 'excluded). Use this default when the subtask builds on this conversation\'s context — a follow-up '
        + 'analysis, a review, a continuation — without consuming this conversation\'s context for the work '
        + 'itself. Pass fresh_context: true to start the child with an empty context instead, and prefer that '
        + 'for self-contained work: an inherited context re-sends the whole conversation on the child\'s '
        + 'route. You receive the child\'s result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. By default the child already sees this conversation\'s completed turns '
        + 'as of this call, so build on them freely and state only what is new. With fresh_context: true it '
        + 'sees nothing of this conversation — include everything it needs.',
    }
  }
  return {
    description:
      'Delegate a task to a subagent running on a model route you choose per call. By default the child '
      + 'starts with an empty context: give it a complete, standalone prompt — it does not see this '
      + 'conversation. Pass fresh_context: false to fork the child from this conversation instead: it is '
      + 'seeded, at the moment of the call, with all completed turns so far — the latest state, not an older '
      + 'snapshot (the current in-flight turn is excluded) — which suits subtasks that build on this '
      + 'conversation\'s context. You receive the child\'s result, not its intermediate steps.',
    promptDescription:
      'The complete, self-contained task for the subagent. By default it does not share this '
      + 'conversation\'s context, so include everything it needs. With fresh_context: false it already '
      + 'sees this conversation\'s completed turns as of the call, and you can state only what is new.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly defaultBackground: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // fork: the omitted-argument default is mode-specific. Fresh-context
    // children under `backgroundMode: continuable` keep the upstream
    // independently-scheduled default (background, durable child); one-shot
    // policy and inherited-context children keep the foreground default —
    // an inherited-context delegation usually feeds the caller's next action,
    // and its background result would require Job collection. An explicit
    // run_in_background argument overrides the default on every path.
    runInBackground: request.run_in_background ?? options.defaultBackground,
  }
}

export function apply(ctx: Context, config: Config): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent_model'
  // fork: dual-mode defaults. `provider` serves fresh-context calls;
  // `inheritProvider` serves inherited-context calls (see Config docs).
  const defaultInherit = (config.defaultContext ?? 'inherit') === 'inherit'
  const inheritName = config.inheritProvider ?? 'fork'
  // Mirror provider lifecycle because sibling load order and HMR replacement
  // can change provider availability while this fiber remains active.
  let disposeTool: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // A numeric cap the provider cannot enforce is a misconfiguration — fail at
    // mount (the earliest point the provider's capabilities are known), not on
    // the first delegation.
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    // fork: the configured provider backs the fresh-context mode, so it must
    // not itself seed parent context — a fresh_context call promises an
    // empty-context child, and wording over an inheriting provider would lie.
    if (provider.inheritsParentContext) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" seeds children with the parent conversation — `
        + 'config.provider must name a fresh-context provider (e.g. "spawn"); name a forking provider '
        + 'through inheritProvider instead',
      )
    }
    // fork: when the inherit provider is already registered, fail its numeric
    // maxDepth incompatibility at mount too; a later-registering provider is
    // still covered by the service's per-start capability check.
    const inheritProvider = ctx.subagents.getProvider(inheritName)
    if (typeof config.maxDepth === 'number' && inheritProvider !== undefined
      && !inheritProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: inherit provider "${inheritName}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' or use a depthLimit-capable inheritProvider',
      )
    }
    const wording = contextWording(defaultInherit)
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      // fork: extend the upstream description with the per-call model route
      // and the mode-specific background defaults.
      description: wording.description
        + ' The child runs on a model route you choose per call: pass `provider` and/or `model` ids matching the '
        + 'deployment\'s configured model routes; omit both to inherit the parent route. Unknown ids fail fast with '
        + 'the available directory listed in the error.'
        + (backgroundEnabled
          // The completion notice is the continuation service's own behavior, not
          // a separately installed capability, so this promise holds whenever the
          // continuable background path is reachable at all.
          ? continuable
            ? ' Fresh-context children (fresh_context: true) run in the background by default: the call '
              + 'immediately returns a durable subagent id and keeps the child conversation available for later '
              + 'turns; when that run settles, the runtime sends the parent a notice containing its outcome and '
              + 'any final assistant message, and `send_message` starts a later turn in the same child '
              + 'conversation. Inherited-context children default to waiting for the result; pass '
              + '`run_in_background: true` to keep one as a durable forked child conversation instead (its view '
              + 'of this conversation freezes at creation — start a new call for the newest state).'
            : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
          : ' This call waits for the subagent and returns its result.'),
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: wording.promptDescription,
        },
        // fork: per-call context mode. Omitted follows defaultContext
        // (inherit by default); an explicit value wins either way.
        fresh_context: {
          type: 'boolean' as const,
          description: defaultInherit
            ? 'Whether the child starts with an empty context. Omit for the default: the child is forked from '
              + 'this conversation — seeded with its completed turns as of this call. Pass true for a '
              + 'clean-context child whose prompt must be fully self-contained; pass false to force the fork '
              + 'explicitly.'
            : 'Whether the child starts with an empty context. Omit for the default: no conversation context, '
              + 'standalone prompt required. Pass false to fork the child from this conversation\'s completed '
              + 'turns as of the call.',
        },
        // fork: per-call model route selection, shadowing config.agentOptions.
        provider: {
          type: 'string',
          description: 'Optional provider route id for this child (must match a configured model route). Omit to inherit the parent provider — then `model` must name a model of THAT inherited route.',
        },
        model: {
          type: 'string',
          description: 'Optional model id interpreted by the EFFECTIVE provider route — the explicit `provider` argument, else the inherited parent route; cross-route ids are not auto-routed, so pass `provider` too whenever the model belongs to another route. Omit to inherit the parent model.',
        },
        max_tokens: {
          type: 'number',
          description: 'Optional positive-integer output token cap for each of the child\'s model requests.',
        },
        ...backgroundEnabled ? {
          run_in_background: {
            type: 'boolean' as const,
            description: continuable
              ? 'Whether to run in the background. Fresh-context children (fresh_context: true) default to '
                + 'true and return a durable subagent id immediately. Inherited-context children default to '
                + 'false — the call waits and returns the result; set true to start a durable forked child '
                + 'conversation (send_message continues it; its inherited view freezes at creation).'
              : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
          },
        } : {},
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'continuable' },
                subagentId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                runId: { type: 'string', required: true },
                output: { type: 'array', required: true, items: { type: 'json' } },
              },
            },
          ],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background subagent job ${value.jobId}`
            : value.kind === 'continuable'
              ? `started subagent ${value.subagentId}`
              : outputValueText(value.output),
        }],
      },
      // Children never mutate the parent session; the one parent-owned write
      // (tasks.start) is a synchronous commutative insertion.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) {
          // Non-agent callers provide no parent for delegation ownership.
          throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
        }

        // fork: per-call route selection over the configured defaults, then
        // advisory validation before any child session is created.
        const callOptions: AgentOptions = {
          ...config.agentOptions,
          ...args.provider !== undefined ? { provider: args.provider } : {},
          ...args.model !== undefined ? { model: args.model } : {},
          ...args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {},
        }
        if (config.validateModel !== false && (args.provider !== undefined || args.model !== undefined)) {
          const llm = ctx.get('llm')
          if (llm !== undefined) {
            await assertCallRouteResolvable(llm, parent, {
              ...args.provider !== undefined ? { provider: args.provider } : {},
              ...args.model !== undefined ? { model: args.model } : {},
            }, exec.signal)
          }
        }

        const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined

        // fork: per-call context mode — an explicit fresh_context argument
        // wins either way; an omitted one follows defaultContext (inherit).
        const inherit = args.fresh_context !== undefined
          ? !args.fresh_context
          : defaultInherit

        // fork: inherited-context delegations resolve the inheriting provider
        // NOW, from the live registry. The provider recomputes the
        // completed-turn seed inside start(), from the parent's live session
        // log — so the child inherits the conversation's LATEST completed
        // turns, as of this call, never a snapshot from session open.
        let providerName = config.provider
        if (inherit) {
          providerName = inheritName
          const inheritProvider = ctx.subagents.getProvider(inheritName)
          if (inheritProvider === undefined) {
            const registered = ctx.subagents.list()
            throw new Error(
              `inherit-context provider "${inheritName}" is not registered — available providers: `
              + `${registered.length > 0 ? registered.join(', ') : '(none)'}. `
              + 'Fix the tool config\'s inheritProvider or load its backend plugin.',
            )
          }
          if (!inheritProvider.inheritsParentContext) {
            throw new Error(
              `inherit-context provider "${inheritName}" does not seed children with the parent `
              + 'conversation (inheritsParentContext is false) — use a forking provider such as "fork" '
              + 'for inherited-context calls',
            )
          }
        }

        const request = {
          label: args.description,
          prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
          parent,
          // fork: merged per-call route instead of the static config alone.
          ...Object.keys(callOptions).length > 0 ? { agentOptions: callOptions } : {},
          ...config.persona !== undefined ? { persona: config.persona } : {},
          ...config.toolFilter !== undefined ? { toolFilter: config.toolFilter } : {},
          ...maxDepth !== undefined ? { maxDepth } : {},
        }

        // fork: the continuable route follows backgroundMode for BOTH modes.
        // Fresh children keep the upstream independently-scheduled default;
        // inherited-context children stay foreground-by-default (ADR-0003:
        // latest-state-per-call is that mode's point) and reach a durable
        // forked child only through an explicit run_in_background: true — a
        // long-lived branch whose inherited view freezes at creation, matching
        // the built-in continuable subagent_fork (ADR-0004).
        const runSpec = resolveDelegationRun(args, {
          backgroundEnabled,
          defaultBackground: continuable && !inherit,
        })
        if (runSpec.runInBackground) {
          if (continuable) {
            // Resolves at inbox acceptance: the child owns its own turns from
            // there, so this call neither waits for nor collects a result.
            const started = await ctx.subagents.startContinuable({
              provider: providerName,
              label: args.description,
              request,
              signal: exec.signal,
            })
            return { kind: 'continuable' as const, subagentId: started.childId }
          }
          const jobs = ctx.get('jobs')
          if (jobs === undefined) {
            throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
          }
          // One-shot background child: job preflight finishes before the
          // starter can spawn, and the task-owned signal covers startup.
          const id = jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              const start = ctx.subagents.start(providerName, { ...request, signal: controller.signal })
              return {
                cancel: (reason?: string) => {
                  controller.abort(reason ?? 'background subagent task killed')
                },
                done: settleStart(start, controller.signal),
                // No readOutput: the child session owns intermediate detail.
              }
            },
          })
          return { kind: 'background' as const, jobId: id }
        }

        const run: SubagentRun = await ctx.subagents.start(providerName, {
          ...request,
          signal: exec.signal,
        })
        return settleForegroundRun(run)
      },
    }))
  }

  // Register listeners before checking presence so no synchronous change is missed.
  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== config.provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(config.provider)
  if (present !== undefined) {
    mount(present)
  } else {
    // A backend fiber may activate later; a misspelled provider remains visible in this log.
    ctx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent_model'}" tool will register when it appears`)
  }
  if (backgroundEnabled && continuable) {
    // The section follows provider availability without its own manual
    // lifecycle: empty text is omitted from rendered prompts while the tool is
    // absent, and the registration itself stays owned by this plugin fiber.
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: context => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined
        ? ''
        : `Use ${toolName} for delegation, choosing the child's model route per call and whether it inherits `
          + 'context. By default the child forks this conversation — seeded with its completed turns as of the '
          + 'call — and the call waits for the result; restate anything from the current in-flight turn the '
          + 'child must know, because the seed stops at the last completed turn. Pass `run_in_background: true` '
          + 'on an inherited-context child to keep it as a durable forked conversation you continue through '
          + 'send_message (its inherited view freezes at creation; start a new call for the newest state). '
          + 'Pass `fresh_context: true` for a clean-context child on self-contained work: it runs in the '
          + 'background by default as a durable continuable subagent, so start independent delegations together '
          + 'in one assistant message and continue useful work while they run. When a background run settles, '
          + 'the runtime sends you a notice containing its outcome and any final assistant message. Set '
          + '`run_in_background: false` only when your next action depends on that subagent\'s result.',
    })
  }
}
