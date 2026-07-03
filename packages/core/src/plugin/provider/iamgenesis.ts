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

const authBaseUrl = () => process.env.IAMGENESIS_AUTH_URL ?? "http://localhost:3003"
const apiBaseUrl = () => process.env.IAMGENESIS_API_URL ?? "http://localhost:8000"
const clientSecret = () => process.env.CODE_CLIENT_SECRET

type Pkce = {
  verifier: string
  challenge: string
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type?: string
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

function accessToken(credential: CredentialValue) {
  if (credential.type === "oauth") return credential.access
  return credential.key
}

function oauth(): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: {
      id: METHOD_ID,
      type: "oauth",
      label: "Sign in with I AM GENESIS",
    },
    authorize: () =>
      Effect.gen(function* () {
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
              .end(OauthCallbackPage.error(error, { provider: "I AM GENESIS" }))
            return
          }
          if (!value || url.searchParams.get("state") !== state) {
            const message = value ? "Invalid OAuth state" : "Missing authorization code"
            Effect.runFork(Deferred.fail(code, new Error(message)))
            response
              .writeHead(400, { "Content-Type": "text/html" })
              .end(OauthCallbackPage.error(message, { provider: "I AM GENESIS" }))
            return
          }
          Effect.runFork(Deferred.succeed(code, value))
          response
            .writeHead(200, { "Content-Type": "text/html" })
            .end(OauthCallbackPage.success({ provider: "I AM GENESIS" }))
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
            Effect.flatMap((tokens) => ensureTenant(tokens.access_token).pipe(Effect.as(tokens))),
            Effect.map((tokens) => credential(tokens)),
          ),
        }
      }),
    refresh: (value) => refresh(value),
  }
}

export const IamgenesisPlugin = define<EventV2.Service | Scope.Scope>({
  id: "iamgenesis",
  effect: Effect.fn(function* (ctx) {
    const events = yield* EventV2.Service
    const loading = Semaphore.makeUnsafe(1)
    let connected = false

    const load = Effect.fn("IamgenesisPlugin.load")(function* () {
      const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection
        ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      connected = connection !== undefined
      const envToken = process.env.IAMGENESIS_ACCESS_TOKEN ?? process.env.IAMGENESIS_API_KEY
      const access = credential ? accessToken(credential) : envToken
      if (!access) return

      const models = yield* fetchModels(access).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to load IAMGENESIS models", { cause }).pipe(Effect.as([] as ModelEntry[])),
        ),
      )

      yield* ctx.catalog.transform((catalog) => {
        catalog.provider.update(PROVIDER_ID, (provider) => {
          provider.name = "I AM GENESIS"
          provider.integrationID = INTEGRATION_ID
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `${apiBaseUrl()}/v1`,
          }
        })

        const existing = new Set<string>()
        for (const model of models) {
          existing.add(model.id)
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
          })
        }

        const item = catalog.provider.get(PROVIDER_ID)
        if (!item) return
        for (const model of item.models.values()) {
          if (!existing.has(model.id)) catalog.model.remove(PROVIDER_ID, model.id)
        }

        if (models.length > 0 && !catalog.model.default.get()) {
          catalog.model.default.set(PROVIDER_ID, models[0].id)
        }
      })
    })

    yield* ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = "I AM GENESIS"
      })
      draft.method.update(oauth())
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "API key" },
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
        provider.name = "I AM GENESIS"
        provider.integrationID = INTEGRATION_ID
        provider.api = {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: `${apiBaseUrl()}/v1`,
        }
        if (!connected && !envToken) {
          provider.disabled = false
        }
      })
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

function fetchModels(access: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`${apiBaseUrl()}/v1/models`, {
        headers: { Authorization: `Bearer ${access}` },
        signal,
      })
      if (!response.ok) throw new Error(`Failed to list models: ${response.status}`)
      const body = (await response.json()) as Schema.Schema.Type<typeof ModelsList>
      return body.data.map((model) => ({
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

function exchange(code: string, redirect: string, pkce: Pkce) {
  const secret = clientSecret()
  return request<TokenResponse>(`${authBaseUrl()}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      ...(secret ? { client_secret: secret } : {}),
      redirect_uri: redirect,
      code_verifier: pkce.verifier,
    }),
  })
}

function refresh(value: Pick<Credential.OAuth, "refresh">) {
  const secret = clientSecret()
  return request<TokenResponse>(`${authBaseUrl()}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: value.refresh,
      client_id: CLIENT_ID,
      ...(secret ? { client_secret: secret } : {}),
    }),
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

function credential(tokens: TokenResponse) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
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