# Architecture

```
Browser ──WS──▶ Worker (src/index.ts) ──▶ TripRoom DO (SQLite) ──create/sendEvent──▶ ItineraryWorkflow
                                            ▲   │ LLM: extract, @planner                │ LLM: itineraries, announcement
                                            └───┴── RPC: getPlanningContext / publishOptions / tallyVotes / finalize
```

| File | Role |
|---|---|
| `src/index.ts` | Routes `/api/trips/:tripId/ws` to the DO (`idFromName(tripId)`). Trip ids must match `^[a-z0-9-]{4,64}$`. |
| `src/trip-room.ts` | One DO per trip. SQLite holds messages, constraints, options, votes, status. Uses hibernatable WebSockets. |
| `src/workflow.ts` | Load context → generate options (with retries) → open voting → `waitForEvent` → reminder → wait again → tally → announce. |
| `src/llm.ts` | Every Workers AI call. |
| `src/types.ts` | Shared domain and wire types. |

- Trip status only moves forward: `chatting → planning → voting → decided`.
- The Workflow never touches storage directly. It goes through TripRoom RPC methods, so new state access should be added as a DO method.
- Voting closes when every online member has voted, on "Close voting now", or after the `VOTE_*` timeouts.
