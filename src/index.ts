/**
 * Model-selectable delegation: a fork of `@deepseek-ai/dsh-tool-subagent`
 * (v0.1.0-rc line) that exposes the child's model route as PER-CALL tool
 * arguments. Everything else — provider lifecycle, background policy,
 * continuable children, settlement — is upstream behavior kept verbatim.
 * Changes are marked with `// fork:` comments.
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
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
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
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
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
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
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
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
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
    const wording = providerWording(provider.inheritsParentContext)
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${provider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
    disposeTool = ctx.tools.register(defineTool({
      name: toolName,
      // fork: extend the upstream description with the per-call model route.
      description: wording.description
        + ' The child runs on a model route you choose per call: pass `provider` and/or `model` ids matching the '
        + 'deployment\'s configured model routes; omit both to inherit the parent route. Unknown ids fail fast with '
        + 'the available directory listed in the error.'
        + (backgroundEnabled
          // The completion notice is the continuation service's own behavior, not
          // a separately installed capability, so this promise holds whenever the
          // continuable background path is reachable at all.
          ? continuable
            ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
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
              ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
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

        const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
        if (runSpec.runInBackground) {
          if (continuable) {
            // Resolves at inbox acceptance: the child owns its own turns from
            // there, so this call neither waits for nor collects a result.
            const started = await ctx.subagents.startContinuable({
              provider: config.provider,
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
              const start = ctx.subagents.start(config.provider, { ...request, signal: controller.signal })
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

        const run: SubagentRun = await ctx.subagents.start(config.provider, {
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
        : `Use ${toolName} in the background by default, choosing the child's model route per call. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
    })
  }
}
