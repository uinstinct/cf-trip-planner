import type {
  ChatMessage,
  Constraint,
  ConstraintKind,
  ItineraryDay,
  ItineraryOption,
  PlanningContext,
} from "./types";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const CONSTRAINT_KINDS: ConstraintKind[] = [
  "destination",
  "dates",
  "budget",
  "interest",
  "dealbreaker",
  "other",
];

async function runJson<T>(ai: Ai, messages: Msg[], schema: object): Promise<T> {
  const res = (await ai.run(MODEL, {
    messages,
    max_tokens: 2048,
    response_format: { type: "json_schema", json_schema: schema },
  } as never)) as { response?: unknown };
  const raw = res.response;
  if (raw && typeof raw === "object") return raw as T;
  if (typeof raw !== "string") throw new Error("Empty LLM response");
  // Tolerate stray prose / code fences around the JSON.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`Non-JSON LLM response: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

async function runText(ai: Ai, messages: Msg[]): Promise<string> {
  const res = (await ai.run(MODEL, { messages, max_tokens: 1024 } as never)) as {
    response?: string;
  };
  return (res.response ?? "").trim();
}

function formatConstraints(constraints: Constraint[]): string {
  if (!constraints.length) return "(none yet)";
  return constraints.map((c) => `- [${c.kind}] ${c.member}: ${c.value}`).join("\n");
}

function formatHistory(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.author}: ${m.content}`).join("\n");
}

/** Pull new, concrete travel constraints out of a single chat message. */
export async function extractConstraints(
  ai: Ai,
  author: string,
  text: string,
  existing: Constraint[],
): Promise<{ kind: ConstraintKind; value: string }[]> {
  const out = await runJson<{ constraints?: { kind: string; value: string }[] }>(
    ai,
    [
      {
        role: "system",
        content:
          "You extract travel-planning constraints from group chat messages. " +
          "Only return NEW, concrete preferences stated by the author (destinations, dates/availability, " +
          "budget, interests, dealbreakers). Skip small talk and anything already listed. " +
          "Keep each value short (under 12 words). Return an empty list if there is nothing new.",
      },
      {
        role: "user",
        content: `Already known constraints:\n${formatConstraints(existing)}\n\nNew message from ${author}:\n"${text}"`,
      },
    ],
    {
      type: "object",
      properties: {
        constraints: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: CONSTRAINT_KINDS },
              value: { type: "string" },
            },
            required: ["kind", "value"],
          },
        },
      },
      required: ["constraints"],
    },
  );
  return (out.constraints ?? [])
    .filter((c) => c && typeof c.value === "string" && c.value.trim())
    .map((c) => ({
      kind: (CONSTRAINT_KINDS as string[]).includes(c.kind) ? (c.kind as ConstraintKind) : "other",
      value: c.value.trim(),
    }));
}

/** Answer a message addressed to @planner using the chat history and known constraints. */
export async function assistantReply(
  ai: Ai,
  history: ChatMessage[],
  constraints: Constraint[],
): Promise<string> {
  return runText(ai, [
    {
      role: "system",
      content:
        "You are Planner, a friendly travel assistant inside a group chat. Be concise (under 120 words). " +
        "Help the group converge: surface conflicts between members' constraints, suggest compromises, " +
        "and when the group seems ready, tell them to press 'Generate itineraries'.\n\n" +
        `Known constraints:\n${formatConstraints(constraints)}`,
    },
    { role: "user", content: `Chat so far:\n${formatHistory(history)}\n\nReply to the latest message addressed to you.` },
  ]);
}

type RawOption = Omit<ItineraryOption, "id" | "days"> & { days?: unknown[] };

/** Llama sometimes writes "Day 1: ... Day 2: ..." into the summary instead of filling `days`. */
function normalizeOption(o: RawOption): Omit<ItineraryOption, "id"> {
  let days = (o.days ?? [])
    .map((d) => (typeof d === "string" ? d : (d as ItineraryDay | null)?.plan))
    .filter((d): d is string => typeof d === "string" && d.trim() !== "");
  let summary = String(o.summary ?? "").trim();
  if (!days.length) {
    const parts = summary.split(/\s*Day \d+\s*[:\-]\s*/i);
    if (parts.length > 1) {
      summary = parts[0].trim();
      days = parts.slice(1).map((p) => p.trim()).filter(Boolean);
    }
  }
  return {
    title: String(o.title ?? "").trim(),
    destination: String(o.destination ?? "").trim(),
    summary,
    estimatedCostPerPerson: String(o.estimatedCostPerPerson ?? "").trim(),
    days: days.map((plan, i) => ({ day: i + 1, plan })),
  };
}

/** Generate three distinct itinerary options that balance everyone's constraints. */
export async function generateItineraries(
  ai: Ai,
  ctx: PlanningContext,
): Promise<Omit<ItineraryOption, "id">[]> {
  const out = await runJson<{ options?: RawOption[] }>(
    ai,
    [
      {
        role: "system",
        content:
          "You are an expert group travel planner. Propose exactly 3 distinct trip options that best satisfy " +
          "ALL members' constraints. Never violate a dealbreaker. Make the options meaningfully different " +
          "(e.g. different destinations or styles). Keep trips 2-7 days.\n" +
          "For each option: `summary` is ONE sentence on why it suits the group; `days` is a list with one " +
          "short string per day (e.g. \"Hike the coastal trail, seafood dinner in town\"). Do not put the day plan in the summary.",
      },
      {
        role: "user",
        content:
          `Members: ${ctx.members.join(", ") || "(unknown)"}\n\n` +
          `Constraints:\n${formatConstraints(ctx.constraints)}\n\n` +
          `Recent chat:\n${formatHistory(ctx.recentMessages)}`,
      },
    ],
    {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              destination: { type: "string" },
              summary: { type: "string" },
              estimatedCostPerPerson: { type: "string" },
              days: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 7 },
            },
            required: ["title", "destination", "summary", "estimatedCostPerPerson", "days"],
          },
        },
      },
      required: ["options"],
    },
  );
  const options = (out.options ?? [])
    .filter((o) => o && typeof o === "object")
    .map(normalizeOption)
    .filter((o) => o.title && o.destination && o.days.length > 0);
  // Throwing lets the Workflow step retry with backoff.
  if (options.length < 2) throw new Error(`LLM returned ${options.length} usable itineraries`);
  return options.slice(0, 3);
}

/** Short celebratory announcement + next steps for the winning option. */
export async function announceWinner(
  ai: Ai,
  winner: ItineraryOption,
  tally: Record<number, number>,
): Promise<string> {
  return runText(ai, [
    {
      role: "system",
      content:
        "You are Planner, a travel assistant in a group chat. Announce the chosen trip in under 100 words, " +
        "then give a short checklist of 3 next steps (bookings etc).",
    },
    {
      role: "user",
      content: `Winner: ${JSON.stringify(winner)}\nVote counts by option id: ${JSON.stringify(tally)}`,
    },
  ]);
}
