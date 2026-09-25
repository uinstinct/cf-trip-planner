import { DurableObject } from "cloudflare:workers";
import { assistantReply, extractConstraints } from "./llm";
import type {
  ChatMessage,
  ClientMessage,
  Constraint,
  ItineraryOption,
  PlanningContext,
  ServerMessage,
  TripState,
  TripStatus,
} from "./types";

const HISTORY_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 2000;
const PLANNER_MENTION = /@planner\b/i;

interface Attachment {
  name: string | null;
}

/**
 * One instance per trip. Owns the group chat WebSockets (hibernatable) and all
 * trip state in SQLite: messages, extracted constraints, itinerary options, votes.
 */
export class TripRoom extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS constraints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS votes (member TEXT PRIMARY KEY, option_id INTEGER NOT NULL);
    `);
  }

  // ---------- HTTP / WebSocket entry ----------

  async fetch(request: Request): Promise<Response> {
    const tripId = request.headers.get("X-Trip-Id");
    if (tripId && !this.getMeta("tripId")) this.setMeta("tripId", tripId);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { type: "error", error: "Invalid JSON" });
    }

    const att = ws.deserializeAttachment() as Attachment;
    if (msg.type === "join") {
      const name = String(msg.name ?? "").trim().slice(0, 32);
      if (!name) return this.send(ws, { type: "error", error: "Name required" });
      ws.serializeAttachment({ name } satisfies Attachment);
      this.send(ws, { type: "state", ...this.getState() });
      this.broadcast({ type: "members", members: this.members() });
      return;
    }
    if (!att.name) return this.send(ws, { type: "error", error: "Join first" });

    try {
      switch (msg.type) {
        case "chat":
          return await this.handleChat(att.name, String(msg.text ?? ""));
        case "plan":
          return await this.startPlanning(att.name);
        case "vote":
          return await this.handleVote(att.name, Number(msg.optionId));
        case "close_vote":
          return await this.closeVoting(`${att.name} closed voting early.`);
        default:
          return this.send(ws, { type: "error", error: "Unknown message type" });
      }
    } catch (err) {
      console.error("webSocketMessage failed", err);
      this.send(ws, { type: "error", error: (err as Error).message });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    this.broadcast({ type: "members", members: this.members(ws) });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcast({ type: "members", members: this.members(ws) });
  }

  // ---------- Chat + constraint memory ----------

  private async handleChat(author: string, text: string): Promise<void> {
    text = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text) return;
    // Drop resubmits of the same message (double send, reconnect replay).
    const last = this.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE author = ? AND content = ? AND created_at > ?",
        author, text, Date.now() - 5000,
      )
      .one();
    if (last.n) return;
    this.broadcast({ type: "message", message: this.addMessage(author, "user", text) });

    // Extract constraints first so an @planner reply can see them.
    try {
      const found = await extractConstraints(this.env.AI, author, text, this.constraints());
      if (found.length) {
        const now = Date.now();
        for (const c of found) {
          this.sql.exec(
            "INSERT INTO constraints (member, kind, value, created_at) VALUES (?, ?, ?, ?)",
            author, c.kind, c.value, now,
          );
        }
        this.broadcast({ type: "constraints", constraints: this.constraints() });
      }
    } catch (err) {
      console.error("constraint extraction failed", err);
    }

    if (PLANNER_MENTION.test(text)) {
      const reply = await assistantReply(this.env.AI, this.recentMessages(30), this.constraints());
      if (reply) this.broadcast({ type: "message", message: this.addMessage("Planner", "assistant", reply) });
    }
  }

  // ---------- Workflow orchestration ----------

  private async startPlanning(requestedBy: string): Promise<void> {
    const status = this.status();
    if (status === "planning" || status === "voting") {
      throw new Error(`Already ${status}`);
    }
    if (!this.constraints().length) {
      throw new Error("Share some preferences in chat first so the planner has something to work with.");
    }
    const tripId = this.getMeta("tripId");
    if (!tripId) throw new Error("Trip not initialised");

    const instance = await this.env.ITINERARY_WORKFLOW.create({ params: { tripId } });
    this.setMeta("workflowId", instance.id);
    this.sql.exec("DELETE FROM votes");
    this.setStatus("planning", null);
    this.postSystem(`${requestedBy} asked the planner for itineraries. Generating options…`);
  }

  private async handleVote(member: string, optionId: number): Promise<void> {
    if (this.status() !== "voting") throw new Error("Voting is not open");
    const exists = this.sql.exec("SELECT 1 FROM options WHERE id = ?", optionId).toArray().length;
    if (!exists) throw new Error("Unknown option");

    this.sql.exec(
      "INSERT INTO votes (member, option_id) VALUES (?, ?) ON CONFLICT(member) DO UPDATE SET option_id = excluded.option_id",
      member, optionId,
    );
    const votes = this.votes();
    this.broadcast({ type: "votes", votes });

    // Close automatically once everyone currently in the room has voted.
    const online = this.members();
    if (online.length > 0 && online.every((m) => m in votes)) {
      await this.closeVoting("Everyone has voted!");
    }
  }

  private async closeVoting(note: string): Promise<void> {
    if (this.status() !== "voting") throw new Error("Voting is not open");
    const workflowId = this.getMeta("workflowId");
    if (!workflowId) throw new Error("No active workflow");
    this.postSystem(`${note} Tallying…`);
    const instance = await this.env.ITINERARY_WORKFLOW.get(workflowId);
    await instance.sendEvent({ type: "voting-complete", payload: { note } });
  }

  // ---------- RPC methods called by ItineraryWorkflow ----------

  async getPlanningContext(): Promise<PlanningContext> {
    return {
      tripId: this.getMeta("tripId") ?? "",
      members: [...new Set([...this.members(), ...this.constraints().map((c) => c.member)])],
      constraints: this.constraints(),
      recentMessages: this.recentMessages(40).filter((m) => m.role !== "system"),
    };
  }

  async publishOptions(options: Omit<ItineraryOption, "id">[]): Promise<ItineraryOption[]> {
    this.sql.exec("DELETE FROM options");
    this.sql.exec("DELETE FROM votes");
    const saved = options.map((o, i) => ({ ...o, id: i + 1 }));
    for (const o of saved) this.sql.exec("INSERT INTO options (id, data) VALUES (?, ?)", o.id, JSON.stringify(o));
    this.broadcast({ type: "options", options: saved });
    this.broadcast({ type: "votes", votes: {} });
    this.setStatus("voting", null);
    this.postSystem("Here are the options — cast your vote! Voting closes automatically once everyone has voted.");
    return saved;
  }

  async remindVoters(): Promise<string[]> {
    const votes = this.votes();
    const pending = this.members().filter((m) => !(m in votes));
    this.postSystem(
      pending.length
        ? `Reminder: still waiting on votes from ${pending.join(", ")}.`
        : "Reminder: voting is still open.",
    );
    return pending;
  }

  async tallyVotes(): Promise<{ winner: ItineraryOption; tally: Record<number, number> }> {
    const options = this.options();
    if (!options.length) throw new Error("No options to tally");
    const tally: Record<number, number> = Object.fromEntries(options.map((o) => [o.id, 0]));
    for (const optionId of Object.values(this.votes())) tally[optionId] = (tally[optionId] ?? 0) + 1;
    // Ties (including zero votes) go to the earliest option.
    const winner = options.reduce((best, o) => (tally[o.id] > tally[best.id] ? o : best), options[0]);
    return { winner, tally };
  }

  async finalize(winnerId: number, announcement: string): Promise<void> {
    this.setStatus("decided", winnerId);
    this.broadcast({ type: "message", message: this.addMessage("Planner", "assistant", announcement) });
  }

  async planningFailed(reason: string): Promise<void> {
    this.setStatus("chatting", null);
    this.postSystem(`Planning failed: ${reason}. Try again in a moment.`);
  }

  // ---------- State helpers ----------

  private getState(): TripState {
    return {
      status: this.status(),
      members: this.members(),
      messages: this.recentMessages(HISTORY_LIMIT),
      constraints: this.constraints(),
      options: this.options(),
      votes: this.votes(),
      winnerId: this.winnerId(),
    };
  }

  /** Names of joined, connected members (optionally excluding a socket that is going away). */
  private members(exclude?: WebSocket): string[] {
    const names = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude)
      .map((ws) => (ws.deserializeAttachment() as Attachment | null)?.name)
      .filter((n): n is string => !!n);
    return [...new Set(names)];
  }

  private addMessage(author: string, role: ChatMessage["role"], content: string): ChatMessage {
    const createdAt = Date.now();
    const row = this.sql
      .exec<{ id: number }>(
        "INSERT INTO messages (author, role, content, created_at) VALUES (?, ?, ?, ?) RETURNING id",
        author, role, content, createdAt,
      )
      .one();
    return { id: row.id, author, role, content, createdAt };
  }

  private postSystem(content: string): void {
    this.broadcast({ type: "message", message: this.addMessage("system", "system", content) });
  }

  private recentMessages(limit: number): ChatMessage[] {
    return this.sql
      .exec<{ id: number; author: string; role: string; content: string; created_at: number }>(
        "SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
        limit,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        author: r.author,
        role: r.role as ChatMessage["role"],
        content: r.content,
        createdAt: r.created_at,
      }));
  }

  private constraints(): Constraint[] {
    return this.sql
      .exec<{ id: number; member: string; kind: string; value: string }>(
        "SELECT id, member, kind, value FROM constraints ORDER BY id",
      )
      .toArray() as Constraint[];
  }

  private options(): ItineraryOption[] {
    return this.sql
      .exec<{ data: string }>("SELECT data FROM options ORDER BY id")
      .toArray()
      .map((r) => JSON.parse(r.data));
  }

  private votes(): Record<string, number> {
    const rows = this.sql.exec<{ member: string; option_id: number }>("SELECT * FROM votes").toArray();
    return Object.fromEntries(rows.map((r) => [r.member, r.option_id]));
  }

  private status(): TripStatus {
    return (this.getMeta("status") as TripStatus | null) ?? "chatting";
  }

  private winnerId(): number | null {
    const v = this.getMeta("winnerId");
    return v ? Number(v) : null;
  }

  private setStatus(status: TripStatus, winnerId: number | null): void {
    this.setMeta("status", status);
    this.setMeta("winnerId", winnerId === null ? "" : String(winnerId));
    this.broadcast({ type: "status", status, winnerId });
  }

  private getMeta(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows[0]?.value || null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, value,
    );
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed.
    }
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Ignore closed sockets; the runtime will clean them up.
      }
    }
  }
}
