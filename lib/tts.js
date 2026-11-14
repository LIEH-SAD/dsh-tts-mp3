/**
 * DeepSeek speech synthesis plus in-process MP3 encoding.
 *
 * Each request returns raw 24 kHz / 16-bit / mono PCM, which is joined across
 * chunks and encoded once with a pure-JavaScript LAME port, so the plugin needs
 * no ffmpeg, native module, or install script.
 *
 * @module dsh-tts-mp3/lib/tts
 */

import { Mp3Encoder } from '@breezystack/lamejs'

import { billedChars, splitForRequests } from './text.js'

/** Endpoint of the DeepSeek speech-synthesis tool API. */
const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts'

/** Sample rate of the PCM the API returns for `format: "pcm"`. */
export const SAMPLE_RATE = 24_000

/** Voices the API serves, male first because it is the default. */
export const VOICES = ['tide', 'stella']

/** Target peak after normalization, about -1 dBFS. */
const TARGET_PEAK = 0.891

/** Samples per MP3 frame at every supported rate; LAME expects whole frames. */
const FRAME = 1152

/** Read a bounded error body without letting a broken stream mask the status. */
async function errorDetail(response) {
  try {
    const text = await response.text()
    return text.replace(/\s+/g, ' ').trim().slice(0, 300)
  } catch {
    return ''
  }
}

/**
 * Synthesize one chunk to raw PCM.
 *
 * @param options - request inputs.
 * @returns the chunk's interleaved 16-bit mono samples.
 */
async function requestPcm({ text, voice, apiKey, signal }) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.ok) {
    const detail = await errorDetail(response)
    const suffix = detail.length > 0 ? `: ${detail}` : ''
    throw new Error(`DeepSeek speech synthesis failed with HTTP ${response.status}${suffix}`)
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error('DeepSeek speech synthesis returned no audio')
  // A truncated 16-bit stream leaves one dangling byte; drop it rather than throw.
  const usable = bytes.byteLength - (bytes.byteLength % 2)
  return new Int16Array(bytes, 0, usable / 2)
}

/** Join chunk sample arrays into one buffer. */
function concatSamples(parts) {
  let total = 0
  for (const part of parts) total += part.length
  const joined = new Int16Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

/** Largest absolute sample value, used for normalization. */
function peakOf(samples) {
  let peak = 0
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index])
    if (value > peak) peak = value
  }
  return peak
}

/**
 * Scale samples so the loudest one lands near -1 dBFS. Only boosts: attenuating
 * would make already-quiet speech quieter, and the API output is consistent.
 *
 * @param samples - 16-bit mono samples, modified in place.
 * @returns the applied linear gain.
 */
export function normalizePeak(samples) {
  const peak = peakOf(samples)
  if (peak === 0) return 1
  const gain = Math.min(TARGET_PEAK / (peak / 32768), 8)
  if (gain <= 1.0001) return 1
  for (let index = 0; index < samples.length; index += 1) {
    const scaled = Math.round(samples[index] * gain)
    samples[index] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled
  }
  return gain
}

/**
 * Encode 16-bit mono samples as MP3.
 *
 * @param samples - interleaved mono samples at {@link SAMPLE_RATE}.
 * @param bitrateKbps - constant bitrate in kbps.
 * @returns the encoded MP3 bytes.
 */
export function encodeMp3(samples, bitrateKbps) {
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, bitrateKbps)
  const parts = []
  for (let offset = 0; offset < samples.length; offset += FRAME) {
    const frame = samples.subarray(offset, Math.min(offset + FRAME, samples.length))
    const encoded = encoder.encodeBuffer(frame)
    if (encoded.length > 0) parts.push(Buffer.from(encoded))
  }
  const tail = encoder.flush()
  if (tail.length > 0) parts.push(Buffer.from(tail))
  return Buffer.concat(parts)
}

/**
 * Synthesize text to an MP3 buffer, one request per chunk.
 *
 * @param options - synthesis inputs; `signal` cancels the whole run.
 * @returns the MP3 bytes with their duration and the billed-character total.
 */
export async function synthesizeToMp3({
  text,
  voice = 'tide',
  apiKey,
  bitrateKbps = 128,
  normalize = true,
  maxBilledCharsPerRequest = 8000,
  signal,
}) {
  if (!VOICES.includes(voice)) throw new Error(`voice must be one of ${VOICES.join(', ')}`)
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('an API key is required')

  const chunks = splitForRequests(text, maxBilledCharsPerRequest)
  const parts = []
  let billed = 0

  for (const chunk of chunks) {
    signal?.throwIfAborted?.()
    const samples = await requestPcm({ text: chunk, voice, apiKey, signal })
    parts.push(samples)
    billed += billedChars(chunk)
  }

  const pcm = concatSamples(parts)
  if (pcm.length === 0) throw new Error('DeepSeek speech synthesis produced no samples')
  if (normalize) normalizePeak(pcm)

  const mp3 = encodeMp3(pcm, bitrateKbps)
  if (mp3.length === 0) throw new Error('MP3 encoding produced no output')

  return {
    mp3,
    chunks: chunks.length,
    billedCharacters: billed,
    durationSeconds: pcm.length / SAMPLE_RATE,
  }
}
