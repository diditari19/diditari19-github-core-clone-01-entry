[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/diditari19/diditari19-github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/diditari19/diditari19-github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# GitHub-compatible forge — stage 1

A standalone, in-memory git forge scaffold for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01), built with Node 22
and the standard library only. No installation or dependencies are needed.

Entry repository: https://github.com/diditari19/diditari19-github-core-clone-01-entry

## Run

The trial runs `node /bot/main.ts` on Node 22.18 or later. Locally:

```sh
node --experimental-strip-types main.ts
```

Set `MAKEFUN_ENV_URL` to the suite's origin and `MAKEFUN_SHOP_TOKEN` to its runtime
bearer token. Without the env URL the entry exits 1. The server binds port 0,
registers its assigned port, polls `/done` with retries, then closes and exits 0.
It never binds the suite's port 8080.

## Stage 1 surface

`GET /healthz` is public. Authenticated REST routes provide the API root, metadata,
repository creation, paginated repository listing, and repository lookup by owner
and name. Errors are JSON and replies carry sequential request IDs.

`scenario.ts` derives users and the organisation from the published seed, and logs
an identity self-check. `store.ts` owns all users, repositories, counters and empty
branch/commit/file maps. Timestamps use `MAKEFUN_TRIAL_NOW`, falling back to
`2026-11-14T06:30:00.000Z`. `app.ts` uses a small route table over that shared store.
`main.ts` implements the starter lifecycle. Metadata is in `package.json` and
`tsconfig.json`; the project is MIT licensed.

Future stages add repository updates/deletion, contents and git objects, branches,
commits, labels, issues, pull requests, smart HTTP, GraphQL and MCP. Unsupported
routes currently return JSON 404. There are no model calls, external services,
git subprocesses, or runtime packages.
