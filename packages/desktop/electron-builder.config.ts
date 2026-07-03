import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
const isCI = process.env.GITHUB_ACTIONS === "true"
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "code-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/code-desktop.desktop`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (!isCI) return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.iamgenesis.code.dev",
  beta: "ai.iamgenesis.code.beta",
  prod: "ai.iamgenesis.code",
} as const

const PRODUCT_NAMES = {
  dev: "CODE.IAMGENESIS.AI Dev",
  beta: "CODE.IAMGENESIS.AI Beta",
  prod: "CODE.IAMGENESIS.AI",
} as const

const GITHUB_PUBLISH = {
  provider: "github" as const,
  owner: "IAMGENESISAI",
  repo: "code",
  channel: "latest",
}

const getBase = (appId: string): Configuration => ({
  artifactName: "code-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: !isCI,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: !isCI,
    identity: isCI ? null : undefined,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: !isCI,
  },
  protocols: {
    name: "CODE.IAMGENESIS.AI",
    schemes: ["genesis-code"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)
  const productName = PRODUCT_NAMES[channel]

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName,
        rpm: { packageName: "code-iamgenesis-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName,
        publish: GITHUB_PUBLISH,
        rpm: { packageName: "code-iamgenesis-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName,
        publish: GITHUB_PUBLISH,
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "code-iamgenesis", fpm: [legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()