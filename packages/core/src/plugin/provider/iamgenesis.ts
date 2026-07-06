import { createServer } from "node:http"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/v2/effect/integration"
import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { Deferred, Effect, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { Credential } from "../../credential"
import type { CredentialValue } from "@opencode-ai/sdk/v2/types"
import { EventV2 } from "../../event"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { OauthCallbackPage } from "../../oauth/page"
import { ProviderV2 } from "../../provider"

const INTEGRATION_ID = Integration.ID.make("iamgenesis")
const PROVIDER_ID = ProviderV2.ID.make("iamgenesis")
const CLIENT_ID = "web"
const CALLBACK_PORT = 1456
const METHOD_ID = Integration.MethodID.make("browser")

const authBaseUrl = () => process.env.IAMGENESIS_AUTH_URL ?? "https://auth.iamgenesis.ai"
const apiBaseUrl = () => process.env.IAMGENESIS_API_URL ?? "https://api.iamgenesis.ai"

function debugLog(msg: string, data?: any) {
  const line = `[IAMGENESIS] ${new Date().toISOString()} ${msg}${data ? " " + JSON.stringify(data) : ""}`
  console.error(line)
  Bun.write("/tmp/iamgenesis-debug.log", line + "\n", { append: true } as any).catch(() => {})
}

type Pkce = {
  verifier: string
  challenge: string
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type?: string
  [key: string]: unknown
}

const ModelsList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      object: Schema.optional(Schema.String),
      owned_by: Schema.optional(Schema.String),
    }),
  ),
})

const TenantResponse = Schema.Struct({
  tenant_id: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
})

const Tenant = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
})

const TenantsList = Schema.Struct({
  data: Schema.Array(Tenant),
})

function accessToken(credential: CredentialValue) {
  if (credential.type === "oauth") return credential.access
  return credential.key
}

function resolveTenantLabel(label: string | undefined) {
  if (!label || label === "default") return undefined
  return label
}

function parseTenantsBody(body: unknown) {
  if (Array.isArray(body)) return body
  if (typeof body !== "object" || body === null) return []
  const record = body as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.tenants)) return record.tenants
  return []
}

function tenantRecord(id: unknown, name?: unknown) {
  if (typeof id !== "string" || !id) return undefined
  return { id, name: typeof name === "string" && name ? name : id }
}

function tenantsFromRecord(body: Record<string, unknown>): any[] {
  for (const key of ["tenants", "workspaces", "organizations", "orgs"]) {
    const val = body[key]
    if (Array.isArray(val) && val.length > 0) return val
  }
  const user = body.user
  if (user && typeof user === "object") {
    const nested: any[] = tenantsFromRecord(user as Record<string, unknown>)
    if (nested.length > 0) return nested
  }
  const data = body.data
  if (data && typeof data === "object") {
    const nested: any[] = tenantsFromRecord(data as Record<string, unknown>)
    if (nested.length > 0) return nested
    const parsed = parseTenantsBody(data)
    if (parsed.length > 0) return parsed
  }
  const single = tenantRecord(
    body.tenant_id ?? body.tenant ?? body.workspace_id ?? body.org_id ?? body.id,
    body.tenant_name ?? body.name ?? body.workspace_name ?? body.slug,
  )
  if (single) return [single]
  return []
}

function jwtPayload(access: string) {
  const parts = access.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function tenantsFromJwt(access: string) {
  const payload = jwtPayload(access)
  if (!payload) return [] as any[]
  const direct = tenantsFromRecord(payload)
  if (direct.length > 0) return direct
  for (const key of ["active_tenant", "activeTenant", "workspace", "current_tenant", "currentTenant"]) {
    const val = payload[key]
    if (typeof val === "string" && val) return [{ id: val, name: val }]
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const rec = tenantRecord(
        (val as Record<string, unknown>).id ?? (val as Record<string, unknown>).slug,
        (val as Record<string, unknown>).name ?? (val as Record<string, unknown>).slug,
      )
      if (rec) return [rec]
    }
  }
  for (const val of Object.values(payload)) {
    if (!val || typeof val !== "object" || Array.isArray(val)) continue
    const nested = tenantsFromRecord(val as Record<string, unknown>)
    if (nested.length > 0) return nested
  }
  const slug = payload.tenant_slug ?? payload.workspace_slug ?? payload.slug
  if (typeof slug === "string" && slug) return [{ id: slug, name: slug }]
  return []
}

