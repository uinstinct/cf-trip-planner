export type TripStatus = "chatting" | "planning" | "voting" | "decided";

export type ConstraintKind =
  | "destination"
  | "dates"
  | "budget"
  | "interest"
  | "dealbreaker"
  | "other";

export interface ChatMessage {
  id: number;
  author: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
}

export interface Constraint {
  id: number;
  member: string;
  kind: ConstraintKind;
  value: string;
}

export interface ItineraryDay {
  day: number;
  plan: string;
}

export interface ItineraryOption {
  id: number;
  title: string;
  destination: string;
  summary: string;
  estimatedCostPerPerson: string;
  days: ItineraryDay[];
}

export interface PlanningContext {
  tripId: string;
  members: string[];
  constraints: Constraint[];
  recentMessages: ChatMessage[];
}

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "chat"; text: string }
  | { type: "plan" }
  | { type: "vote"; optionId: number }
  | { type: "close_vote" };

export interface TripState {
  status: TripStatus;
  members: string[];
  messages: ChatMessage[];
  constraints: Constraint[];
  options: ItineraryOption[];
  votes: Record<string, number>;
  winnerId: number | null;
}

export type ServerMessage =
  | ({ type: "state" } & TripState)
  | { type: "message"; message: ChatMessage }
  | { type: "constraints"; constraints: Constraint[] }
  | { type: "options"; options: ItineraryOption[] }
  | { type: "votes"; votes: Record<string, number> }
  | { type: "status"; status: TripStatus; winnerId: number | null }
  | { type: "members"; members: string[] }
  | { type: "error"; error: string };
