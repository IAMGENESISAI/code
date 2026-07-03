# Upstream Sync Guide

CODE.IAMGENESIS.AI is forked from [anomalyco/opencode](https://github.com/anomalyco/opencode). Keep upstream merges predictable by limiting Genesis-specific changes to the paths below.

## Remotes

```bash
git remote add upstream https://github.com/anomalyco/opencode.git   # once
git fetch upstream
```

## Merge workflow

```bash
git checkout dev
git fetch upstream
git merge upstream/dev
# Resolve conflicts only in Genesis-owned paths (see allowlist)
```

Prefer merging `upstream/dev` into `IAMGENESISAI/code` `dev` monthly or when pulling a release you need.

## Genesis-owned paths (safe to customize)

| Path | Purpose |
|------|---------|
| `packages/genesis-brand/**` | Branding: theme, logos, constants, i18n |
| `packages/core/src/plugin/provider/iamgenesis.ts` | IAMGENESIS inference provider |
| `packages/core/src/plugin/provider.ts` | Register `IamgenesisPlugin` |
| `packages/ui/src/theme/themes/iamgenesis.json` | Theme file (theme picker glob) |
| `packages/ui/src/theme/default-themes.ts` | Register iamgenesis theme |
| `packages/ui/src/theme/context.tsx` | Default theme + display name |
| `packages/ui/src/components/logo.tsx` | Logo re-export |
| `packages/app/src/app.tsx` | Default theme prop |
| `packages/app/src/i18n/en.ts` | Brand i18n overlay |
| `packages/app/src/entry.tsx` | Notification icon URL |
| `packages/desktop/src/main/index.ts` | App name, bundle ID |
| `.opencode/opencode.jsonc` | Default provider policy |
| `.env.example` | Dev environment template |
| `UPSTREAM.md` | This file |
| `RELEASE.md` | IAMGENESIS release guide |
| `.github/workflows/release.yml` | IAMGENESIS tag release CI |
| `install` | IAMGENESIS curl installer |

## Do not customize (high merge conflict)

- `packages/protocol/**`, `packages/server/**`, `packages/llm/**`
- `packages/opencode/src/session/**`, `packages/opencode/src/sync/**`
- `patches/**`, `sst.config.ts`, `specs/**`
- `packages/console/**` (unless running a Genesis-hosted cloud console)

When in doubt, upstream wins outside the Genesis-owned allowlist.