function tenantListUrls() {
  const api = apiBaseUrl().replace(/\/+$/, "")
  const auth = authBaseUrl().replace(/\/+$/, "")
  return [`${api}/v1/tenants`, `${api}/api/tenants`, `${api}/tenants`, `${auth}/api/tenants`]
}

function tenantMeUrls() {
  const api = apiBaseUrl().replace(/\/+$/, "")
  const auth = authBaseUrl().replace(/\/+$/, "")
  return [`${api}/v1/tenants/me`, `${api}/api/tenants/me`, `${api}/tenants/me`, `${auth}/api/tenants/me`]
}

function profileUrls() {
  const api = apiBaseUrl().replace(/\/+$/, "")
  const auth = authBaseUrl().replace(/\/+$/, "")
  return [`${api}/v1/me`, `${api}/v1/user`, `${api}/v1/users/me`, `${auth}/api/me`, `${auth}/api/user`, `${auth}/api/auth/me`]
}

async function fetchTenantsFromProfiles(access: string, signal?: AbortSignal) {
  const headers = { Authorization: `Bearer ${access}` }
  for (const url of profileUrls()) {
    debugLog("listTenants profile try", { url })
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
      debugLog("listTenants profile error", { url, status: response.status })
      continue
    }
    const body = await response.json()
    const items = typeof body === "object" && body ? tenantsFromRecord(body as Record<string, unknown>) : []
    if (items.length > 0) {
      debugLog("listTenants profile success", { url, count: items.length, first: items[0] })
      return items
    }
  }
  return [] as any[]
}

function oauth(): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: {
      id: METHOD_ID,
      type: "oauth",
      label: "Sign in with IAMGENESIS.AI",
    },
    authorize: () =>
      Effect.gen(function* () {
        debugLog("authorize called (starting PKCE oauth)")
        const pkce = yield* Effect.promise(generatePKCE)
        const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
        const code = yield* Deferred.make<string, Error>()
        const redirect = `http://localhost:${CALLBACK_PORT}/auth/callback`
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", `http://localhost:${CALLBACK_PORT}`)
          if (url.pathname !== "/auth/callback") {
            response.writeHead(404).end("Not found")
            return
          }
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          const value = url.searchParams.get("code")
          if (error) {
            Effect.runFork(Deferred.fail(code, new Error(error)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(error, { provider: "IAMGENESIS.AI" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            const message = value ? "Invalid OAuth state" : "Missing authorization code"
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "IAMGENESIS.AI" }))
            return
          }
          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.success({ provider: "IAMGENESIS.AI" }))
        })
        yield* Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(CALLBACK_PORT, "localhost", () => resume(Effect.void))
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
        return {
          mode: "auto" as const,
          url: authorizeURL(redirect, pkce, state),
          instructions: "Sign in with your I AM GENESIS account in the browser. This window will close automatically.",
          callback: Deferred.await(code).pipe(
            Effect.flatMap((value) => exchange(value, redirect, pkce)),
            Effect.flatMap((tokens) =>
              Effect.gen(function* () {
                debugLog("token exchange response keys", {
                  keys: Object.keys(tokens),
                  tokenType: tokens.token_type ?? "unknown",
                  accessLooksJwt: tokens.access_token.split(".").length === 3,
                })
                const fromBody = tenantsFromRecord(tokens)
                const fetched = fromBody.length > 0
                  ? fromBody
                  : yield* listTenants(tokens.access_token).pipe(Effect.catch(() => Effect.succeed([] as any[])))
                const jwtTenants = fetched.length > 0 ? fetched : tenantsFromJwt(tokens.access_token)
                const jwtPayloadKeys = jwtPayload(tokens.access_token)
                debugLog("authorize callback tenant discovery", {
                  bodyCount: fromBody.length,
                  apiCount: fetched.length,
                  jwtCount: jwtTenants.length,
                  jwtKeys: jwtPayloadKeys ? Object.keys(jwtPayloadKeys) : [],
                })
                return credential(tokens, jwtTenants.length > 0 ? { tenants: jwtTenants } : undefined)
              }),
            ),
          ),
        }
      }),
    refresh: (value) => refresh(value),
  }
}

type CatalogSnapshot = {
  tenants: any[]
  current: any
  tenantId: string | undefined
  models: ModelEntry[]
  ready: boolean
}

