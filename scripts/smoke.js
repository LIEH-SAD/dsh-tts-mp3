/**
 * Self-test for the plugin's pure-JavaScript half: text splitting, PCM
 * normalization, and MP3 encoding. No network and no API key are needed.
 *
 * Usage: node scripts/smoke.js
 */

import assert from 'node:assert/strict'

import { billedChars, normalizeSource, splitForRequests } from '../lib/text.js'
import { SAMPLE_RATE, encodeMp3, normalizePeak } from '../lib/tts.js'

/** Fail with a message and a non-zero exit code. */
function check(label, fn) {
  fn()
  console.log(`ok   ${label}`)
}

check('strips markdown escapes and fences', () => {
  const raw = '\\# 标题\n\n```js\nconst a = 1\n```\n\n> 引用\n\n\n\n正文'
  const text = normalizeSource(raw)
  assert.equal(text, '# 标题\n\nconst a = 1\n\n引用\n\n正文')
})

check('counts CJK characters as two billing units', () => {
  assert.equal(billedChars('中文abc'), 7)
})

check('keeps short text in one request', () => {
  assert.equal(splitForRequests('你好世界。', 100).length, 1)
})

check('splits long text inside the budget and keeps every character', () => {
  const sentence = '这是一句用来测试分段的中文句子。'
  const text = sentence.repeat(40)
  const chunks = splitForRequests(text, 400)
  assert.ok(chunks.length > 1, 'expected more than one chunk')
  for (const chunk of chunks) assert.ok(billedChars(chunk) <= 400, 'chunk exceeds budget')
  assert.equal(chunks.join(''), text)
})

check('splits a single over-budget sentence', () => {
  const chunks = splitForRequests('啊'.repeat(500), 200)
  assert.ok(chunks.length >= 5)
  for (const chunk of chunks) assert.ok(billedChars(chunk) <= 200)
})

check('normalizes a quiet signal to about -1 dBFS', () => {
  const samples = new Int16Array(4800)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((index / SAMPLE_RATE) * 2 * Math.PI * 440) * 4000)
  }
  const gain = normalizePeak(samples)
  assert.ok(gain > 1.5 && gain < 8, `unexpected gain ${gain}`)
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  assert.ok(peak > 28000 && peak <= 32767, `unexpected peak ${peak}`)
})

check('encodes PCM to a non-empty MP3 stream', () => {
  const samples = new Int16Array(SAMPLE_RATE)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((index / SAMPLE_RATE) * 2 * Math.PI * 440) * 12000)
  }
  const mp3 = encodeMp3(samples, 128)
  assert.ok(mp3.length > 4000, `unexpected MP3 size ${mp3.length}`)
  const hasSync = mp3[0] === 0xff || (mp3[0] === 0x49 && mp3[1] === 0x44) // frame sync or "ID3"
  assert.ok(hasSync, 'MP3 does not start with a frame sync or an ID3 tag')
})

console.log('\nall checks passed')
