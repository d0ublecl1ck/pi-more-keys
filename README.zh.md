# pi-more-keys

[English README](README.md)

零配置多 key 故障切换 [pi](https://github.com/earendil-works/pi-mono) extension。加 provider 的方式完全不变（`models.json` + `/login`），只要执行一句 `/add-more-key` 粘贴备用 key，当前正在用的 provider 就获得多 key 自动故障切换，切换状态持久化，pi 重启后不会再先打失败的 key。

## 使用

```bash
# 安装：软链（或复制）到 pi 全局 extension 目录
ln -s /path/to/pi-more-keys ~/.pi/agent/extensions/pi-more-keys
```

然后在 pi 里：

```
/add-more-key              # 给当前会话正在用的 provider 加备用 key（弹窗粘贴，不进会话历史）
/add-more-key my-kimi      # 或显式指定 provider（覆盖手段）
/more-keys                 # 查看：my-kimi: 2 keys, active=#0
/more-keys-reset my-kimi   # 清失败记录，切回原 key
```

就这么多。没有要手写的配置文件。未选模型时 `/add-more-key`（无参数）会提示先用 `/model` 选模型。

要求 pi ≥ 0.85.1。

## 工作原理

- `/add-more-key` 校验：provider 存在（无参数时取当前会话模型的 provider）→ 其 api 可被 pi-ai 分发 → 原 key 可解析（`/login` 或 models.json `apiKey`）；任一不满足会明确提示原因且不写任何文件。
- 备用 key 追加到 `~/.pi/agent/pi-more-keys.json`（0600），并立即对运行中的会话生效。
- extension 对有备用 key 的 provider 用 `pi.registerProvider()` **只覆盖 streamSimple**（merge 语义，models.json 的 models/baseUrl 原样保留）。
- 请求进来 → 用 active key 打原 endpoint（key 列表 = 原 key + extraKeys，同 provider 同 endpoint，只换 key）。
- 命中触发条件（默认 HTTP 401/403/408/409/429/500/502/503/504，或自定义错误关键词）且**尚未产生任何输出**：标记该 key 失败并持久化 → 换下一个 key 重试 → 成功后 active 切换并持久化。
- 已产生部分输出后**绝不**换 key 重试（避免重复内容），错误原样透传；所有 key 都失败则透传最后一次错误，active 不变。
- 每次尝试强制 `maxRetries: 0`，底层 SDK 不会在 router 背后自行重试。

active key 与失败记录存 `~/.pi/agent/pi-more-keys-state.json`（原子写入，损坏自动隔离恢复）。**状态文件只存 key 序号，不存 key 本体。**

## key 池文件（一般不需要手改）

`~/.pi/agent/pi-more-keys.json`（0600）：

```json
{
  "providers": {
    "my-kimi": {
      "extraKeys": ["..."],
      "trigger": {
        "httpStatuses": [401, 403, 408, 409, 429, 500, 502, 503, 504],
        "errorKeywords": [],
        "caseInsensitive": true
      }
    }
  }
}
```

`trigger` 可省略（用默认值），也可按 provider 自定义触发状态码 / 错误消息关键词。

## 命令

| 命令 | 作用 |
|---|---|
| `/add-more-key [provider-id]` | 弹窗收一个备用 key 加入 key 池，立即生效；不带参数时作用于当前会话模型的 provider |
| `/more-keys` | 各 provider 的 key 数量、当前 active 序号、失败记录 |
| `/more-keys-reset <provider-id>` | 清失败记录并切回原 key（#0） |

## 安全

- 原 key 由 pi 自身解析注入（auth.json / 环境变量 / models.json），extension 不复制不转发。
- 备用 key 只写入 `pi-more-keys.json`（0600）与进程内存；日志、状态文件、错误消息、会话条目均不出现 key。
- key 通过 UI 弹窗收集，不从命令参数读取，避免进入会话历史。

## 限制

- 仅支持 api_key 模式 provider；OAuth provider 不适用。
- provider 的 api 必须能被 pi-ai 兼容层分发（内置 api 类型均可）；不支持的 api 会被拒绝并在启动时跳过、提示。
- 部分输出已产生后不重试，错误透传（防止重复内容）。
- 非触发类错误（如 context overflow）不重试、不标记失败，交给 pi 自身恢复流程。
- 主 key 恢复后用 `/more-keys-reset` 切回（暂无自动回切）。

## 开发

```bash
npm install
npm test        # vitest：matcher / pool-file / state / router / add-key（51 个用例）
npm run build   # tsc --noEmit 类型检查
```

目录结构：

- `index.ts` — extension 入口（启动覆盖注册 + 三个命令）
- `src/pool-file.ts` — key 池文件读写（0600、原子写、trigger 校验）
- `src/router.ts` — 故障切换核心（streamSimple 覆盖实现）
- `src/state.ts` — active/失败状态持久化（按 key 序号）
- `src/matcher.ts` — 触发条件匹配
- `src/add-key.ts` — `/add-more-key` 校验与执行流程（依赖注入，可单测）
