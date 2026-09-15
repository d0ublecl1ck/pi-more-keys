# pi-more-keys 任务简报

## 背景

PI Coding Agent 支持自定义 provider（`models.json` + `auth.json` api_key 模式）。用户需要：**任何一个 key 模式的 provider，都可以配多个 key，主 key 失败后自动切换备用 key，切换状态持久化**。

之前有过一版设计，但它和 `my-kimi` provider 绑死（provider 名、模型 id、命令名全部硬编码），不可接受。本项目要做**通用方案**：通过配置声明"key 池"，对任意 provider 生效。

项目名 = 目录名 = `pi-more-keys`。

## 已验证的技术事实（基于 pi 0.85.1 / pi-ai 安装版，远程机器相同版本）

1. `pi.registerProvider(id, config)` 支持自定义 `streamSimple(model, context, options)`，这是实现路由层唯一可靠位置。普通 retry 会复用原请求 headers，靠事件监听切换模型不可靠。
2. `@earendil-works/pi-ai/compat` 导出通用分发函数 `streamSimple(model, context, options)`，按 `model.api` 走 api-registry 到内置实现（openai-responses / openai-completions / anthropic-messages 等）。**路由层不需要关心成员 provider 用哪种 api**——把 router model 复制一份、改掉 `provider`/`baseUrl`/`api` 为成员的值，连同成员的 `apiKey` 一起传给这个分发函数即可。
3. `SimpleStreamOptions` 支持 `apiKey`、`maxRetries`、`onResponse(response: {status, headers})`、`signal`、`maxRetryDelayMs`。
4. 每次尝试必须 `maxRetries: 0`，否则底层 SDK 自行重试，路由层拿不到及时失败、白白烧钱。
5. HTTP 状态码通过 `onResponse` 回调拿；错误文本通过 stream 的 error 事件（`errorMessage`）拿。
6. 全局 extension 目录：`~/.pi/agent/extensions/<name>/index.ts` 会被自动发现。
7. 凭据读取：extension 内可在 `session_start` 读 `~/.pi/agent/auth.json`（0600），只存进程内存；**任何日志、状态文件、错误消息、session 条目都不得出现真实 key**。
8. 已产生部分输出（partial output）后**不允许**换 key 重试，避免重复内容。只有请求在第一个 content 事件之前失败才可重试。

## 设计要求

### 配置 `~/.pi/agent/pi-more-keys.json`（非敏感）

```json
{
  "version": 1,
  "pools": {
    "<router-provider-id>": {
      "members": ["<provider-a>", "<provider-b>"],
      "trigger": {
        "httpStatuses": [401, 403, 408, 409, 429, 500, 502, 503, 504],
        "errorKeywords": [],
        "caseInsensitive": true
      },
      "maxAlternateAttempts": 1,
      "switchBack": { "mode": "manual" }
    }
  }
}
```

- `members` 是 `models.json` 里已存在的 provider id，按优先级排序；每个成员的 key 在 `auth.json`。
- 成员数量不限（2 个只是特例）。成员间 baseUrl/api 可以不同（不同 key 打不同 endpoint 也合法），router 逐个尝试。
- router provider 由 extension 动态注册：模型元数据复制第一个成员（`pi.registerProvider` 动态注册，模型列表取自 members[0]）。

### 状态 `~/.pi/agent/pi-more-keys-state.json`

```json
{
  "pools": {
    "<router-id>": {
      "active": "<member-id>",
      "failed": { "<member-id>": { "reason": "429", "at": 0 } }
    }
  }
}
```

原子写入（tmp + rename），PI 重启后保留 active，不每次都试主 key。

### 命令

- `/more-keys` — 各 pool 当前 active、失败记录
- `/more-keys-use <pool> <member>` — 手动切换 active（即切回主 key 的手段）
- `/more-keys-reset <pool>` — 清空失败记录并切回 members[0]

### 切换行为

1. 请求进来 → 读状态 → 用 active 成员的 key 调用。
2. 命中 trigger（状态码或错误关键词）→ 标记失败、持久化 → 若本次尚未产生输出且未超过 `maxAlternateAttempts` → 用下一成员重试 → 成功则 active 改为该成员并持久化。
3. 所有成员都失败 → 把原始错误透传，active 不变。

## 验收标准

1. `npm test`（vitest）全绿：matcher（状态码/关键词）、state（持久化/原子写/损坏恢复）、router（失败切换/部分输出不重试/全员失败透传/状态持久化跨"重启"）。
2. 装到 `~/.pi/agent/extensions/pi-more-keys` 后 `PI_OFFLINE=1 pi --list-models <router-id>` 能列出路由模型。
3. 全仓库 grep 不到任何真实 key 形态字符串（`sk-` 开头长串）。
4. README.md：安装、配置示例（用 `my-kimi` 双 key 做**示例**，但代码里零硬编码）、命令说明、限制。
5. 代码 TypeScript，`npm run build`（tsc）无错。

## 环境

- pi 与 pi-ai 安装在 `~/.local/node/lib/node_modules/@earendil-works/`（`npm root -g` 确认），类型定义看 `pi-ai/dist/types.d.ts`、`pi-ai/dist/compat.d.ts`，文档在 `pi-coding-agent/docs/custom-provider.md`。
- 开发目录 `~/pi-more-keys`（已 git init）。
