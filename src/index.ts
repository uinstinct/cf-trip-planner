export { TripRoom } from "./trip-room";
export { ItineraryWorkflow } from "./workflow";

const TRIP_ID = /^[a-z0-9-]{4,64}$/;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // /api/trips/:tripId/ws -> the trip's Durable Object
    const match = url.pathname.match(/^\/api\/trips\/([^/]+)\/ws$/);
    if (match) {
      const tripId = match[1].toLowerCase();
      if (!TRIP_ID.test(tripId)) return new Response("Invalid trip id", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripId));
      const headers = new Headers(request.headers);
      headers.set("X-Trip-Id", tripId);
      return stub.fetch(new Request(request, { headers }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
