# WebSocket protocol

- `ClientMessage` and `ServerMessage` in `src/types.ts` define the wire format. They are discriminated unions on `type`.
- `public/app.js` is untyped JS, so it will not catch drift. When you add or change a message type, update `trip-room.ts` and the `handle()` switch in `public/app.js` together.
- A new client gets a full `state` message. Later updates are narrow deltas (`message`, `votes`, `status`, …).
- Chat messages are de-duplicated on both server and client. Keep that behaviour when you touch message sending.
