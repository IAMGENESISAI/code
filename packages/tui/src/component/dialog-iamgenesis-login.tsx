import { createSignal, onCleanup, onMount, Show, createMemo, For, createEffect } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useLocal } from "../context/local"
import { useRoute } from "../context/route"
import { useKV } from "../context/kv"
import { useData } from "../context/data"
import { useEvent } from "../context/event"
import { Link } from "../ui/link"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import open from "open"

export function DialogIamgenesisLogin() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const route = useRoute()
  const toast = useToast()
  const kv = useKV()
  const data = useData()
  const events = useEvent()
  const { theme } = useTheme()

  const [state, setState] = createSignal<"starting" | "waiting" | "success" | "error">("starting")
  const [authInfo, setAuthInfo] = createSignal<{ url: string; instructions: string } | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const [tenantList, setTenantList] = createSignal<any[]>([])

  const manualTenantFromConnection = createMemo(() => {
    const ints = data.location?.integration?.list?.() || []
    const iam = ints.find((i: any) => i.id === "iamgenesis")
    const conn = (iam?.connections || [])[0] as { type?: string; label?: string } | undefined
    const label = conn?.type === "credential" ? conn.label : undefined
    if (typeof label === "string" && label && label !== "default") return { id: label, name: label }
    return null
  })

  const tenants = createMemo(() => {
    const fetched = tenantList()
    if (fetched.length > 0) return fetched
    const fromConn = manualTenantFromConnection()
    if (fromConn) return [fromConn]
    const v2Provs = data.location?.provider?.list?.() || []
    const legacyProvs = sync.data.provider || []
    const providerNext = sync.data.provider_next?.all || []
    const v2 = v2Provs.find((pp: any) => pp.id === "iamgenesis")
    const legacy = legacyProvs.find((pp: any) => pp.id === "iamgenesis")
    const next = providerNext.find((pp: any) => pp.id === "iamgenesis")
    const v2Tenants = (v2 as any)?.options?.tenants
    const legacyTenants = (legacy as any)?.options?.tenants
    const nextTenants = (next as any)?.options?.tenants
    if (Array.isArray(v2Tenants) && v2Tenants.length > 0) return v2Tenants
    if (Array.isArray(nextTenants) && nextTenants.length > 0) return nextTenants
    if (Array.isArray(legacyTenants) && legacyTenants.length > 0) return legacyTenants
    return []
  })

  const currentTenant = createMemo(() => {
    const provs = data.location?.provider?.list?.() || []
    const p = provs.find((pp: any) => pp.id === "iamgenesis")
    return (p as any)?.options?.currentTenant || null
  })

  const [showTenantSelect, setShowTenantSelect] = createSignal(false)
  const [completed, setCompleted] = createSignal(false)
  const [didRefresh, setDidRefresh] = createSignal(false)
  const [awaitingTenants, setAwaitingTenants] = createSignal(false)
  const [showManualTenant, setShowManualTenant] = createSignal(false)
  let manualTextarea: TextareaRenderable

  async function applyTenantLabel(tid: string) {
    const credId = getCredentialID()
    if (credId) {
      try {
        await sdk.client.v2.credential.update({ credentialID: credId, label: tid })
        debugLog("set credential label to tenant", tid)
      } catch (e) {
        debugLog("failed to set tenant label", e)
      }
    }
  }

  const getCredentialID = () => {
    const ints = data.location?.integration?.list?.() || [];
    const iamI = ints.find((i: any) => i.id === "iamgenesis");
    const conn0 = (iamI?.connections || [])[0] as any;
    return conn0?.id;
  };

  createEffect(() => {
    if (state() !== "success" || completed() || showTenantSelect()) return
    const ts = tenants()
    if (ts.length === 0) return
    debugLog("effect: tenants available, showing selector", { count: ts.length })
    setShowManualTenant(false)
    setShowTenantSelect(true)
  })

  createEffect(() => {
    if (!showManualTenant()) return
    setTimeout(() => {
      if (!manualTextarea || manualTextarea.isDestroyed) return
      manualTextarea.focus()
    }, 50)
  })

  let pollTimer: ReturnType<typeof setInterval> | undefined

  async function ensureTenantLabel() {
    const credId = getCredentialID()
    if (!credId) return
    const cur = currentTenant()
    const tsForLabel = tenants()
    const toLabel = cur?.id ? cur : tsForLabel[0]
    if (!toLabel) return
    const tid = toLabel.id || toLabel.slug || toLabel.name
    if (!tid) return
    try {
      await sdk.client.v2.credential.update({ credentialID: credId, label: String(tid) })
      debugLog("set credential label to tenant", tid)
    } catch (e) {
      debugLog("failed to set tenant label", e)
    }
  }

  async function refreshLocationData() {
    await Promise.allSettled([
      data.location?.integration?.refresh?.() ?? Promise.resolve(),
      data.location?.provider?.refresh?.() ?? Promise.resolve(),
      data.location?.model?.refresh?.() ?? Promise.resolve(),
    ])
  }

  async function reloadCatalog() {
    const catalogReady = waitForEvent("catalog.updated", 15000)
    await sdk.client.instance.dispose()
    await waitForEvent("server.instance.disposed", 5000)
    await sync.bootstrap().catch((e) => debugLog("bootstrap after catalog reload warn", e))
    await catalogReady
    await refreshLocationData()
  }

  function findIamgenesisModelId() {
    const allV2Models = (data.location?.model?.list?.() || []) as any[]
    const iamModels = allV2Models.filter((m: any) => (m.providerID || m.provider) === "iamgenesis")
    const v2Real = iamModels.find((m: any) => (m.id || m) !== "genesis-default")
    if (v2Real) return String(v2Real.id || v2Real)

    const iamProv = sync.data.provider.find((p: any) => p.id === "iamgenesis")
    if (iamProv?.models) {
      const legacyReal = Object.keys(iamProv.models).find((id: string) => id !== "genesis-default")
      if (legacyReal) return legacyReal
    }
    return undefined
  }

  async function pickIamgenesisModel() {
    for (let i = 0; i < 24; i++) {
      if (i > 0) {
        await refreshLocationData()
        await new Promise((r) => setTimeout(r, 250))
      }
      const fromStore = findIamgenesisModelId()
      if (fromStore) {
        debugLog("pickIamgenesisModel resolved from store", { id: fromStore, attempt: i + 1 })
        return fromStore
      }
      try {
        const res = await sdk.client.v2.model.list({})
        const iamModels = (res.data?.data ?? []).filter((m: any) => m.providerID === "iamgenesis")
        const real = iamModels.find((m: any) => m.id !== "genesis-default")
        if (real?.id) {
          debugLog("pickIamgenesisModel resolved from API", { id: real.id, attempt: i + 1 })
          return real.id
        }
      } catch (e) {
        debugLog("pickIamgenesisModel API poll failed", e)
      }
    }
    debugLog("pickIamgenesisModel exhausted polls, using genesis-default")
    return "genesis-default"
  }

  async function doPostLoginWork(options?: { catalogReloaded?: boolean }) {
    debugLog("doPostLoginWork starting (will create session and clear dialog)");
    setCompleted(true);
    await ensureTenantLabel()
    try {
      if (options?.catalogReloaded) await refreshLocationData()
      else await reloadCatalog()
    } catch (e) {
      debugLog("post-login catalog reload failed", e);
    }

    const chosenModelID = String(await pickIamgenesisModel() || "genesis-default");
    try {
      local.model.set({ providerID: "iamgenesis", modelID: chosenModelID }, { recent: true });
    } catch {}

    debugLog("doPostLoginWork creating session with model", { chosenModelID });
    let createdSession = false;
    try {
      const createRes = await sdk.client.session.create({
        model: { providerID: "iamgenesis", id: chosenModelID },
      });
      if (createRes.data?.id) {
        route.navigate({ type: "session", sessionID: createRes.data.id });
        createdSession = true;
      }
    } catch (e) {
      debugLog("create with preferred model failed, trying fallback genesis-default", e);
    }
    if (!createdSession) {
      try {
        const createRes = await sdk.client.session.create({
          model: { providerID: "iamgenesis", id: "genesis-default" },
        });
        if (createRes.data?.id) {
          route.navigate({ type: "session", sessionID: createRes.data.id });
          createdSession = true;
        }
      } catch (e2) {
        debugLog("fallback session create also failed", e2);
      }
    }
    if (!createdSession) {
      route.navigate({ type: "home" });
    }

    // Small delay to let navigation and re-renders settle before clearing the login dialog
    // (helps avoid flash to blank/empty view in some timing scenarios)
    await new Promise((r) => setTimeout(r, 150));

    kv.set("iamgenesis_post_login", false);
    dialog.clear();
  }

  function decideAfterLogin() {
    if (completed() || state() !== "success") return;
    const ts = tenants();
    const cur = currentTenant();
    debugLog("decideAfterLogin", { tenants: ts.length, hasCurrent: !!cur, didRefresh: didRefresh() });
    setAwaitingTenants(false);
    if (ts.length > 0) {
      setShowManualTenant(false);
      setShowTenantSelect(true);
      return;
    }
    debugLog("decideAfterLogin: no tenants from API, keeping manual workspace entry");
    setShowManualTenant(true);
    dialog.setSize("medium");
  }

  async function confirmManualSlug() {
    const slug = (manualTextarea?.plainText ?? "").trim()
    if (!slug) return
    setTenantList([{ id: slug, name: slug }])
    await applyTenantLabel(slug)
    setShowManualTenant(false)
    await reloadCatalog()
    await doPostLoginWork({ catalogReloaded: true })
  }

  function waitForEvent(type: string, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        unsub()
        clearTimeout(timer)
        resolve()
      }
      const unsub = events.subscribe((event) => {
        if (event.type === type) finish()
      })
      const timer = setTimeout(finish, timeoutMs)
    })
  }

  async function loadTenantsFromApi() {
    const found: any[] = []
    const fromConn = manualTenantFromConnection()
    if (fromConn) found.push(fromConn)
    try {
      const v2 = await sdk.client.v2.provider.list({})
      const iam = v2.data?.data?.find((p) => p.id === "iamgenesis") as any
      const v2Tenants = iam?.options?.tenants
      debugLog("loadTenantsFromApi v2", {
        hasProvider: !!iam,
        optionKeys: iam?.options ? Object.keys(iam.options) : [],
        tenantCount: Array.isArray(v2Tenants) ? v2Tenants.length : 0,
      })
      if (Array.isArray(v2Tenants) && v2Tenants.length > 0) found.push(...v2Tenants)
    } catch (e) {
      debugLog("loadTenantsFromApi v2 failed", e)
    }
    if (found.length === 0) {
      try {
        const legacy = await sdk.client.provider.list({})
        const iam = legacy.data?.all?.find((p) => p.id === "iamgenesis") as any
        const legacyTenants = iam?.options?.tenants
        debugLog("loadTenantsFromApi legacy", {
          hasProvider: !!iam,
          optionKeys: iam?.options ? Object.keys(iam.options) : [],
          tenantCount: Array.isArray(legacyTenants) ? legacyTenants.length : 0,
        })
        if (Array.isArray(legacyTenants) && legacyTenants.length > 0) found.push(...legacyTenants)
      } catch (e) {
        debugLog("loadTenantsFromApi legacy failed", e)
      }
    }
    const deduped = [...new Map(found.map((t) => [(t as any)?.id || (t as any)?.slug || (t as any)?.name, t])).values()]
    if (deduped.length > 0) setTenantList(deduped)
    return deduped
  }

  async function refreshPostLoginData() {
    debugLog("refreshPostLoginData: dispose + wait for catalog + tenant fetch")
    setAwaitingTenants(true)
    // Subscribe before dispose so we catch the plugin reload triggered by the new connection.
    const catalogReady = waitForEvent("catalog.updated", 30000)
    void sdk.client.instance.dispose()
    await waitForEvent("server.instance.disposed", 10000)
    try {
      await sync.bootstrap()
    } catch (e) {
      debugLog("bootstrap after login warn", e)
    }
    await catalogReady
    debugLog("catalog.updated received (or timed out), fetching tenants")
    let sawProvider = false
    for (let i = 0; i < 12; i++) {
      await Promise.allSettled([
        data.location?.integration?.refresh?.() ?? Promise.resolve(),
        data.location?.provider?.refresh?.() ?? Promise.resolve(),
        data.location?.model?.refresh?.() ?? Promise.resolve(),
      ])
      const ts = await loadTenantsFromApi()
      if (ts.length > 0) {
        debugLog("tenants loaded", { count: ts.length, attempt: i + 1 })
        break
      }
      if (tenants().length > 0) {
        debugLog("tenants visible in reactive store", { count: tenants().length, attempt: i + 1 })
        break
      }
      try {
        const v2 = await sdk.client.v2.provider.list({})
        sawProvider = !!v2.data?.data?.find((p) => p.id === "iamgenesis")
      } catch {}
      if (sawProvider && i >= 2) {
        debugLog("provider loaded with 0 tenants (tenant APIs likely unauthorized), stopping poll")
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    setDidRefresh(true)
    decideAfterLogin()
  }

  function debugLog(msg: string, data?: any) {
    const line = `[IAMGENESIS] ${new Date().toISOString()} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    console.error(line);
    Bun.write("/tmp/iamgenesis-debug.log", line + "\n", { append: true } as any).catch(() => {});
  }

  onMount(async () => {
    debugLog("Login dialog mounted - polling for V2 connection after OAuth");
    // Set flag immediately so any connection detection in app effect will defer to the dialog
    // for setting tenant label (to enable X-Tenant-Id) and creating the visible session.
    kv.set("iamgenesis_post_login", true);
    try {
      setState("starting")

      // Start the V2 integration OAuth for iamgenesis (browser method)
      const res = await sdk.client.v2.integration.connect.oauth({
        integrationID: "iamgenesis",
        methodID: "browser",
        inputs: {},
      })

      const attempt = (res as any).data?.data || (res as any).data
      if (!attempt || !attempt.url) {
        const errDetail = (res as any)?.error || res
        debugLog("connect.oauth response:", errDetail);
        throw new Error("Failed to start login (no attempt URL returned)")
      }

      const info = {
        url: attempt.url,
        instructions: attempt.instructions || "Sign in with your IAMGENESIS.AI account in the browser.",
      }
      setAuthInfo(info)
      setState("waiting")

      const attemptID = attempt.attemptID;
      debugLog("OAuth authorize started, opened browser for login", { url: info.url, attemptID });

      // Open browser automatically
      try {
        await open(info.url)
      } catch {
        // Opening browser may fail in some envs; user can click link
      }

      // Poll for connection to appear (the backend handles the localhost callback + token exchange)
      pollTimer = setInterval(async () => {
        try {
          debugLog("poll tick");

          // Primary: poll the attempt status directly (more reliable for OAuth completion)
          if (attemptID) {
            const statusRes = await sdk.client.v2.integration.attempt.status({ attemptID });
            const statusData = (statusRes as any).data || statusRes;
            const status = statusData.status || statusData.data?.status;
            debugLog("poll attempt status", status);
            if (status === "failed") {
              debugLog("full failed status for debugging", statusData);
            }
            if (status === "complete" || status === "success") {
              debugLog("attempt complete detected via status");
              if (pollTimer) clearInterval(pollTimer);
              setState("success");
              setShowManualTenant(true);
              dialog.setSize("medium");
              toast.show({ message: "Logged in to IAMGENESIS.AI", variant: "success" });
              kv.set("iamgenesis_login_dismissed", false);
              kv.set("iamgenesis_post_login", true);
              debugLog("success state set; showing workspace entry (tenant APIs typically 401 for web client)");

              void refreshPostLoginData().catch((e) => {
                debugLog("refreshPostLoginData failed (non fatal)", e);
                setDidRefresh(true);
                setAwaitingTenants(false);
                decideAfterLogin();
              });
              return;
            }
            if (status === "failed" || status === "error") {
              debugLog("attempt failed - full status data", statusData);
              if (pollTimer) clearInterval(pollTimer);
              setState("error");
              const detail = statusData.message || statusData.error || statusData.data?.message || "OAuth attempt failed after browser redirect. Common cause: no workspace selected. Go to platform.iamgenesis.ai (or your tenant URL), choose a workspace, then retry login here.";
              setError(detail);
              // leave dialog open showing the error
              return;
            }
          }

          // Fallback: refresh and check list
          await data.location?.integration?.refresh?.();
          const ints = data.location?.integration?.list?.() || [];
          debugLog("poll after refresh, total integrations", ints.length);
          const iam = Array.isArray(ints) ? ints.find((i: any) => i.id === "iamgenesis") : null;
          debugLog("poll iamgenesis found?", !!iam);
          if (iam) {
            debugLog("poll iam connections", iam.connections);
          }
          if (iam && iam.connections && iam.connections.length > 0) {
            debugLog("V2 connection also visible via list (status should have caught it)", { connections: iam.connections.length });
          }
        } catch (e) {
          debugLog("poll error", e);
        }
      }, 1500)

    } catch (e: any) {
      debugLog("IAMGENESIS login error:", e);
      const detail = e?.data?.message || e?.message || e?.cause?.message || JSON.stringify(e)
      const msg = `Failed to start login: ${detail}`
      setError(msg)
      setState("error")
      toast.show({ variant: "error", message: "IAMGENESIS login failed. See console for details." })
    }
  })

  onCleanup(() => {
    if (pollTimer) clearInterval(pollTimer)
    if (state() !== "success") {
      // User manually closed (esc, click off) before success -> don't immediately re-show dialog
      kv.set("iamgenesis_login_dismissed", true)
    }
  })

  const info = authInfo()

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Login to IAMGENESIS.AI
        </text>
        <Show when={state() !== "waiting" && state() !== "starting"}>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </Show>
      </box>

      {state() === "starting" && (
        <text fg={theme.textMuted}>Starting secure login…</text>
      )}

      {state() === "waiting" && info && (
        <box gap={1}>
          <text fg={theme.text}>A browser window should have opened for you to sign in.</text>
          <Link href={info.url} fg={theme.primary} />
          <text fg={theme.textMuted}>{info.instructions}</text>
          <text fg={theme.textMuted}>Waiting for authorization to complete… (press esc to cancel)</text>
        </box>
      )}

      {state() === "success" && (
        <text fg={theme.primary}>Success! You are now logged in.</text>
      )}

      {showTenantSelect() && (
        <box gap={1}>
          <text fg={theme.text}>Select a tenant/workspace:</text>
          <For each={tenants()}>
            {(t) => (
              <text 
                fg={theme.primary} 
                onMouseUp={async () => {
                  const tid = (t as any)?.id || (t as any)?.slug || (t as any)?.name;
                  if (tid) await applyTenantLabel(String(tid));
                  doPostLoginWork();
                }}
              >
                {(t as any)?.name || (t as any)?.id || (t as any)?.slug}
              </text>
            )}
          </For>
          <text fg={theme.textMuted}>(Select one to continue)</text>
        </box>
      )}

      {state() === "success" && !showTenantSelect() && awaitingTenants() && !showManualTenant() && (
        <text fg={theme.textMuted}>Loading workspaces from platform…</text>
      )}

      {state() === "success" && showManualTenant() && (
        <box gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Enter workspace slug (required)
          </text>
          <text fg={theme.textMuted}>
            Your OAuth token cannot list workspaces (401). Open platform.iamgenesis.ai, copy your workspace slug from the URL or settings, and paste it below.
          </text>
          <Show when={awaitingTenants()}>
            <text fg={theme.textMuted}>Checking platform for workspaces in background…</text>
          </Show>
          <textarea
            height={2}
            ref={(val: TextareaRenderable) => {
              manualTextarea = val
            }}
            placeholder="iamgenesisai-kt1p"
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
            onSubmit={() => void confirmManualSlug()}
          />
          <text fg={theme.primary} onMouseUp={() => void confirmManualSlug()}>
            Continue with this workspace
          </text>
          <text fg={theme.textMuted} onMouseUp={() => doPostLoginWork()}>
            Skip (no workspace header)
          </text>
        </box>
      )}

      {state() === "success" && !showTenantSelect() && !awaitingTenants() && didRefresh() && !showManualTenant() && (
        <box gap={1}>
          <text fg={theme.textMuted}>
            Access token saved. {tenants().length} workspace(s) discovered automatically.
          </text>
          {tenants().length === 0 && (
            <text fg={theme.textMuted}>
              Workspace list APIs are not authorized for this OAuth token (401). Models still work; pick your workspace manually.
            </text>
          )}
          {tenants().length > 0 && (
            <text fg={theme.primary} onMouseUp={() => doPostLoginWork()}>
              Continue with first workspace
            </text>
          )}
          {tenants().length === 0 && (
            <text fg={theme.primary} onMouseUp={() => setShowManualTenant(true)}>
              Enter workspace slug manually
            </text>
          )}
          {tenants().length === 0 && (
            <text fg={theme.textMuted} onMouseUp={() => doPostLoginWork()}>
              Continue without workspace header
            </text>
          )}
          <text fg={theme.textMuted}> (esc to dismiss)</text>
        </box>
      )}

      {state() === "error" && (
        <box gap={1}>
          <text fg={theme.error}>Login failed.</text>
          <text fg={theme.textMuted}>{error() || "Please try again. Check IAMGENESIS_API_URL / AUTH_URL and that the server is running."}</text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            Close
          </text>
        </box>
      )}
    </box>
  )
}
