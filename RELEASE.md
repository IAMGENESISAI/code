# CODE.IAMGENESIS.AI — Release Guide

Minimum release wiring for the IAMGENESIS fork of OpenCode. Artifacts publish to [IAMGENESISAI/code releases](https://github.com/IAMGENESISAI/code/releases).

## What gets published

| Asset | Source |
|-------|--------|
| `opencode-{platform}-{arch}.zip` / `.tar.gz` | CLI native binaries |
| `code-desktop-{os}-{arch}.{dmg,exe,deb,...}` | Desktop installers (unsigned in CI) |
| `latest-mac.yml`, `latest-linux.yml`, `latest.yml` | Desktop auto-updater metadata |
| `install` | Curl-install script |

## Cut a release (CI)

1. Ensure `dev` is ready and IAMGENESIS auth/api config is documented in [`.env.example`](.env.example).
2. Tag and push:

```bash
git checkout dev
git pull origin dev
git tag v1.0.0-iamgenesis.1
git push origin v1.0.0-iamgenesis.1
```

3. GitHub Actions [`.github/workflows/release.yml`](.github/workflows/release.yml) runs on `v*` tags, builds CLI + desktop, and creates the release.

## Install for users

### CLI (curl)

```bash
curl -fsSL https://github.com/IAMGENESISAI/code/releases/latest/download/install | bash
```

Pin a version:

```bash
curl -fsSL https://github.com/IAMGENESISAI/code/releases/latest/download/install | bash -s -- --version 1.0.0-iamgenesis.1
```

### CLI (local build)

```bash
bun install
./packages/opencode/script/build.ts --single
./install --binary ./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

### Desktop

Download installers from the [releases page](https://github.com/IAMGENESISAI/code/releases), or build locally:

```bash
cd packages/desktop
OPENCODE_CHANNEL=prod bun run predev
bun run build
bun run package:mac   # package:win / package:linux
```

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_GH_OWNER` | `IAMGENESISAI` | Install script GitHub org |
| `CODE_GH_REPO` | `code` | Install script GitHub repo |
| `CODE_CLI_NAME` | `opencode` | CLI binary name in archives |
| `CODE_PRODUCT_NAME` | `CODE.IAMGENESIS.AI` | Installer branding |
| `CODE_DOCS_URL` | `https://code.iamgenesis.ai` | Post-install help URL |

Release constants live in [`packages/genesis-brand/src/release.ts`](packages/genesis-brand/src/release.ts).

## Hosting `code.iamgenesis.ai/install` (optional)

To mirror upstream’s `curl opencode.ai/install` UX, proxy or copy the `install` file from the latest GitHub release to your domain:

```bash
# Example: static file synced from latest release asset
curl -fsSL https://code.iamgenesis.ai/install | bash
```

## Upstream sync

Keep release-specific changes in the [UPSTREAM.md](UPSTREAM.md) allowlist. Merge `upstream/dev` before tagging when pulling OpenCode updates.

## CI notes

- Desktop macOS/Windows builds in CI are **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`). For signed/notarized builds, run `electron-builder` locally with Apple/Microsoft certs.
- The upstream `publish.yml` workflow remains gated to `anomalyco/opencode` and is not used for IAMGENESIS releases.