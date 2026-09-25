const $ = (id) => document.getElementById(id);

const state = {
  name: "",
  tripId: "",
  status: "chatting",
  members: [],
  constraints: [],
  options: [],
  votes: {},
  winnerId: null,
};
let ws;
let retryDelay = 500;

// ---------- Join ----------

const params = new URLSearchParams(location.search);
$("trip").value = params.get("trip") ?? "";
$("name").value = localStorage.getItem("tp:name") ?? "";

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.name = $("name").value.trim();
  state.tripId = ($("trip").value.trim().toLowerCase()) || newTripId();
  localStorage.setItem("tp:name", state.name);
  history.replaceState(null, "", `?trip=${state.tripId}`);
  $("join").hidden = true;
  $("app").hidden = false;
  $("trip-code").textContent = state.tripId;
  connect();
});

function newTripId() {
  const words = ["sunny", "alpine", "coastal", "wild", "urban", "golden", "misty", "island"];
  const pick = words[Math.floor(Math.random() * words.length)];
  return `${pick}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------- Connection ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/api/trips/${state.tripId}/ws`);
  setConn("connecting…");

  ws.onopen = () => {
    retryDelay = 500;
    setConn("online");
    send({ type: "join", name: state.name });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setConn("reconnecting…");
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10000);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setConn(text) {
  $("conn").textContent = text;
}

function handle(msg) {
  switch (msg.type) {
    case "state":
      Object.assign(state, msg);
      $("messages").replaceChildren();
      msg.messages.forEach(addMessage);
      renderAll();
      break;
    case "message":
      addMessage(msg.message);
      break;
    case "constraints":
      state.constraints = msg.constraints;
      renderConstraints();
      break;
    case "options":
      state.options = msg.options;
      renderOptions();
      break;
    case "votes":
      state.votes = msg.votes;
      renderOptions();
      break;
    case "status":
      state.status = msg.status;
      state.winnerId = msg.winnerId;
      renderStatus();
      renderOptions();
      break;
    case "members":
      state.members = msg.members;
      renderMembers();
      break;
    case "error":
      addMessage({ role: "system", author: "system", content: `⚠️ ${msg.error}` });
      break;
  }
}

// ---------- Actions ----------

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chat-input").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chat-input").value = "";
});

$("plan-btn").addEventListener("click", () => send({ type: "plan" }));
$("close-btn").addEventListener("click", () => send({ type: "close_vote" }));
$("copy-link").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  $("copy-link").textContent = "Copied!";
  setTimeout(() => ($("copy-link").textContent = "Copy invite link"), 1500);
});

// ---------- Rendering ----------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

function addMessage(m) {
  const cls = m.role === "user" ? (m.author === state.name ? "me" : "") : m.role;
  const li = el("li", { className: cls });
  if (m.role !== "system") li.append(el("span", { className: "author", textContent: m.author }));
  li.append(m.content);
  $("messages").append(li);
  li.scrollIntoView({ block: "end" });
}

function renderAll() {
  renderStatus();
  renderMembers();
  renderConstraints();
  renderOptions();
}

const STATUS_LABEL = {
  chatting: "💬 Collecting preferences",
  planning: "🧠 Generating itineraries…",
  voting: "🗳️ Voting open",
  decided: "✅ Trip decided",
};

function renderStatus() {
  $("status").textContent = STATUS_LABEL[state.status] ?? state.status;
  const busy = state.status === "planning" || state.status === "voting";
  $("plan-btn").disabled = busy;
  $("plan-btn").textContent = state.status === "decided" ? "Re-plan the trip" : "Generate itineraries";
  $("close-btn").hidden = state.status !== "voting";
}

function renderMembers() {
  $("members").replaceChildren(...state.members.map((m) => el("li", { textContent: m })));
}

function renderConstraints() {
  if (!state.constraints.length) {
    $("constraints").replaceChildren(el("li", { className: "muted", textContent: "Preferences will appear as you chat." }));
    return;
  }
  $("constraints").replaceChildren(
    ...state.constraints.map((c) =>
      el("li", {}, el("span", { className: "kind", textContent: c.kind }), `${c.value} `, el("span", { className: "muted", textContent: `— ${c.member}` })),
    ),
  );
}

function renderOptions() {
  if (!state.options.length) {
    $("options").replaceChildren(el("p", { className: "muted", textContent: state.status === "planning" ? "Thinking…" : "No itineraries yet." }));
    return;
  }
  const myVote = state.votes[state.name];
  $("options").replaceChildren(
    ...state.options.map((o) => {
      const voters = Object.entries(state.votes).filter(([, id]) => id === o.id).map(([name]) => name);
      const classes = ["option", o.id === state.winnerId && "winner", o.id === myVote && "mine"].filter(Boolean).join(" ");
      const voteBtn = el("button", {
        textContent: o.id === myVote ? "Your vote ✓" : "Vote",
        disabled: state.status !== "voting",
        onclick: () => send({ type: "vote", optionId: o.id }),
      });
      return el(
        "div",
        { className: classes },
        el("h3", { textContent: `${o.id === state.winnerId ? "🏆 " : ""}${o.title}` }),
        el("div", { className: "meta", textContent: `📍 ${o.destination} · 💰 ${o.estimatedCostPerPerson}/person` }),
        el("p", { textContent: o.summary }),
        el("ol", {}, ...o.days.map((d) => el("li", { textContent: d.plan }))),
        el("footer", {}, el("span", { className: "meta", textContent: voters.length ? `🗳️ ${voters.join(", ")}` : "No votes yet" }), voteBtn),
      );
    }),
  );
}
