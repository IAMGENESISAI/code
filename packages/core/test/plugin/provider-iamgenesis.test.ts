import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Integration } from "@opencode-ai/core/integration"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { IamgenesisPlugin } from "@opencode-ai/core/plugin/provider/iamgenesis"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* IamgenesisPlugin.effect(host)
})

describe("IamgenesisPlugin", () => {
  it.effect("registers oauth, api key, and env methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("iamgenesis")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("browser"),
          type: "oauth",
          label: "Sign in with I AM GENESIS",
        },
        { type: "key", label: "API key" },
        { type: "env", names: ["IAMGENESIS_ACCESS_TOKEN", "IAMGENESIS_API_KEY"] },
      ])
    }),
  )
})