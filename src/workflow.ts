import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { announceWinner, generateItineraries } from "./llm";

export interface ItineraryParams {
  tripId: string;
}

const VOTING_COMPLETE = "voting-complete";

/**
 * Durable, multi-day planning flow for one trip:
 * load context -> generate options -> open voting -> wait (remind once) -> tally -> announce.
 * Each step is checkpointed, so LLM failures retry and long waits survive restarts.
 */
export class ItineraryWorkflow extends WorkflowEntrypoint<Env, ItineraryParams> {
  async run(event: WorkflowEvent<ItineraryParams>, step: WorkflowStep) {
    const room = this.env.TRIP_ROOM.get(this.env.TRIP_ROOM.idFromName(event.payload.tripId));

    try {
      const context = await step.do("load planning context", () => room.getPlanningContext());

      const options = await step.do(
        "generate itineraries",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        () => generateItineraries(this.env.AI, context),
      );

      await step.do("publish options", () => room.publishOptions(options));
    } catch (err) {
      await step.do("report failure", () => room.planningFailed((err as Error).message));
      throw err;
    }

    // Wait for votes; nudge stragglers once, then close regardless.
    const votedInTime = await this.waitForVotes(step, "wait for votes", this.env.VOTE_REMINDER_AFTER);
    if (!votedInTime) {
      await step.do("remind voters", () => room.remindVoters());
      await this.waitForVotes(step, "wait for remaining votes", this.env.VOTE_CLOSE_AFTER);
    }

    const { winner, tally } = await step.do("tally votes", () => room.tallyVotes());

    const announcement = await step.do(
      "write announcement",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () =>
        (await announceWinner(this.env.AI, winner, tally)) ||
        `We're going with **${winner.title}** (${winner.destination})!`,
    );

    await step.do("finalize trip", () => room.finalize(winner.id, announcement));
    return { winnerId: winner.id, tally };
  }

  /** Resolves true if the room signalled voting-complete, false on timeout. */
  private async waitForVotes(step: WorkflowStep, name: string, timeout: string): Promise<boolean> {
    try {
      await step.waitForEvent(name, { type: VOTING_COMPLETE, timeout: timeout as WorkflowTimeoutDuration });
      return true;
    } catch {
      return false;
    }
  }
}
