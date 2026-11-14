# dsh-tts-mp3

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：调用 DeepSeek 语音合成接口把文本或 Markdown 文件朗读出来，并保存为一个 MP3 文件。

安装后新增一个模型可调用的工具 `tts_to_mp3`。你只需要说"把 work.md 用男声读出来，导出 MP3"，Agent 就会：

1. 清理源文本（Markdown 转义、代码围栏、引用标记）；
2. 按段落和句子把长文本切成不超过预算的分段；
3. 逐段请求 `POST https://api.deepseek.com/v1/tools/tts`（`format: "pcm"`）；
4. 拼接 PCM，可选地做峰值归一化（约 −1 dBFS）；
5. 用纯 JavaScript 的 LAME 移植在进程内编码成一个 MP3；
6. 写出文件，并返回时长、大小和字符数。

不需要 ffmpeg、原生模块或安装脚本。

## 环境要求

- 带 `tools` 服务的 DeepSeek Harness（桌面版或 Web 配置均可）。
- 把 DeepSeek 开放平台 API Key 放进 `apiKeyEnv` 指定的环境变量（默认 `DEEPSEEK_API_KEY`）：

  ```powershell
  [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-...', 'User')
  ```

## 安装

本地目录安装（Harness 会软链接该目录并应用 bundle patch）：

```powershell
dsh plugin add C:\path\to\dsh-tts-mp3
```

或在桌面版里：**插件** → **添加插件** → 选择该目录。

也可以直接从 GitHub 安装：

```powershell
dsh plugin --profile desktop add github:LIEH-SAD/dsh-tts-mp3
```

## 用法

直接说：

> 用男声清晰的朗读 work.md，导出为 MP3

模型会调用：

```json
{
  "file": "C:/Users/me/Desktop/work.md",
  "voice": "tide",
  "output": "C:/Users/me/Desktop/work.mp3"
}
```

返回：

```text
Saved 24.2s of tide speech to C:\Users\me\Desktop\work.mp3 (378 KB, 128 kbps, 126 characters in 1 request(s)).
```

### 工具参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `text` | string | 要朗读的文本，Markdown 格式会在朗读前去掉。 |
| `file` | string | UTF-8 文本或 Markdown 文件路径，与 `text` 二选一。 |
| `voice` | `tide` \| `stella` | `tide` 为男声（默认），`stella` 为女声。 |
| `output` | string | MP3 输出路径；相对路径基于 Harness 进程工作目录，默认 `tts-<时间戳>.mp3`。 |
| `bitrateKbps` | integer | MP3 码率，24 kHz 下可取 8–160，默认跟随插件配置（128）。 |
| `normalize` | boolean | 是否峰值归一化到约 −1 dBFS，默认 `true`。 |

`text` 与 `file` 必须且只能传一个。

### 配置

可以在 profile patch 的插件行上写可选的 `config`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `voice` | `tide` | 默认音色。 |
| `bitrateKbps` | `128` | 默认 MP3 码率。 |
| `normalize` | `true` | 默认是否归一化。 |
| `maxBilledCharsPerRequest` | `8000` | 每次请求的计费字符预算（中文字符计 2）；接口上限 10000。 |
| `timeoutMs` | `300000` | 工具调用超时预算。 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 存放 API Key 的环境变量名。 |

```yaml
- insert:
    - id: tts-mp3
      name: dsh-tts-mp3
      config:
        voice: stella
        bitrateKbps: 96
```

## 费用与数据

每次调用都会把文本发送到 `api.deepseek.com`，按语音合成刊例价计费（限时五折 1.5 元/万字符，
中文按 2 个字符计）。开发验证时一段 126 字的笔记约 0.0003 元。插件不保存任何内容，
除该环境变量外不读取其他凭据。

## 实现构成

`lib/text.js` 负责 Markdown 清理、计费字符统计与分段；`lib/tts.js` 负责 HTTP 请求、PCM 拼接、
峰值归一化与 MP3 编码；`index.js` 声明工具并校验参数。插件不 import 任何 Harness 包，
因此在任何 profile 下加载方式一致。

## 限制

- 语种由接口根据文本自动判断，没有语言、语速、音调参数。
- 音频为接口返回的单声道 24 kHz，没有重采样环节。
- 一次调用产出一个文件，不支持流式播放。
- `exec.signal` 只在分段之间生效，无法中断正在返回的单个请求。

## 开发

```powershell
npm install
node scripts/smoke.js   # 不需要网络和 API Key
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
