# ✈️ Group Trip Planner

<center><img width="1254" height="1325" alt="image" src="https://github.com/user-attachments/assets/7bbbee50-fdc8-4e23-bf83-e4bc93f92357" /></center>

A multiplayer group chat on Cloudflare. While friends talk, an AI picks out everyone's travel preferences, proposes itineraries, runs a vote and announces the winner.

## How it maps to the requirements

| Requirement | Implementation |
|---|---|
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI: pulls constraints out of each message (JSON mode), answers `@planner` mentions, generates 3 itineraries, writes the winner announcement (`src/llm.ts`) |
| **Workflow / coordination** | `ItineraryWorkflow` (Cloudflare Workflows): load context → generate options (with retries) → open voting → `waitForEvent` → reminder → wait again → tally → announce (`src/workflow.ts`). The `TripRoom` Durable Object coordinates the live room and calls into the Workflow |
| **User input (chat)** | Static chat UI served as Workers Static Assets (`public/`), talking to the room over WebSockets |
| **Memory / state** | One `TripRoom` Durable Object per trip with SQLite storage: messages, extracted constraints, options, votes and status. Hibernatable WebSockets keep idle rooms cheap (`src/trip-room.ts`) |

```
Browser ──WS──▶ Worker ──▶ TripRoom DO (SQLite) ──create/sendEvent──▶ ItineraryWorkflow
                              ▲   │ Llama 3.3 (extract, @planner)          │ Llama 3.3 (itineraries, announcement)
                              └───┴──────────── RPC: getPlanningContext / publishOptions / tallyVotes / finalize
```

## Flow

1. Create a trip, share the invite link, and chat. Constraints such as dates, budget, interests and dealbreakers show up live in the sidebar.
2. Mention `@planner` to get advice on conflicts and compromises.
3. Click **Generate itineraries** to start a Workflow instance, which posts 3 options.
4. Everyone votes. Voting closes when every online member has voted, when someone clicks **Close voting now**, or after the timeouts: a reminder at `VOTE_REMINDER_AFTER`, then a forced close `VOTE_CLOSE_AFTER` later.
5. The Workflow tallies the votes and Llama 3.3 announces the winner with next steps.

## Running

```bash
npm install
npx wrangler login     # Workers AI always runs remotely, even in `wrangler dev`
npm run dev            # http://localhost:8787
npm run deploy
```

To demo the reminder path quickly, shorten the timeouts in `wrangler.jsonc` (for example `"1 minute"`).

## Scripts

- `npm run typecheck`: run TypeScript
- `npm run cf-typegen`: regenerate `worker-configuration.d.ts` after changing bindings
