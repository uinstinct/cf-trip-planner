# LLM usage

- Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via `env.AI`. Keep all calls in `src/llm.ts`.
- Constraint extraction uses JSON mode. Validate and tolerate malformed output, and never let a bad LLM response crash the room.
- `@planner` mentions in chat trigger an assistant reply.
- Itinerary generation runs inside a Workflow step with retries, so keep it idempotent.
