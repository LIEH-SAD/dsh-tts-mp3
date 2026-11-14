/**
 * dsh-tts-mp3 — read text aloud with the DeepSeek speech API and export MP3.
 *
 * Registers one model-facing tool, `tts_to_mp3`, on `ctx.tools`. The plugin
 * imports no Harness package and no native binary: the request goes to
 * `https://api.deepseek.com/v1/tools/tts`, and MP3 encoding runs in-process
 * through a pure-JavaScript LAME port.
 *
 * @module dsh-tts-mp3
 */

import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, dirname, join, resolve } from 'node:path'

import { normalizeSource, splitForRequests } from './lib/text.js'
import { synthesizeToMp3, VOICES } from './lib/tts.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tts-mp3'

/** The tool registry is the only Harness service this plugin needs. */
export const inject = ['tools']

/** Fallback values for every configurable field. */
const DEFAULTS = {
  voice: 'tide',
  bitrateKbps: 128,
  normalize: true,
  maxBilledCharsPerRequest: 8000,
  timeoutMs: 300_000,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
}

/** MP3 bitrates LAME accepts at the 24 kHz sample rate the API returns. */
const MPEG2_BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/**
 * Bundle config schema. The Host validates the row's `config` before `apply`
 * and treats a rejection as an activation failure, so it only checks shape
 * here; {@link resolveConfig} validates the values.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-tts-mp3',
    validate(config) {
      if (config === undefined || config === null) return { value: {} }
      if (typeof config !== 'object' || Array.isArray(config)) {
        return { issues: [{ message: 'plugin config must be an object' }] }
      }
      return { value: config }
    },
  },
}

/**
 * Merge the row's config over the defaults and reject unusable values.
 *
 * @param config - the row's `config` mapping, already shape-checked.
 * @returns the complete configuration.
 */
function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) }
  if (!VOICES.includes(merged.voice)) {
    throw new Error(`dsh-tts-mp3: voice must be one of ${VOICES.join(', ')}`)
  }
  if (!MPEG2_BITRATES.includes(merged.bitrateKbps)) {
    throw new Error(`dsh-tts-mp3: bitrateKbps must be one of ${MPEG2_BITRATES.join(', ')}`)
  }
  if (typeof merged.normalize !== 'boolean') {
    throw new Error('dsh-tts-mp3: normalize must be a boolean')
  }
  if (!Number.isInteger(merged.maxBilledCharsPerRequest) || merged.maxBilledCharsPerRequest < 500 || merged.maxBilledCharsPerRequest > 10_000) {
    throw new Error('dsh-tts-mp3: maxBilledCharsPerRequest must be an integer between 500 and 10000')
  }
  if (typeof merged.apiKeyEnv !== 'string' || merged.apiKeyEnv.length === 0) {
    throw new Error('dsh-tts-mp3: apiKeyEnv must name an environment variable')
  }
  return merged
}

/** Model-facing parameter schema: plain JSON Schema, no Harness DSL. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description: 'Text to read aloud. Markdown formatting is dropped before synthesis.',
    },
    file: {
      type: 'string',
      description: 'Path to a UTF-8 text or Markdown file to read aloud. Use instead of `text`.',
    },
    voice: {
      type: 'string',
      enum: VOICES,
      description: "'tide' is the male voice and the default; 'stella' is female.",
    },
    output: {
      type: 'string',
      description: 'MP3 path to write. Relative paths resolve against the Harness process working directory.',
    },
    bitrateKbps: {
      type: 'integer',
      description: 'MP3 bitrate in kbps. Defaults to the plugin config (128).',
    },
    normalize: {
      type: 'boolean',
      description: 'Peak-normalize the audio to about -1 dBFS. Defaults to true.',
    },
  },
}

/** Declared shape of the tool's canonical value. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string' },
    bytes: { type: 'integer' },
    durationSeconds: { type: 'number' },
    characters: { type: 'integer' },
    billedCharacters: { type: 'integer' },
    chunks: { type: 'integer' },
    voice: { type: 'string' },
    bitrateKbps: { type: 'integer' },
  },
  required: ['file', 'bytes', 'durationSeconds', 'characters', 'billedCharacters', 'chunks', 'voice', 'bitrateKbps'],
}

/** Render the canonical value as the model-facing result text. */
function renderValue(_args, value) {
  const seconds = value.durationSeconds.toFixed(1)
  const kilobytes = Math.round(value.bytes / 1024)
  return [{
    type: 'text',
    text: `Saved ${seconds}s of ${value.voice} speech to ${value.file} `
      + `(${kilobytes} KB, ${value.bitrateKbps} kbps, ${value.characters} characters in ${value.chunks} request(s)).`,
  }]
}

/** Resolve a requested output path, defaulting to a timestamped file in the process directory. */
function resolveOutput(requested) {
  if (typeof requested === 'string' && requested.length > 0) {
    return isAbsolute(requested) ? requested : resolve(process.cwd(), requested)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(process.cwd(), `tts-${stamp}.mp3`)
}

/** Read a UTF-8 text file, with a message that names the path on failure. */
async function readSourceFile(path) {
  const target = isAbsolute(path) ? path : resolve(process.cwd(), path)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new Error(`file not found: ${target}`)
  }
  if (!info.isFile()) throw new Error(`not a regular file: ${target}`)
  return readFile(target, 'utf8')
}

/**
 * Register the `tts_to_mp3` tool.
 *
 * @param ctx - context whose `tools` registry receives the tool.
 * @param config - the row's optional `config` mapping.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  ctx.tools.register({
    name: 'tts_to_mp3',
    description: 'Read text or a text/Markdown file aloud with DeepSeek text-to-speech and save it as an MP3. '
      + "Uses the male 'tide' voice by default; 'stella' is female. Long input is split into several requests and joined into one file.",
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderValue },
    timeoutMs: settings.timeoutMs,
    // Synthesis only reads the network and writes one output file.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (text.length > 0 && file.length > 0) throw new Error('pass either `text` or `file`, not both')
      if (text.length === 0 && file.length === 0) throw new Error('pass `text` or `file`')

      const source = text.length > 0 ? text : await readSourceFile(file)
      const normalized = normalizeSource(source)
      if (normalized.length === 0) throw new Error('the input contains no readable text')

      const voice = args.voice ?? settings.voice
      if (!VOICES.includes(voice)) throw new Error(`voice must be one of ${VOICES.join(', ')}`)

      const bitrateKbps = args.bitrateKbps ?? settings.bitrateKbps
      if (!MPEG2_BITRATES.includes(bitrateKbps)) {
        throw new Error(`bitrateKbps must be one of ${MPEG2_BITRATES.join(', ')}`)
      }
      const normalize = args.normalize ?? settings.normalize

      const apiKey = process.env[settings.apiKeyEnv]
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error(`missing API key: set the ${settings.apiKeyEnv} environment variable to a DeepSeek platform API key`)
      }

      const output = resolveOutput(args.output)
      const result = await synthesizeToMp3({
        text: normalized,
        voice,
        apiKey: apiKey.trim(),
        bitrateKbps,
        normalize,
        maxBilledCharsPerRequest: settings.maxBilledCharsPerRequest,
        signal: exec?.signal,
      })

      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, result.mp3)

      return {
        file: output,
        bytes: result.mp3.length,
        durationSeconds: result.durationSeconds,
        characters: normalized.length,
        billedCharacters: result.billedCharacters,
        chunks: result.chunks,
        voice,
        bitrateKbps,
      }
    },
  })
}
