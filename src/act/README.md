# Vendored: the ACT continuity extension's Personal Agent side

Copied unchanged from `Sharathvc23/act-poppy-demo` at commit `f531de9` (MIT): the Personal Agent
(`agent/agent.ts`), the executor host and its control channel (`executor/`), and the shared
modules they import (`shared/`). Do not edit here; change act-poppy-demo and copy again.

mymuse uses it only when `ACT_EXECUTOR=1` (see `src/mymuse/act.ts`). It then hosts John on Muse
(this host's Poppy client, with the same key) and John on Wajo (a second Poppy client at `/wajo`)
as continuity executors for act.stellarminds.ai, which drives them over the control channel.
