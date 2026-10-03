// BCP 2.0.0 façade: default is the official same-package dual entry
// (server=v1, setup=v2). Named exports keep the historical per-major module
// paths importable for direct consumers and tests.
export { BlackboardPlugin, default as BlackboardV1Default } from "./adapters/v1"
export { BlackboardV2Plugin, default as BlackboardV2Default } from "./adapters/v2"
export { PLUGIN_ID } from "./dual"
export { default } from "./dual"
