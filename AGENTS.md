# AGENTS.md

Multiplayer group-trip chat on Cloudflare Workers: a `TripRoom` Durable Object runs the room, Llama 3.3 on Workers AI pulls out preferences, and an `ItineraryWorkflow` proposes options, runs a vote and announces the winner.

## Commands

- `npm run typecheck`: `tsc --noEmit`. Run it after every change; there is no test suite.
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts` after any change to bindings in `wrangler.jsonc`. Never hand-edit that file.
- `npm run dev`: Workers AI always runs remotely, so this needs `npx wrangler login`.

## Read when relevant

- [Architecture & data flow](docs/agents/architecture.md): Worker → DO → Workflow, file map
- [WebSocket protocol](docs/agents/protocol.md): changing client/server messages
- [Cloudflare config & bindings](docs/agents/cloudflare.md): editing `wrangler.jsonc`, DO migrations, vars
- [LLM usage](docs/agents/llm.md): prompts, model, JSON mode in `src/llm.ts`
- [Frontend & design](docs/agents/frontend.md): anything in `public/`