export const IamgenesisPlugin = define<EventV2.Service | Scope.Scope>({
  id: "iamgenesis",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const loading = Semaphore.makeUnsafe(1)
    let connected = false
    let snapshot: CatalogSnapshot = {
      tenants: [],
      current: null,
      tenantId: undefined,
      models: [],
      ready: false,
    }

    const load = Effect.fn("IamgenesisPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      const envToken = process.env.IAMGENESIS_ACCESS_TOKEN ?? process.env.IAMGENESIS_API_KEY
      const access = credential ? accessToken(credential) : envToken
      if (!access) {
        debugLog("load: no access token available")
        snapshot = { tenants: [], current: null, tenantId: undefined, models: [], ready: false }
        return
      }

      const connLabel = (connection as any)?.label
      const tenantId: string | undefined =
        resolveTenantLabel(connLabel) ||
        resolveTenantLabel((credential as any)?.label) ||
        (credential?.metadata as any)?.currentTenant?.id ||
        (Array.isArray((credential?.metadata as any)?.tenants) ? (credential?.metadata as any).tenants[0]?.id : undefined)

      const fromMeta = credential?.metadata?.tenants
      const currentFromMeta = credential?.metadata?.currentTenant
      debugLog("load: credential metadata tenants?", { hasMetaTenants: fromMeta !== undefined, count: Array.isArray(fromMeta) ? fromMeta.length : "n/a", hasCurrent: !!currentFromMeta, connLabel: connLabel || "none", tenantId: tenantId || "none" })
      const fetched = fromMeta ?? (yield* listTenants(access).pipe(
        Effect.catch((cause) => {
          debugLog("load: listTenants failed, trying JWT claims", cause)
          return Effect.succeed([] as any[])
        }),
      ))
      let tenants = Array.isArray(fetched) && fetched.length > 0 ? fetched : tenantsFromJwt(access)
      if (tenants.length === 0 && tenantId) {
        tenants = [{ id: tenantId, name: tenantId }]
        debugLog("load: using connection label as manual tenant", { tenantId })
      }
      const current = currentFromMeta ?? (yield* getCurrentTenant(access, tenantId).pipe(
        Effect.catch(() => Effect.succeed(null as any)),
      ))
      debugLog("load: final tenants for options", { count: Array.isArray(tenants) ? tenants.length : "n/a", current: current?.id, connLabel, selectedTenant: tenantId })

      const models = yield* fetchModels(access, tenantId).pipe(
        Effect.catch((cause) => {
          debugLog("load: fetchModels failed, using []", cause)
          return Effect.succeed([] as ModelEntry[])
        }),
      )
      debugLog("load: models count (will ensure fallback with tenant header if selected)", models.length)

      snapshot = { tenants, current, tenantId, models, ready: true }
      debugLog("catalog snapshot updated", { tenantsCount: Array.isArray(tenants) ? tenants.length : 0, hasCurrent: !!current, hasTenantHeader: !!tenantId })
    })

    yield* ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = "IAMGENESIS.AI"
      })
      draft.method.update(oauth())
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "Account ID" },
      })
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "env", names: ["IAMGENESIS_ACCESS_TOKEN", "IAMGENESIS_API_KEY"] },
      })
    })

    connected = (yield* ctx.integration.connection.active(INTEGRATION_ID)) !== undefined
    const envToken = Boolean(process.env.IAMGENESIS_ACCESS_TOKEN || process.env.IAMGENESIS_API_KEY)

    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update(PROVIDER_ID, (provider) => {
        provider.name = "IAMGENESIS.AI"
        provider.integrationID = INTEGRATION_ID
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `${apiBaseUrl()}/v1`,
        }
        if (!connected && !envToken && !snapshot.ready) {
          provider.disabled = false
        }
        if (!snapshot.ready) return
        const opts: any = { tenants: snapshot.tenants }
        if (snapshot.current) opts.currentTenant = snapshot.current
        if (snapshot.tenantId) {
          opts.headers = { "X-Tenant-Id": snapshot.tenantId }
        }
        ;(provider as any).options = opts
        debugLog("catalog provider options applied on reload", { tenantsCount: snapshot.tenants.length, hasCurrent: !!snapshot.current, hasTenantHeader: !!snapshot.tenantId })
      })

      if (!snapshot.ready) return

      const tenantId = snapshot.tenantId
      const existing = new Set<string>()
      for (const model of snapshot.models) {
        existing.add(String(model.id))
        catalog.model.update(PROVIDER_ID, model.id, (draft) => {
          draft.name = model.name
          draft.family = "iamgenesis"
          draft.api = {
            id: String(model.id),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${apiBaseUrl()}/v1`,
          }
          draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
          draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
          draft.enabled = true
          draft.status = "active"
          draft.limit = { context: 128000, output: 8192 }
          if (!draft.request) {
            ;(draft as any).request = { headers: {}, body: {} }
          }
          const req = (draft as any).request
          if (!req.headers) req.headers = {}
          if (tenantId) {
            req.headers["X-Tenant-Id"] = tenantId
            ;(draft as any).headers = { "X-Tenant-Id": tenantId }
          } else {
            ;(draft as any).headers = {}
          }
        })
      }

      const fallbackId = "genesis-default"
      existing.add(fallbackId)
      catalog.model.update(PROVIDER_ID, fallbackId as any, (draft) => {
        draft.name = "Genesis Default"
        draft.family = "iamgenesis"
        draft.api = {
          id: "genesis-default",
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `${apiBaseUrl()}/v1`,
        }
        draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
        draft.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
        draft.enabled = true
        draft.status = "active"
        draft.limit = { context: 128000, output: 8192 }
        if (!draft.request) {
          ;(draft as any).request = { headers: {}, body: {} }
        }
        const req = (draft as any).request
        if (!req.headers) req.headers = {}
        if (tenantId) {
          req.headers["X-Tenant-Id"] = tenantId
          ;(draft as any).headers = { "X-Tenant-Id": tenantId }
        } else {
          ;(draft as any).headers = {}
        }
      })

      const item = catalog.provider.get(PROVIDER_ID)
      if (!item) return
      for (const model of item.models.values()) {
        if (!existing.has(model.id)) catalog.model.remove(PROVIDER_ID, model.id)
      }

      if (!catalog.model.default.get()) {
        const first = snapshot.models.length > 0 ? snapshot.models[0].id : (fallbackId as any)
        catalog.model.default.set(PROVIDER_ID, first)
      }
      debugLog("catalog models applied on reload", { modelCount: snapshot.models.length, tenantId: tenantId || "none" })
    })

    const refresh = () => loading.withPermit(load().pipe(Effect.andThen(ctx.catalog.reload())))
    yield* events.subscribe(Integration.Event.ConnectionUpdated).pipe(
      Stream.filter((event) => event.data.integrationID === INTEGRATION_ID),
      Stream.runForEach(refresh),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh().pipe(Effect.forkScoped)
  }),
})

type ModelEntry = { id: ModelV2.ID; name: string }

function fetchModels(access: string, tenantId?: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const url = `${apiBaseUrl()}/v1/models`
      const headers: Record<string, string> = { Authorization: `Bearer ${access}` }
      if (tenantId) {
        headers["X-Tenant-Id"] = tenantId
        debugLog("fetchModels using X-Tenant-Id", { tenantId })
      }
      debugLog("fetchModels start", { url })
      const response = await fetch(url, {
        headers,
        signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        debugLog("fetchModels http error", { status: response.status, detail: detail.slice(0, 300) })
        throw new Error(`Failed to list models: ${response.status}${detail ? ` ${detail}` : ""}`)
      }
      const body = (await response.json()) as Schema.Schema.Type<typeof ModelsList>
      const items = body?.data || []
      debugLog("fetchModels success", { count: items.length, first: items[0] })
      return items.map((model) => ({
        id: ModelV2.ID.make(model.id),
        name: model.id,
      }))
    },
    catch: (cause) => cause,
  })
}

function ensureTenant(access: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${authBaseUrl()}/api/tenants/me`, {
        headers: { Authorization: `Bearer ${access}` },
        signal,
      })
      if (response.status === 404) return
      if (!response.ok) throw new Error(`Failed to resolve tenant: ${response.status}`)
      const body = (await response.json()) as Schema.Schema.Type<typeof TenantResponse>
      const tenant = body.tenant_id ?? body.id
      if (!tenant) {
        throw new Error(
          "No workspace selected. Open platform.iamgenesis.ai, choose a workspace, then reconnect I AM GENESIS.",
        )
      }
    },
    catch: (cause) => cause,
  })
}

