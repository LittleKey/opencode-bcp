# 2026-10-08/09 owner upgrade source snapshot

These are the original controllers and probes used for the Linux owner's OMO
3.0.3 upgrade, including transaction failure recovery and the later OpenCode
1.18.35 acceptance. They are retained as source for review and provenance.

**This directory is not an installer or a runnable, self-contained release.**
The scripts refer to the original owner workspace, private candidate/profile,
installation authority, Linux `/proc`, and earlier host-probe helpers. Their
captured manifests, production configuration, credentials, databases,
dependency trees and rollback data are not part of this source snapshot.
Do not execute these scripts on another installation or change hashes/paths
to suppress their original checks.

The production migration implementation is `upgrade.mjs`; its replica runner
is `upgrade-rehearsal.mjs`, and the three independently identified failure
cases are in `transaction-regressions.mjs`. `accept-transaction.mjs` binds the
owner's corrected source to the original evidence. `check-production.mjs`
retains the original 1.18.33 gate, while `check-production-11835.mjs` requires
the separate 1.18.35 compatibility evidence. The probe scripts used local
scripted providers, not real model requests.

For reusable code, use the adjacent `build-omo.mjs`, `omo-patch.mjs`,
`build-skills.mjs` and their tests. For macOS with an ordinary upstream
installation, follow [MACOS-TRIAL.md](../MACOS-TRIAL.md). Production transaction
acceptance here applies only to the recorded Linux owner environment.
