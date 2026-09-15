# pi-more-keys

通用 [pi](https://github.com/earendil-works/pi-mono) extension：让**任意** api_key 模式的 provider 支持多 key 故障自动切换，并把切换状态持久化，pi 重启后不再每次都先打失败的 key。

零硬编码：provider 名、模型、命令行为全部由配置声明。任何 provider（内置或 `models.json` 自定义）只要每个成员有独立 key，就能组成 key 池。

## 工作原理

- 你在 `pi-more-keys.json` 里声明一个 **pool**：一个 router provider id + 若干成员 provider id（按优先级排序）。
- extension 用 `pi.registerProvider()` 动态注册 router provider，模型列表复制自第一个成员。
- 请求打到 router 模型时，router 用当前 active 成员的 key、baseUrl、api 发请求（经 pi-ai 兼容层分发，成员间 api/baseUrl 可以不同）。
- 命中触发条件（HTTP 状态码或错误关键词）且**尚未产生任何输出**时：标记该成员失败并持久化 → 自动用下一成员重试 → 成功后 active 切换并持久化。
- 已产生部分输出后**绝不**换 key 重试（避免重复内容）；错误原样透传。
- 所有成员都失败：透传最后一次错误，active 不变。
- 每次尝试强制 `maxRetries: 0`，底层 SDK 不会在 router 背后自行重试。

## 安装

```bash
# 克隆后软链（或复制）到 pi 全局 extension 目录
ln -s /path/to/pi-more-keys ~/.pi/agent/extensions/pi-more-keys

# 开发依赖（仅测试/类型检查需要；运行时 pi 会解析自身模块）
npm install
```

要求 pi ≥ 0.85.1。

## 配置

创建 `~/.pi/agent/pi-more-keys.json`（非敏感，不放任何 key）：

```json
{
  "version": 1,
  "pools": {
    "kimi-pool": {
      "members": ["my-kimi", "my-kimi-backup"],
      "trigger": {
        "httpStatuses": [401, 403, 408, 409, 429, 500, 502, 503, 504],
        "errorKeywords": ["rate limit"],
        "caseInsensitive": true
      },
      "maxAlternateAttempts": 1,
      "switchBack": { "mode": "manual" }
    }
  }
}
```

| 字段 | 说明 | 默认 |
|---|---|---|
| `members` | `models.json` 中已存在的 provider id，按优先级排序，数量不限 | 必填 |
| `trigger.httpStatuses` | 触发切换的 HTTP 状态码 | `[401, 403, 408, 409, 429, 500, 502, 503, 504]` |
| `trigger.errorKeywords` | 触发切换的错误消息子串 | `[]` |
| `trigger.caseInsensitive` | 关键词匹配是否忽略大小写 | `true` |
| `maxAlternateAttempts` | active 失败后最多再试几个备用成员 | `1` |
| `switchBack.mode` | 切回主 key 方式，目前仅支持 `"manual"` | `"manual"` |

### 示例：my-kimi 双 key

`~/.pi/agent/models.json` 声明两个成员 provider（同 endpoint 或不同 endpoint 均可）：

```json
{
  "providers": {
    "my-kimi": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-responses",
      "models": [{ "id": "k3", "name": "K3", "reasoning": true, "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 131072 }]
    },
    "my-kimi-backup": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-responses",
      "models": [{ "id": "k3", "name": "K3 (backup)", "reasoning": true, "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 131072 }]
    }
  }
}
```

每个成员的 key 放 `~/.pi/agent/auth.json`（`pi /login <provider>` 写入，或手动按 `{"<provider>": {"type": "api_key", "key": "..."}}` 格式）。也支持在成员 provider 的 `models.json` `apiKey` 字段里用 pi 的值语法（`$ENV_VAR`、`!command`、字面量）作为 fallback。

配置后 `pi --list-models kimi-pool` 即可看到路由模型（复制自 `members[0]`），在 pi 里 `/model` 选择 `kimi-pool/k3` 使用。

## 命令

| 命令 | 作用 |
|---|---|
| `/more-keys` | 显示各 pool 的 active 成员与失败记录 |
| `/more-keys-use <pool> <member>` | 手动切换 active 成员（即切回主 key 的手段），同时清除该成员的失败记录 |
| `/more-keys-reset <pool>` | 清空失败记录并切回 `members[0]` |

## 状态文件

`~/.pi/agent/pi-more-keys-state.json`：记录每个 pool 的 active 成员与失败记录（原因 + 时间戳）。原子写入（tmp + rename）；文件损坏时自动隔离为 `.corrupt` 并从空状态恢复。只含 provider id 与状态码等元信息，**绝不含 key**。

## 安全

- key 仅从 `auth.json` / `models.json` 读入进程内存，用于请求注入。
- 日志、状态文件、错误消息、session 条目均不出现 key。

## 限制

- 仅支持 api_key 模式成员；OAuth 成员不参与池。
- 部分输出已产生后不重试，错误透传（防止重复内容）。
- 非触发类错误（如 context overflow）不重试、不标记失败，交给 pi 自身恢复流程。
- `switchBack` 目前仅 `manual`：主 key 恢复后用 `/more-keys-use` 或 `/more-keys-reset` 切回。
- router 模型列表复制自第一个成员；成员间模型能力差异由使用者保证。

## 开发

```bash
npm test        # vitest：matcher / state / router
npm run build   # tsc --noEmit 类型检查
```

目录结构：

- `index.ts` — extension 入口（注册 provider 与命令）
- `src/config.ts` — 配置加载与校验
- `src/matcher.ts` — 触发条件匹配
- `src/state.ts` — 状态持久化（原子写、损坏恢复）
- `src/keys.ts` — 成员 key 解析（auth.json / models.json 值语法）
- `src/models-file.ts` — models.json 读取
- `src/router.ts` — 故障切换路由核心
