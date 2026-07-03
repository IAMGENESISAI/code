import { PRODUCT_NAME, PROVIDER_NAME } from "./constants"

type Dict = Record<string, string>

export function applyBrandI18n<T extends Dict>(dict: T): T {
  const next = { ...dict } as T & Dict

  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== "string") continue
    let updated = value
    updated = updated.replaceAll("OpenCode Zen", PROVIDER_NAME)
    updated = updated.replaceAll("Genesis Code", PRODUCT_NAME)
    updated = updated.replaceAll("OpenCode", PRODUCT_NAME)
    updated = updated.replaceAll("opencode", "genesis-code")
    ;(next as Dict)[key] = updated
  }

  return next
}