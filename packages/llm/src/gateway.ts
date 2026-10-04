/**
 * LlmGateway: the only door between the game and a language model.
 *
 *  - Every call returns schema-validated structured data or null (never raw text into the engine).
 *  - Roles map to model + effort settings (configurable via env).
 *  - Stable instructions go first and are prompt-cached; volatile context goes last.
 *  - A per-turn budget governor degrades gracefully to deterministic fallbacks.
 *  - Every call is recorded (for replay/debugging and the save file's LLM log).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

export type LlmRole = "parser" | "extractor" | "leader" | "narrator" | "deliberator" | "advisor";

export interface LlmCall<T> {
  role: LlmRole;
  /** Stable instructions (cached). */
  system: string;
  /** Large, slowly-changing context (cached as a second block when present). */
  context?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
}

export interface LlmResult<T> {
  data: T | null;
  model?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface LlmRecord {
  role: LlmRole;
  model: string;
  at: string;
  input: string;
  output: unknown;
  error?: string;
  usage?: { input?: number; output?: number; cacheRead?: number };
}

export interface LlmGateway {
  readonly available: boolean;
  readonly describe: string;
  call<T>(req: LlmCall<T>): Promise<LlmResult<T>>;
  /** Reset the per-turn budget. */
  newTurn(): void;
  onRecord?: (r: LlmRecord) => void;
}

const DEFAULT_MODEL = "claude-opus-5-5";
const ROLE_EFFORT: Record<LlmRole, "low" | "medium" | "high"> = {
  parser: "medium",
  extractor: "low",
  leader: "medium",
  narrator: "low",
  deliberator: "medium",
  advisor: "low",
};

export interface GatewayOptions {
  apiKey?: string;
  /** Max output+input tokens per turn before falling back to deterministic behaviour. */
  turnTokenBudget?: number;
  onRecord?: (r: LlmRecord) => void;
}

function modelFor(role: LlmRole): string {
  return process.env[`GS_LLM_MODEL_${role.toUpperCase()}`] ?? process.env.GS_LLM_MODEL ?? DEFAULT_MODEL;
}

export class AnthropicGateway implements LlmGateway {
  readonly available = true;
  private client: Anthropic;
  private used = 0;
  private budget: number;
  onRecord?: (r: LlmRecord) => void;

  constructor(opts: GatewayOptions = {}) {
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.budget = opts.turnTokenBudget ?? Number(process.env.GS_LLM_TURN_BUDGET ?? 400_000);
    this.onRecord = opts.onRecord;
  }

  get describe() {
    return `Anthropic (${modelFor("leader")})`;
  }

  newTurn() {
    this.used = 0;
  }

  async call<T>(req: LlmCall<T>): Promise<LlmResult<T>> {
    if (this.used > this.budget) return { data: null, error: "turn LLM budget exhausted" };
    const model = modelFor(req.role);
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    if (req.context) system.push({ type: "text", text: req.context, cache_control: { type: "ephemeral" } });
    const inputForLog = JSON.stringify({ system: req.system.slice(0, 200), context: req.context?.slice(0, 2000), messages: req.messages });
    try {
      const res = await this.client.beta.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages: req.messages,
        output_config: { effort: ROLE_EFFORT[req.role], format: betaZodOutputFormat(req.schema) },
      });
      const usage = res.usage;
      this.used += (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
      if (res.stop_reason === "refusal") {
        this.record(req.role, model, inputForLog, null, "refusal", usage);
        return { data: null, model, error: "refusal" };
      }
      if (res.stop_reason === "max_tokens") {
        this.record(req.role, model, inputForLog, null, "max_tokens", usage);
        return { data: null, model, error: "max_tokens" };
      }
      const parsed = res.parsed_output as T | null;
      // Defensive re-validation (the engine never trusts unvalidated model output).
      const check = parsed == null ? null : req.schema.safeParse(parsed);
      const data = check?.success ? check.data : null;
      this.record(req.role, model, inputForLog, data, check && !check.success ? "schema validation failed" : undefined, usage);
      return { data, model, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, cacheReadTokens: usage?.cache_read_input_tokens ?? undefined, error: data ? undefined : "invalid output" };
    } catch (err) {
      const msg = describeError(err);
      this.record(req.role, model, inputForLog, null, msg);
      return { data: null, model, error: msg };
    }
  }

  private record(role: LlmRole, model: string, input: string, output: unknown, error?: string, usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null }) {
    this.onRecord?.({ role, model, at: new Date().toISOString(), input, output, error, usage: usage ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? undefined } : undefined });
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "authentication failed (check API key)";
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "connection error";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Offline gateway: every call returns null so agents use deterministic fallbacks. */
export class OfflineGateway implements LlmGateway {
  readonly available = false;
  readonly describe = "offline (deterministic fallbacks)";
  onRecord?: (r: LlmRecord) => void;
  newTurn() {}
  async call<T>(): Promise<LlmResult<T>> {
    return { data: null, error: "offline" };
  }
}

/** Scripted gateway for tests: returns queued outputs per role. */
export class ScriptedGateway implements LlmGateway {
  readonly available = true;
  readonly describe = "scripted (tests)";
  private queues = new Map<LlmRole, unknown[]>();
  calls: { role: LlmRole; messages: LlmCall<unknown>["messages"]; context?: string }[] = [];
  onRecord?: (r: LlmRecord) => void;
  push(role: LlmRole, output: unknown) {
    const q = this.queues.get(role) ?? [];
    q.push(output);
    this.queues.set(role, q);
  }
  newTurn() {}
  async call<T>(req: LlmCall<T>): Promise<LlmResult<T>> {
    this.calls.push({ role: req.role, messages: req.messages, context: req.context });
    const out = this.queues.get(req.role)?.shift();
    if (out === undefined) return { data: null, error: "no scripted output" };
    const check = req.schema.safeParse(out);
    return check.success ? { data: check.data, model: "scripted" } : { data: null, error: "schema validation failed" };
  }
}

export function createGateway(opts: GatewayOptions = {}): LlmGateway {
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key || process.env.GS_LLM === "off") return new OfflineGateway();
  return new AnthropicGateway({ ...opts, apiKey: key });
}
