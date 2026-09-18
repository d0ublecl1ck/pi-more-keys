# pi-more-keys

> One command — `/add-more-key` — gives any API-key provider in [pi](https://github.com/earendil-works/pi-mono) automatic multi-key failover. No config files to write, no new provider to set up.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Requires pi ≥ 0.85.1](https://img.shields.io/badge/pi-%E2%89%A5%200.85.1-blue)](https://github.com/earendil-works/pi-mono)

[中文文档](README.zh.md)

A pi extension that lets you attach **extra API keys to the provider you are already using**. When the active key hits a rate limit or fails (401/429/5xx, configurable), the request transparently retries with the next key, and the switch is **persisted** — pi won't keep hammering the dead key on every request, even across restarts.

## When you need it

- Your provider key gets rate-limited (429) mid-session and you have a backup key, but switching means editing config and restarting.
- You rotate between several keys for the same endpoint and want failover to be automatic, not manual.
- You want the failover decision to survive pi restarts instead of re-tripping the same dead key every time.

## Quick start

```bash
# Install: symlink (or copy) into pi's global extension directory
git clone https://github.com/d0ublecl1ck/pi-more-keys.git
ln -s "$PWD/pi-more-keys" ~/.pi/agent/extensions/pi-more-keys
```

Then inside pi, with your model already selected (e.g. `my-kimi/k3`):

```
/add-more-key              # prompt pops up, paste a backup key for the CURRENT provider
/more-keys                 # my-kimi: 2 keys, active=#0
/more-keys-reset my-kimi   # clear failure records, switch back to the original key
```

That's it. Your provider setup (`models.json` + `/login`) is untouched. No JSON to hand-edit.

## Commands

| Command | What it does |
|---|---|
| `/add-more-key [provider-id]` | Collects a backup key via a secure UI prompt and activates failover immediately. Without an argument, targets the provider of the current session's model. |
| `/more-keys` | Shows per-provider key count, active key index, and failure records. |
| `/more-keys-reset <provider-id>` | Clears failure records and switches back to the original key (#0). |

## How it works

- `/add-more-key` validates first: the provider exists (defaults to the current session model's provider) → its API type is dispatchable by pi-ai → an original key is resolvable (from `/login` or `models.json`). If any check fails, it tells you exactly why and writes nothing.
- Backup keys are appended to `~/.pi/agent/pi-more-keys.json` (mode `0600`) and take effect immediately in the running session.
- For providers with backup keys, the extension overrides **only `streamSimple`** via `pi.registerProvider()` (merge semantics — your `models`/`baseUrl` in `models.json` stay intact).
- Each request goes to the original endpoint with the active key (key list = original key + extraKeys; same provider, same endpoint, only the key changes).
- On a trigger (default HTTP 401/403/408/409/429/500/502/503/504, or custom error keywords) **before any output was produced**: the key is marked failed and persisted → the request retries with the next key → on success the new active key is persisted.
- Once partial output has been produced, failover is **never** attempted (it would duplicate content); the error passes through. If every key fails, the last error passes through and the active key stays unchanged.
- Every attempt forces `maxRetries: 0`, so the underlying SDK never retries behind the router's back.

The active key index and failure records live in `~/.pi/agent/pi-more-keys-state.json` (atomic writes, corruption-safe recovery). **The state file stores key indices, never the keys themselves.**

## Security

- The original key is resolved and injected by pi itself (auth.json / env var / models.json); the extension never copies or forwards it.
- Backup keys only ever touch `pi-more-keys.json` (`0600`) and process memory — never logs, state files, error messages, or session entries.
- Keys are collected through a UI prompt, not command arguments, so they never land in session history.

## Limitations

- API-key providers only; OAuth providers are rejected with an explicit message.
- The provider's API type must be dispatchable by pi-ai's compat layer (all built-in API types qualify); unsupported providers are refused and skipped with a notice.
- No retry after partial output (prevents duplicated content).
- Non-trigger errors (e.g. context overflow) are neither retried nor marked failed — they go to pi's own recovery flow.
- Switching back to a recovered primary key is manual (`/more-keys-reset`); automatic probe-back is not implemented yet.

## Advanced: trigger configuration

The key pool file `~/.pi/agent/pi-more-keys.json` (`0600`) normally needs no hand-editing, but triggers are configurable per provider:

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

`trigger` is optional (defaults shown above) and can be customized per provider.

## Development

```bash
npm install
npm test        # vitest: matcher / pool-file / state / router / add-key
npm run build   # tsc --noEmit type check
```

Layout:

- `index.ts` — extension entry (startup override registration + three commands)
- `src/pool-file.ts` — key pool file I/O (`0600`, atomic writes, trigger validation)
- `src/router.ts` — failover core (the `streamSimple` override)
- `src/state.ts` — active/failed state persistence (by key index)
- `src/matcher.ts` — trigger matching
- `src/add-key.ts` — `/add-more-key` validation and execution flow (dependency-injected, unit-testable)

## License

[MIT](LICENSE)
