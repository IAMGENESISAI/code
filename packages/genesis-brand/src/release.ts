export const RELEASE = {
  productName: "CODE.IAMGENESIS.AI",
  githubOwner: "IAMGENESISAI",
  githubRepo: "code",
  /** Matches `packages/opencode` package name and CLI archive prefixes. */
  cliBinaryName: "opencode",
  desktopArtifactPrefix: "code-desktop",
  installScriptName: "install",
  installUrl: "https://github.com/IAMGENESISAI/code/releases/latest/download/install",
  releasesUrl: "https://github.com/IAMGENESISAI/code/releases",
  homepageUrl: "https://code.iamgenesis.ai",
} as const

export function githubReleasesBase() {
  return `https://github.com/${RELEASE.githubOwner}/${RELEASE.githubRepo}/releases`
}

export function githubLatestDownload(asset: string) {
  return `${githubReleasesBase()}/latest/download/${asset}`
}