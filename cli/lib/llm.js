// Sogni's own LLMs, for `node world agent`: one place that asks a question,
// gets an answer in a fixed shape, and writes down what it asked and what it
// cost. Everything runs on the person's Sogni API key; nothing leaves Sogni.
//
// The harness never hands the model the whole job. Each call asks for one
// bounded thing (describe this still, write this place's films, point at this
// object) in a JSON shape that is checked before anything uses it.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';

/** The writer and judge, and the pointer (Qwen places points on a picture far more accurately). */
export const MODELS = Object.freeze({
  writer: process.env.SOGNI_AGENT_MODEL || 'deepseek-v4-flash-vision-exp-dspark-1m',
  pointer: process.env.SOGNI_AGENT_POINTER_MODEL || 'qwen3.6-35b-a3b-gguf-iq4xs',
});

/** USD per million tokens (in, out), for the running total the agent prints. */
const PRICES = {
  'deepseek-v4-flash-vision-exp-dspark-1m': [0.35, 2.75],
  'qwen3.6-35b-a3b-gguf-iq4xs': [0.3, 0.9],
};

/** The SDK refuses inline images larger than this on the long side. */
export const IMAGE_LONG_EDGE = 1024;
/** DeepSeek keeps only the most recent eight images of a request. */
export const MAX_IMAGES = 8;

/** A picture for the model: resized to fit, as a JPEG data URI. */
export async function imagePart(input, { longEdge = IMAGE_LONG_EDGE, region } = {}) {
  let image = sharp(input, { failOn: 'none' }).rotate();
  if (region) {
    const meta = await sharp(input).metadata();
    const left = Math.round(region[0] * meta.width);
    const top = Math.round(region[1] * meta.height);
    image = image.extract({ left, top, width: Math.round(region[2] * meta.width) - left, height: Math.round(region[3] * meta.height) - top });
  }
  const bytes = await image.resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } };
}

/**
 * A still the way a person studies it: the whole picture, then its four
 * quarters (with a little overlap), each close to full resolution. The model
 * only takes 1024 px images, so this is how it "looks at full size".
 */
export async function studyParts(stillPath, { quarters = true } = {}) {
  const parts = [{ type: 'text', text: 'The whole picture:' }, await imagePart(stillPath)];
  if (!quarters) return parts;
  const regions = [
    ['top-left quarter', [0, 0, 0.55, 0.55]],
    ['top-right quarter', [0.45, 0, 1, 0.55]],
    ['bottom-left quarter', [0, 0.45, 0.55, 1]],
    ['bottom-right quarter', [0.45, 0.45, 1, 1]],
  ];
  for (const [name, region] of regions) {
    parts.push({ type: 'text', text: `Close-up, the ${name}:` }, await imagePart(stillPath, { region }));
  }
  return parts;
}

/**
 * The shape sent to the server as a grammar: types, required keys, enums and
 * list sizes only. Text lengths are checked here instead, because a grammar
 * that enforces a maximum cuts a sentence off mid-word.
 */
export function grammarOf(schema) {
  if (Array.isArray(schema)) return schema.map(grammarOf);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (['minLength', 'maxLength', 'minimum', 'maximum'].includes(key)) continue;
    out[key] = typeof value === 'object' ? grammarOf(value) : value;
  }
  return out;
}