function getCurrentTenant(access: string, tenantId?: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${access}` }
      if (tenantId) headers["X-Tenant-Id"] = tenantId
      for (const url of tenantMeUrls()) {
        debugLog("getCurrentTenant try", { url })
        const response = await fetch(url, { headers, signal })
        debugLog("getCurrentTenant status", { url, status: response.status })
        if (response.status === 404) return null
        if (!response.ok) {
          const detail = await response.text().catch(() => "")
          debugLog("getCurrentTenant http error", { url, status: response.status, detail: detail.slice(0, 200) })
          continue
        }
        const body = (await response.json()) as any
        const tenantIdFromBody = body?.tenant_id ?? body?.id ?? body?.data?.tenant_id ?? body?.data?.id
        if (tenantIdFromBody) {
          debugLog("getCurrentTenant success", { id: tenantIdFromBody, url })
          return { id: String(tenantIdFromBody), name: body?.name || body?.data?.name || tenantIdFromBody }
        }
      }
      return null
    },
    catch: (cause) => {
      debugLog("getCurrentTenant exception", cause)
      return null
    },
  })
}

function listTenants(access: string, tenantId?: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${access}` }
      if (tenantId) headers["X-Tenant-Id"] = tenantId
      let lastError = ""
      for (const url of tenantListUrls()) {
        debugLog("listTenants try", { url })
        const response = await fetch(url, { headers, signal })
        if (!response.ok) {
          const detail = await response.text().catch(() => "")
          lastError = `${url} ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`
          debugLog("listTenants http error", { url, status: response.status, detail: detail.slice(0, 200) })
          continue
        }
        const body = (await response.json()) as Schema.Schema.Type<typeof TenantsList>
        const items = parseTenantsBody(body)
        if (items.length > 0) {
          debugLog("listTenants success", { url, count: items.length, first: items[0] })
          return items
        }
      }
      const profileItems = await fetchTenantsFromProfiles(access, signal)
      if (profileItems.length > 0) return profileItems
      const jwtItems = tenantsFromJwt(access)
      if (jwtItems.length > 0) {
        debugLog("listTenants jwt fallback success", { count: jwtItems.length, first: jwtItems[0] })
        return jwtItems
      }
      const payload = jwtPayload(access)
      debugLog("listTenants exhausted all sources", {
        accessLooksJwt: access.split(".").length === 3,
        jwtKeys: payload ? Object.keys(payload) : [],
        lastError,
      })
      throw new Error(`Failed to list tenants from all endpoints${lastError ? `: ${lastError}` : ""}`)
    },
    catch: (cause) => cause,
  })
}

