import OpenAI from 'openai';
import { toApiSchema } from './claude.js';
import {
  AbortedError,
  InvalidKeyError,
  MalformedToolInputError,
  ProviderDownError,
  ProviderError,
  RateLimitedError,
  RefusedError,
} from './provider.js';

/** @typedef {import('./provider.js').Message} Message */
/** @typedef {import('./provider.js').ToolSpec} ToolSpec */
/** @typedef {import('./provider.js').Turn} Turn */

// Defaults as of 2026-10; providers rename models often, so check their live
// model lists and override with OPENAI_MODEL / GEMINI_MODEL.
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/** @type {Record<string, Turn['stopReason']>} */
const STOP_REASONS = { stop: 'end', tool_calls: 'tool_calls', length: 'max_tokens', content_filter: 'refused' };

/**
 * Adapter for the OpenAI Chat Completions API (design doc §9.8). The same
 * class serves Gemini through Google's OpenAI-compatible endpoint: only the
 * base URL, key and model differ.
 *
 * @implements {import('./provider.js').LLMProvider}
 */
export class OpenAICompatibleProvider {
  /**
   * @param {{ name: string, apiKey?: string, baseURL?: string, model: string,
   *           sendEffort?: boolean, client?: OpenAI }} options
   *   sendEffort: pass `effort` as `reasoning_effort` (reasoning models only)
   */
  constructor({ name, apiKey, baseURL, model, sendEffort = true, client }) {
    this.name = name;
    this.model = model;
    this.sendEffort = sendEffort;
    this.client = client ?? new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  }

  /**
   * @param {{ system: string, messages: Message[], tools: ToolSpec[],
   *           effort?: import('./provider.js').Effort, signal?: AbortSignal }} args
   * @returns {AsyncGenerator<{ type: 'text', delta: string }, Turn>}
   */
  async *streamTurn({ system, messages, tools, effort = 'medium', signal }) {
    let text = '';
    /** @type {Map<number, { id: string, name: string, args: string }>} tool calls arrive in pieces, keyed by index */
    const calls = new Map();
    let finish = 'stop';
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(system, messages),
          ...(tools.length > 0 && { tools: tools.map(toOpenAITool) }),
          ...(this.sendEffort && { reasoning_effort: effort }),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      );
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.delta?.content) {
          text += choice.delta.content;
          yield { type: 'text', delta: choice.delta.content };
        }
        for (const part of choice?.delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(part.index, call);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) usage = fromOpenAIUsage(chunk.usage);
      }
    } catch (err) {
      throw toProviderError(err);
    }

    /** @type {import('./provider.js').Block[]} */
    const content = text ? [{ type: 'text', text }] : [];
    for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c)) {
      let input;
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        // Unparseable arguments: the agent re-issues the turn (bounded).
        throw new MalformedToolInputError(`Tool "${call.name}" arguments were not valid JSON`);
      }
      content.push({ type: 'tool_call', id: call.id, name: call.name, input });
    }
    return { content, stopReason: STOP_REASONS[finish] ?? 'end', usage };
  }

  /**
   * Structured output via `response_format: json_schema` (strict).
   * @param {{ system: string, messages: Message[], schema: object,
   *           effort?: import('./provider.js').Effort, signal?: AbortSignal }} args
   */
  async generateJson({ system, messages, schema, effort = 'medium', signal }) {
    let completion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(system, messages),
          ...(this.sendEffort && { reasoning_effort: effort }),
          response_format: { type: 'json_schema', json_schema: { name: 'result', schema: toApiSchema(schema), strict: true } },
        },
        { signal },
      );
    } catch (err) {
      throw toProviderError(err);
    }
    const choice = completion.choices[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      throw new RefusedError('The model declined this request.');
    }
    if (choice?.finish_reason === 'length') throw new ProviderError('The JSON answer was cut off (max tokens).');
    const text = choice?.message?.content ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError('The model returned invalid JSON.');
    }
    return { data, text, usage: fromOpenAIUsage(completion.usage) };
  }

  /** Listing models costs no tokens. */
  async validateKey() {
    try {
      await this.client.models.list();
    } catch (err) {
      throw toProviderError(err);
    }
  }
}

/** @param {ToolSpec} tool */
export function toOpenAITool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

/**
 * Neutral history → Chat Completions messages. Tool results become one
 * `role: "tool"` message each, right after the assistant message that asked.
 * @param {string} system
 * @param {Message[]} messages
 */
export function toOpenAIMessages(system, messages) {
  /** @type {any[]} */
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
    if (message.role === 'assistant') {
      const toolCalls = message.content.flatMap((b) =>
        b.type === 'tool_call'
          ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      );
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.id, content: block.isError ? `Error: ${block.output}` : block.output });
      }
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** @returns {import('./provider.js').Usage} */
function fromOpenAIUsage(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
    output: usage?.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  };
}

/** Map OpenAI SDK errors (most specific first) to provider-neutral ones. */
export function toProviderError(err) {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new AbortedError('Request cancelled', { cause: err });
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new InvalidKeyError('Your API key is invalid or revoked.', { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new RateLimitedError('Your API key hit its rate limit (or is out of quota). Try again later.', { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.InternalServerError) {
    return new ProviderDownError('Could not reach the AI provider, or it is overloaded. Try again shortly.', { cause: err });
  }
  if (err instanceof OpenAI.APIError) return new ProviderError(`AI provider error ${err.status ?? ''}: ${err.message}`, { cause: err });
  if (err instanceof OpenAI.OpenAIError) return new ProviderError(err.message, { cause: err });
  return err;
}