/** At most `limit` calls at once: an account runs two to four LLM jobs at a time. */
function limiter(limit) {
  let active = 0;
  const waiting = [];
  return async fn => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const stripThinking = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();

/** The first complete JSON object or array in a reply (models wrap it in prose or fences). */
export function extractJson(text) {
  const clean = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(clean); } catch { /* look for one inside */ }
  for (let start = 0; start < clean.length; start++) {
    const open = clean[start];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try { return JSON.parse(clean.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error('the reply has no JSON in it');
}

/**
 * Check a value against the small part of JSON Schema the agent's shapes use.
 * Returns a list of problems in words the model can act on.
 */
export function checkShape(value, schema, at = 'answer') {
  const problems = [];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const want = schema.type;
  if (want === 'integer' ? !Number.isInteger(value) : want && want !== type && !(want === 'number' && type === 'number')) {
    problems.push(`${at} must be ${want === 'array' ? 'a list' : `a ${want}`}`);
    return problems;
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`);
  if (type === 'string') {
    if (schema.minLength && value.trim().length < schema.minLength) problems.push(`${at} is too short (at least ${schema.minLength} characters)`);
    if (schema.maxLength && value.length > schema.maxLength) problems.push(`${at} is too long (at most ${schema.maxLength} characters)`);
  }
  if (type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} must be at most ${schema.maximum}`);
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => problems.push(...checkShape(item, schema.items, `${at}[${i}]`)));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (value[key] === undefined || value[key] === null) problems.push(`${at}.${key} is missing`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined && value[key] !== null) problems.push(...checkShape(value[key], sub, `${at}.${key}`));
    }
  }
  return problems;
}

/**
 * A conversation with Sogni's LLMs. `ask` sends one request and returns text
 * (or, with `schema`, a checked object). `check` adds the caller's own rules:
 * it returns problems in words, and the model is told them and asked again.
 */
export class Llm {
  constructor({ client, billing, logFile = null, concurrency = 2, onUsage = null }) {
    // Evaluation only: SOGNI_AGENT_WRITER_URL points the writer at a candidate model on an
    // OpenAI-compatible server before it joins Sogni's network. The pointer stays on Sogni.
    this.external = process.env.SOGNI_AGENT_WRITER_URL
      ? { url: process.env.SOGNI_AGENT_WRITER_URL, key: process.env.SOGNI_AGENT_WRITER_KEY ?? '', model: process.env.SOGNI_AGENT_WRITER_MODEL ?? 'default' }
      : null;
    this.client = client;
    this.billing = billing;
    this.logFile = logFile;
    this.limit = limiter(concurrency);
    this.onUsage = onUsage;
    this.totals = { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, seconds: 0 };
  }

