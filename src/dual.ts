// BCP 2.0.0 official same-package dual entry.
//
// Shape per official v2 migration docs (opencode.ai/v2/docs/build/plugins/migrate-v1):
// one default export exposes BOTH implementations — v1 hosts (>=1.18.29) invoke
// `server()`, v2 hosts invoke `setup()`. The APIs stay separate; nothing is
// translated automatically. Both adapters import host SDKs type-only, so this
// module carries zero runtime @opencode/* dependency and is safe to load by
// either host major (the host simply never calls the other major's entry).
import { BlackboardPlugin } from "./adapters/v1"
import { BlackboardV2Plugin } from "./adapters/v2"

export const PLUGIN_ID = "opencode-bcp"

const dualEntry = {
  id: PLUGIN_ID,
  // v1 entry (OpenCode >= 1.18.29): (input, options) => Promise<Hooks>
  server: BlackboardPlugin,
  // v2 entry: (ctx) => Promise<Cleanup | void>
  setup: BlackboardV2Plugin.setup,
}

export default dualEntry
