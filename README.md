# dsh-tts-mp3

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that reads text or a Markdown
file aloud with the DeepSeek speech-synthesis API and saves one MP3 file.

It adds a single model-facing tool, `tts_to_mp3`. Ask for audio — "read this Markdown file to me as MP3" —
and the agent calls the tool, which:

1. cleans the source text (Markdown escapes, fences, blockquote markers),
2. splits long input into request-sized chunks on paragraph and sentence boundaries,
3. calls `POST https://api.deepseek.com/v1/tools/tts` for each chunk (`format: "pcm"`),
4. joins the PCM, optionally peak-normalizes to about −1 dBFS,
5. encodes one MP3 in-process with a pure-JavaScript LAME port,
6. writes the file and reports its duration, size, and character count.

No ffmpeg, native module, or install script is required.

## Requirements

- DeepSeek Harness with the `tools` service (any desktop or web profile).
- A DeepSeek platform API key in the environment variable named by `apiKeyEnv`
  (`DEEPSEEK_API_KEY` by default):

  ```powershell
  [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-...', 'User')
  ```

## Install

From a plugin directory (the Harness links it and applies the bundle patch):

```powershell
dsh plugin add C:\path\to\dsh-tts-mp3
```

Or in the desktop app: **Plugins** → **Add plugin** → select this directory.

From GitHub, the profile can install the tarball directly:

```powershell
dsh plugin --profile desktop add github:LIEH-SAD/dsh-tts-mp3
```

Restarting the Harness is not required for a fresh local install; replacing an already installed copy needs a restart.

## Usage

Ask in plain language:

> 用男声清晰的朗读 work.md，导出为 MP3

The model calls:

```json
{
  "file": "C:/Users/me/Desktop/work.md",
  "voice": "tide",
  "output": "C:/Users/me/Desktop/work.mp3"
}
```

Result:

```text
Saved 24.2s of tide speech to C:\Users\me\Desktop\work.mp3 (378 KB, 128 kbps, 126 characters in 1 request(s)).
```

### Tool parameters

| Parameter | Type | Description |
|---|---|---|
| `text` | string | Text to read aloud. Markdown formatting is dropped before synthesis. |
| `file` | string | Path to a UTF-8 text or Markdown file. Use instead of `text`. |
| `voice` | `tide` \| `stella` | `tide` is the male voice and the default; `stella` is female. |
| `output` | string | MP3 path. Relative paths resolve against the Harness process working directory. Defaults to `tts-<timestamp>.mp3`. |
| `bitrateKbps` | integer | MP3 bitrate, one of 8–160 for the 24 kHz stream. Defaults to the plugin config (128). |
| `normalize` | boolean | Peak-normalize to about −1 dBFS. Defaults to `true`. |

Pass exactly one of `text` or `file`.

### Config

Optional `config` on the plugin row in the profile patch:

| Key | Default | Description |
|---|---|---|
| `voice` | `tide` | Default voice. |
| `bitrateKbps` | `128` | Default MP3 bitrate. |
| `normalize` | `true` | Default peak normalization. |
| `maxBilledCharsPerRequest` | `8000` | Chunk budget in billed characters (CJK counts 2). The API caps one request at 10,000. |
| `timeoutMs` | `300000` | Cooperative tool-call budget. |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Environment variable holding the API key. |

```yaml
- insert:
    - id: tts-mp3
      name: dsh-tts-mp3
      config:
        voice: stella
        bitrateKbps: 96
```

## Cost and data use

Every call sends the text to `api.deepseek.com` and bills speech characters at the published TTS rate
(1.5 CNY per 10,000 characters at the 50%-off launch price; CJK characters count as two). A 126-character
Markdown note cost about 0.0003 CNY in development. The plugin stores nothing and reads no credentials
beyond the environment variable.

## How it works

`lib/text.js` owns Markdown cleanup, billed-character counting, and chunk splitting. `lib/tts.js` owns the
HTTP request, PCM joining, peak normalization, and MP3 encoding. `index.js` declares the tool and validates
arguments. The plugin imports no Harness package, so it loads the same way in any profile.

## Limitations

- The API picks the language from the text; there is no language, speed, or pitch parameter.
- Audio is mono 24 kHz — the rate the API returns. There is no resampling step.
- One tool call is one file; there is no streaming playback.
- `exec.signal` aborts between chunks, not inside an in-flight request body.

## Development

```powershell
npm install
node scripts/smoke.js   # no network, no API key
```

## License

MIT — see [LICENSE](LICENSE).