  async complete({ model, messages, maxTokens = 8192, temperature, think = false, schema = null, purpose = 'ask' }) {
    return this.limit(async () => {
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt++) {
        const started = Date.now();
        try {
          if (this.external && model === MODELS.writer) return await this.#completeExternal({ model, messages, maxTokens, temperature, think, schema, purpose, started, attempt });
          const stream = await this.client.chat.completions.create({
            model,
            messages,
            max_tokens: maxTokens,
            ...(temperature !== undefined ? { temperature } : {}),
            stream: true,
            think,
            tokenType: this.billing.tokenType,
            billingMode: this.billing.mode,
            appSource: 'sogni-worlds-kit-agent',
            ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: purpose.replace(/[^a-z0-9_]/gi, '_').slice(0, 60) || 'answer', schema: grammarOf(schema), strict: true } } } : {}),
          });
          let text = '';
          for await (const chunk of stream) if (chunk.content) text += chunk.content;
          const result = stream.finalResult;
          const content = stripThinking(result?.content ?? text);
          const usage = result?.usage ?? {};
          const seconds = (Date.now() - started) / 1000;
          this.#account(model, usage, seconds);
          this.#log({ purpose, model, attempt, seconds, usage, finish: result?.finishReason, messages, content });
          if (!content || result?.finishReason === 'length') {
            // Running out of room is not a dropped connection: the same request would run out again.
            const error = new Error(`the reply ran past ${maxTokens} tokens${think ? ' while thinking' : ''}`);
            error.length = true;
            throw error;
          }
          return { content, finish: result?.finishReason, usage, seconds };
        } catch (error) {
          lastError = error;
          this.#log({ purpose, model, attempt, seconds: (Date.now() - started) / 1000, error: String(error?.message ?? error).slice(0, 300) });
          // A refusal for money or plan is final, and so is running out of room; a dropped or queued-out job is worth another try.
          if (error?.length || [4087, 4088, 4089].includes(error?.code) || /insufficient|balance|subscription/i.test(error?.message ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
      throw new Error(`Sogni's LLM did not answer (${purpose}): ${lastError?.message ?? lastError}`);
    });
  }

  /**
   * Ask for an object of a given shape. The answer is parsed, checked against
   * `schema`, then against `check(value)`; problems go back to the model,
   * which answers again, up to `rounds` times.
   */
  async json({ model = MODELS.writer, system, user, schema, check = null, rounds = 3, purpose, think = false, temperature, maxTokens }) {
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ];
    let problems = [];
    let best = null;
    let budget = maxTokens ?? 8192;
    let thinking = think;
    for (let round = 1; round <= rounds; round++) {
      let reply;
      try {
        reply = await this.complete({ model, messages, schema, purpose, think: thinking, temperature, maxTokens: budget });
      } catch (error) {
        if (!error.length || round === rounds) throw error;
        // Out of room: answer again with twice the room and without thinking aloud.
        budget = Math.min(budget * 2, 32768);
        thinking = false;
        continue;
      }
      let value;
      try {
        value = extractJson(reply.content);
        problems = checkShape(value, schema);
        if (!problems.length && check) {
          problems = await check(value);
          best = value;
        }
      } catch (error) {
        problems = [`Your reply could not be read as JSON (${error.message}). Reply with only the JSON object.`];
      }
      if (!problems.length) return value;
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({ role: 'user', content: `That answer has ${problems.length} problem${problems.length === 1 ? '' : 's'}. Fix every one and reply with the whole corrected JSON object, nothing else:\n${problems.map(p => `- ${p}`).join('\n')}` });
    }
    // Problems marked "(warning)" are worth a retry but never worth stopping for:
    // the linter lets warnings through too. Return the last well-formed answer.
    if (best && problems.length && problems.every(p => p.startsWith('(warning)'))) {
      this.#log({ purpose, accepted: 'with warnings', problems });
      return best;
    }
    const error = new Error(`${purpose}: still ${problems.length} problem${problems.length === 1 ? '' : 's'} after ${rounds} tries: ${problems.slice(0, 5).join('; ')}`);
    error.problems = problems;
    throw error;
  }

  async #completeExternal({ messages, maxTokens, temperature, think, schema, purpose, started, attempt }) {
    const { url, key, model } = this.external;
    const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages, max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}), stream: false,
        chat_template_kwargs: { enable_thinking: Boolean(think) },
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: purpose.replace(/[^a-z0-9_]/gi, '_').slice(0, 60) || 'answer', schema: grammarOf(schema), strict: true } } } : {}),
      }),
      signal: AbortSignal.timeout(1_800_000),
    });
    if (!response.ok) throw new Error(`${model}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    const json = await response.json();
    const choice = json.choices?.[0];
    const content = stripThinking(choice?.message?.content ?? '');
    const usage = json.usage ?? {};
    const seconds = (Date.now() - started) / 1000;
    this.#account(model, usage, seconds);
    this.#log({ purpose, model, attempt, seconds, usage, finish: choice?.finish_reason, messages, content });
    if (!content || choice?.finish_reason === 'length') {
      const error = new Error(`the reply ran past ${maxTokens} tokens`);
      error.length = true;
      throw error;
    }
    return { content, finish: choice?.finish_reason, usage, seconds };
  }

  #account(model, usage, seconds) {
    const [inPrice, outPrice] = PRICES[model] ?? [0.35, 2.75];
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    this.totals.calls += 1;
    this.totals.promptTokens += promptTokens;
    this.totals.completionTokens += completionTokens;
    this.totals.usd += (promptTokens * inPrice + completionTokens * outPrice) / 1e6;
    this.totals.seconds += seconds;
    this.onUsage?.(this.totals);
  }

  #log(entry) {
    if (!this.logFile) return;
    // Images are logged by size, never by content.
    const messages = entry.messages?.map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(p => (p.type === 'image_url' ? `[image ${Math.round(p.image_url.url.length * 0.75 / 1024)} KB]` : p.text)).join('\n')
        : m.content,
    }));
    mkdirSync(dirname(this.logFile), { recursive: true });
    appendFileSync(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry, messages })}\n`);
  }
}
