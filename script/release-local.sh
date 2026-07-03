#!/usr/bin/env bash
set -euo pipefail

# Local release for CODE.IAMGENESIS.AI — build artifacts and publish to GitHub
# without relying on GitHub Actions.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GH_REPO="${GH_REPO:-IAMGENESISAI/code}"
OPENCODE_CHANNEL="${OPENCODE_CHANNEL:-prod}"
DESKTOP=false
DRAFT=false
ALL_PLATFORMS=false
SKIP_TAG=false
SKIP_PUSH=false
YES=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

usage() {
  cat <<EOF
CODE.IAMGENESIS.AI — local release

Usage: ./script/release-local.sh <version> [options]

Arguments:
  version    Release version (e.g. 1.0.0-iamgenesis.1 or v1.0.0-iamgenesis.1)

Options:
  --desktop         Build desktop installer for the current OS (unsigned)
  --all-platforms   Build CLI for all platforms (default: current platform only)
  --draft           Create a draft GitHub release
  --skip-tag        Do not create a git tag
  --skip-push       Do not push the tag to origin (avoids triggering CI)
  -y, --yes         Skip confirmation prompt
  -h, --help        Show this help

Environment:
  GH_REPO           GitHub repo (default: IAMGENESISAI/code)
  OPENCODE_CHANNEL  Build channel (default: prod)

Examples:
  ./script/release-local.sh 1.0.0-iamgenesis.1
  ./script/release-local.sh 1.0.0-iamgenesis.1 --desktop --skip-push
  ./script/release-local.sh 1.0.0-iamgenesis.2 --all-platforms -y

Prerequisites:
  bun, gh (authenticated), zip, tar
EOF
}

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --desktop) DESKTOP=true; shift ;;
    --all-platforms) ALL_PLATFORMS=true; shift ;;
    --draft) DRAFT=true; shift ;;
    --skip-tag) SKIP_TAG=true; shift ;;
    --skip-push) SKIP_PUSH=true; shift ;;
    -y|--yes) YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"
        shift
      else
        echo -e "${RED}Unexpected argument: $1${NC}" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo -e "${RED}Error: version is required${NC}" >&2
  usage
  exit 1
fi

VERSION="${VERSION#v}"
TAG="v${VERSION}"

for cmd in bun gh zip tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}Error: '$cmd' is required but not installed${NC}" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo -e "${RED}Error: gh is not authenticated. Run: gh auth login${NC}" >&2
  exit 1
fi

echo "Release plan:"
echo "  Repo:     $GH_REPO"
echo "  Tag:      $TAG"
echo "  Channel:  $OPENCODE_CHANNEL"
echo "  CLI:      $([[ "$ALL_PLATFORMS" == true ]] && echo "all platforms" || echo "current platform only")"
echo "  Desktop:  $([[ "$DESKTOP" == true ]] && echo "yes" || echo "no")"
echo "  Draft:    $([[ "$DRAFT" == true ]] && echo "yes" || echo "no")"
echo "  Git tag:  $([[ "$SKIP_TAG" == true ]] && echo "skip" || echo "create")"
echo "  Push tag: $([[ "$SKIP_PUSH" == true || "$SKIP_TAG" == true ]] && echo "skip" || echo "push to origin")"

if [[ "$YES" != true ]]; then
  read -r -p "Continue? [y/N] " reply
  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

export OPENCODE_CHANNEL
export OPENCODE_VERSION="$VERSION"

echo ""
echo "=== Installing dependencies ==="
bun install

echo ""
echo "=== Building CLI ==="
BUILD_ARGS=()
if [[ "$ALL_PLATFORMS" != true ]]; then
  BUILD_ARGS+=(--single)
fi
bun ./packages/opencode/script/build.ts "${BUILD_ARGS[@]}"

echo ""
echo "=== Packaging CLI archives ==="
CLI_DIST="$ROOT/packages/opencode/dist"
RELEASE_DIR="$ROOT/release-assets"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

shopt -s nullglob
for dir in "$CLI_DIST"/opencode-*/; do
  [[ -d "${dir}bin" ]] || continue
  name="$(basename "$dir")"
  if [[ "$name" == *linux* ]]; then
    tar -czf "$RELEASE_DIR/${name}.tar.gz" -C "${dir}bin" .
  else
    (cd "${dir}bin" && zip -qr "$RELEASE_DIR/${name}.zip" .)
  fi
  echo "  packaged ${name}"
done
shopt -u nullglob

cp "$ROOT/install" "$RELEASE_DIR/install"
chmod +x "$RELEASE_DIR/install"

if [[ "$DESKTOP" == true ]]; then
  echo ""
  echo "=== Building desktop ==="
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  (
    cd packages/desktop
    bun ./scripts/prepare.ts
    bun run build
    case "$(uname -s)" in
      Darwin*)
        npx electron-builder --mac --publish never --config electron-builder.config.ts
        ;;
      Linux*)
        npx electron-builder --linux --publish never --config electron-builder.config.ts
        ;;
      MINGW*|MSYS*|CYGWIN*)
        npx electron-builder --win --publish never --config electron-builder.config.ts
        ;;
      *)
        echo -e "${RED}Unsupported OS for desktop packaging${NC}" >&2
        exit 1
        ;;
    esac
  )
  shopt -s nullglob
  for asset in packages/desktop/dist/code-desktop-* packages/desktop/dist/latest*.yml; do
    cp "$asset" "$RELEASE_DIR/"
    echo "  packaged $(basename "$asset")"
  done
  shopt -u nullglob
fi

if ! compgen -G "$RELEASE_DIR/opencode-*" > /dev/null; then
  echo -e "${RED}Error: no CLI artifacts found in $RELEASE_DIR${NC}" >&2
  exit 1
fi

echo ""
echo "Release assets:"
ls -la "$RELEASE_DIR/"

if [[ "$SKIP_TAG" != true ]]; then
  echo ""
  echo "=== Git tag ==="
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo -e "${YELLOW}Tag $TAG already exists — reusing it${NC}"
  else
    git tag -a "$TAG" -m "release: $TAG"
    echo "Created tag $TAG"
  fi

  if [[ "$SKIP_PUSH" != true ]]; then
    git push origin "$TAG"
    echo -e "${YELLOW}Pushed $TAG — .github/workflows/release.yml will also run on this tag${NC}"
    echo -e "${YELLOW}Use --skip-push to publish locally without triggering CI${NC}"
  fi
fi

echo ""
echo "=== Publishing to GitHub ==="
if gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
  echo "Release $TAG exists — uploading assets"
  gh release upload "$TAG" "$RELEASE_DIR"/* --clobber --repo "$GH_REPO"
  if [[ "$DRAFT" == false ]]; then
    gh release edit "$TAG" --draft=false --repo "$GH_REPO" 2>/dev/null || true
  fi
else
  GH_ARGS=(release create "$TAG" --repo "$GH_REPO" --title "$TAG")
  if [[ "$DRAFT" == true ]]; then
    GH_ARGS+=(--draft)
  else
    GH_ARGS+=(--generate-notes)
  fi
  gh "${GH_ARGS[@]}" "$RELEASE_DIR"/*
fi

echo ""
echo -e "${GREEN}Release published: https://github.com/${GH_REPO}/releases/tag/${TAG}${NC}"
echo "Install CLI:"
echo "  curl -fsSL https://github.com/${GH_REPO}/releases/download/${TAG}/install | bash"
echo "  curl -fsSL https://github.com/${GH_REPO}/releases/download/${TAG}/install | bash -s -- --version ${VERSION}"