function exchange(code: string, redirect: string, pkce: Pkce) {
  const secret = process.env.CODE_CLIENT_SECRET;
  const body: any = {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    code_verifier: pkce.verifier,
  };
  if (secret) {
    body.client_secret = secret;
  }

  const bodyStr = JSON.stringify(body);
  debugLog("token exchange body", body);
  if (secret) {
    debugLog("including client_secret (length)", secret.length);
  } else {
    debugLog("NOT including client_secret");
  }

  return request<TokenResponse>(`${authBaseUrl()}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

debugLog("plugin loaded (will send client_secret only if CODE_CLIENT_SECRET env is set)");

function refresh(value: Pick<Credential.OAuth, "refresh">) {
  const secret = process.env.CODE_CLIENT_SECRET;
  const body: any = {
    grant_type: "refresh_token",
    refresh_token: value.refresh,
    client_id: CLIENT_ID,
  };
  if (secret) {
    body.client_secret = secret;
  }

  const bodyStr = JSON.stringify(body);
  debugLog("token refresh body", body);
  if (secret) {
    debugLog("including client_secret (length)", secret.length);
  } else {
    debugLog("NOT including client_secret");
  }

  return request<TokenResponse>(`${authBaseUrl()}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).pipe(Effect.map((tokens) => credential(tokens)))
}

function request<A>(url: string, init: RequestInit) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(`Request failed: ${response.status}${detail ? ` ${detail}` : ""}`)
      }
      return response.json() as Promise<A>
    },
    catch: (cause) => cause,
  })
}

function credential(tokens: TokenResponse, metadata?: Record<string, unknown>) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(metadata ? { metadata } : {}),
  })
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)), (byte) => chars[byte % chars.length]).join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64url")
}

function authorizeURL(redirect: string, pkce: Pkce, state: string) {
  return `${authBaseUrl()}/api/auth/authorize?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  })}`
}