// Agent Ground — parent dashboard (no-build static UI).
//
// Talks to the Agent Ground hub using the frozen contract:
//   GET  /api/session        -> {identity, budget, agents, artifacts, watercooler, warden}
//   POST /api/auth           {apiKey}              (after <polli-connect> change)
//   POST /api/budget/topup   {amount}
//   POST /api/close-loop     {answers}
//   WS   /ws                 -> {type, at, ...} frames (spec 2.2 event names)
// WS is the primary channel; GET /api/session every 3s is the fallback.
// WS reconnects with a 1s backoff. Every rendered field is guarded against
// null/undefined — the dashboard never prints "undefined".

const POLL_MS = 3000;
const RECONNECT_MS = 1000;
const FEED_CAP = 200;
const FEED_LIMIT = 60;

const HUB = resolveRestBase();
const WS_URL = resolveWsUrl();

const state = {
    identity: null,
    budget: null,
    agents: [],
    artifacts: [],
    watercooler: [],
    feedExtras: [],
    warden: null,
    wsStatus: "connecting",
    restOk: null,
    closeLoop: { stage: "idle", ran: false },
};

const $ = (id) => document.getElementById(id);
const dom = {
    conn: $("conn"),
    note: $("action-note"),
    identityChip: $("identity-chip"),
    identityAvatar: $("identity-avatar"),
    identityName: $("identity-name"),
    phase: $("budget-phase"),
    budgetNums: $("budget-nums"),
    meter: $("budget-meter"),
    meterFill: $("budget-fill"),
    topupBtn: $("topup-btn"),
    agentsGrid: $("agents-grid"),
    agentsEmpty: $("agents-empty"),
    agentsCount: $("agents-count"),
    blackboardWrap: $("blackboard-wrap"),
    blackboardBody: $("blackboard-body"),
    blackboardEmpty: $("blackboard-empty"),
    artifactsCount: $("artifacts-count"),
    feed: $("watercooler-feed"),
    feedEmpty: $("watercooler-empty"),
    feedCount: $("watercooler-count"),
    clBtn: $("closeloop-btn"),
    clForm: $("closeloop-form"),
    clSubmit: $("closeloop-submit"),
    clCancel: $("closeloop-cancel"),
    clStatus: $("closeloop-status"),
    clGoal: $("cl-goal"),
    clFeatures: $("cl-features"),
    clEdge: $("cl-edge"),
    clTarget: $("cl-target"),
    clConstraints: $("cl-constraints"),
    wardenBody: $("warden-body"),
    wardenEmpty: $("warden-empty"),
    deploymentsList: $("deployments-list"),
    deploymentsEmpty: $("deployments-empty"),
};

// ---------------------------------------------------------------- helpers

function resolveRestBase() {
    const param = new URLSearchParams(window.location.search).get("hub");
    if (param) {
        return param.replace(/\/+$/, "");
    }
    return ""; // same origin — the hub serves this static directory
}

function resolveWsUrl() {
    if (HUB) {
        try {
            const url = new URL(HUB);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            url.pathname = "/ws";
            url.search = "";
            url.hash = "";
            return url.toString();
        } catch {
            // fall through to same-origin / default
        }
    }
    if (
        window.location.protocol === "http:" ||
        window.location.protocol === "https:"
    ) {
        return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
    }
    return "ws://localhost:8877/ws"; // page opened from disk — default hub port
}

function txt(value, fallback = "—") {
    if (value === null || value === undefined) {
        return fallback;
    }
    const s = String(value).trim();
    return s === "" ? fallback : s;
}

function num(value, fallback = null) {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function timeOf(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function fmtTime(value) {
    const t = timeOf(value);
    if (!t) {
        return "—";
    }
    return new Date(t).toLocaleTimeString("en-US", { hour12: false });
}

function fmtPollen(value) {
    const n = num(value);
    if (n === null) {
        return "—";
    }
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function pctOf(budget) {
    const pct = num(budget && budget.pct);
    if (pct !== null) {
        return Math.max(0, Math.min(100, pct));
    }
    const spent = num(budget && budget.spent);
    const max = num(budget && budget.maxPollen);
    if (spent !== null && max !== null && max > 0) {
        return Math.max(0, Math.min(100, (spent / max) * 100));
    }
    return 0;
}

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    return node;
}

function firstUrl(value) {
    if (typeof value !== "string") {
        return null;
    }
    const match = value.match(/https?:\/\/\S+/);
    return match ? match[0] : null;
}

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
    const method = options.method || "GET";
    const body = options.body;
    let res;
    try {
        res = await fetch(HUB + path, {
            method,
            headers:
                body === undefined
                    ? undefined
                    : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (err) {
        throw new Error(`hub unreachable (${err.message})`);
    }
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
            const data = await res.json();
            const message =
                data &&
                data.error &&
                (data.error.message || data.error.code || data.error);
            if (message) {
                detail += `: ${String(message)}`;
            }
        } catch {
            // non-JSON error body — keep the status line
        }
        throw new Error(detail);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- session (3s fallback poll)

let fetching = false;

async function fetchSession() {
    if (fetching) {
        return;
    }
    fetching = true;
    try {
        const session = await api("/api/session");
        state.restOk = true;
        applySession(session);
    } catch {
        state.restOk = false;
    } finally {
        fetching = false;
    }
    renderConn();
}

let sessionTimer = 0;

function scheduleSession(delay = 400) {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(fetchSession, delay);
}

function applySession(session) {
    if (!session || typeof session !== "object") {
        return;
    }
    state.identity =
        session.identity && typeof session.identity === "object"
            ? session.identity
            : null;
    state.budget =
        session.budget && typeof session.budget === "object"
            ? session.budget
            : null;
    state.agents = Array.isArray(session.agents)
        ? session.agents.filter((a) => a && typeof a === "object")
        : [];
    state.artifacts = Array.isArray(session.artifacts)
        ? session.artifacts.filter((a) => a && typeof a === "object")
        : [];
    state.watercooler = Array.isArray(session.watercooler)
        ? session.watercooler.filter((w) => w && typeof w === "object")
        : [];
    state.warden =
        session.warden && typeof session.warden === "object"
            ? session.warden
            : null;
    renderAll();
}

// ---------------------------------------------------------------- websocket (primary channel)

let wsTimer = 0;

function connectWs() {
    clearTimeout(wsTimer);
    let socket;
    try {
        socket = new WebSocket(WS_URL);
    } catch {
        state.wsStatus = "retrying";
        renderConn();
        wsTimer = setTimeout(connectWs, RECONNECT_MS);
        return;
    }
    ws = socket;
    socket.addEventListener("open", () => {
        state.wsStatus = "open";
        renderConn();
        fetchSession();
    });
    socket.addEventListener("message", (msg) => {
        try {
            onEvent(JSON.parse(String(msg.data)));
        } catch {
            // ignore malformed frames
        }
    });
    socket.addEventListener("close", () => {
        state.wsStatus = "retrying";
        renderConn();
        wsTimer = setTimeout(connectWs, RECONNECT_MS);
    });
    socket.addEventListener("error", () => {
        // the close handler performs the reconnect
    });
}

function onEvent(evt) {
    if (!evt || typeof evt !== "object" || !evt.type) {
        return;
    }
    switch (evt.type) {
        case "ground.broadcast":
            addFeedExtra({
                kind: evt.kind,
                from: evt.from,
                summary: evt.summary,
                at: evt.at,
            });
            renderWatercooler();
            renderDeployments();
            break;
        case "ground.reply":
            addFeedExtra({
                kind: "reply",
                from: evt.targetAgentId || evt.from,
                summary: evt.answer || evt.question,
                at: evt.at,
            });
            renderWatercooler();
            break;
        case "ground.inbox":
            addFeedExtra({
                kind: "inbox",
                from: evt.from || evt.agentId,
                summary: evt.request,
                at: evt.at,
            });
            renderWatercooler();
            break;
        case "ground.artifact":
            upsertArtifactFromEvent(evt);
            renderArtifacts();
            scheduleSession();
            break;
        case "agent.card":
            applyCardEvent(evt);
            break;
        case "budget.threshold":
            state.budget = {
                ...(state.budget || {}),
                pct: num(evt.pct, pctOf(state.budget)),
                phase: evt.level === "wrapup" ? "wrapup" : "conservation",
            };
            renderBudget();
            flashNote(
                `Budget ${txt(evt.level, "threshold")} at ${txt(evt.pct, "?")}% — agents are conserving.`,
            );
            break;
        case "budget.cutoff":
            state.budget = {
                ...(state.budget || {}),
                pct: 100,
                phase: "cutoff",
            };
            renderBudget();
            flashNote(
                "Pollen budget exhausted — metered calls are blocked until a top-up.",
            );
            break;
        case "budget.paused":
            state.budget = { ...(state.budget || {}), phase: "paused" };
            renderBudget();
            flashNote(
                `Budget paused — state saved at ${txt(evt.gitSha, "…")}.`,
            );
            break;
        case "budget.resumed":
            state.budget = {
                ...(state.budget || {}),
                phase: "normal",
                maxPollen: num(evt.maxPollen, (state.budget || {}).maxPollen),
            };
            renderBudget();
            flashNote(
                "Budget resumed — agents continue from their checkpoint.",
            );
            break;
        case "warden.verdict":
            onWardenEvent(evt);
            break;
        default:
            break; // unknown event type — ignored
    }
}

function applyCardEvent(evt) {
    const id = txt(evt.agentId, "");
    const agent = id
        ? state.agents.find((a) => txt(a.agent_id, "") === id)
        : null;
    if (agent && evt.status) {
        agent.status = evt.status;
        renderAgents();
    } else {
        scheduleSession(); // unknown card — pull the registry
    }
}

function upsertArtifactFromEvent(evt) {
    const key = txt(evt.key, "");
    if (!key) {
        return;
    }
    const version = txt(evt.version, "");
    const existing = state.artifacts.find(
        (a) => txt(a.key, "") === key && txt(a.version, "") === version,
    );
    if (existing) {
        existing.publisher = evt.publisher ?? existing.publisher;
        existing.changelog = evt.changelog ?? existing.changelog;
        existing.at = evt.at ?? existing.at;
        return;
    }
    state.artifacts.unshift({
        key,
        version,
        content_type: null,
        publisher: evt.publisher ?? null,
        changelog: evt.changelog ?? null,
        payload: null,
        at: evt.at ?? null,
    });
}

function onWardenEvent(evt) {
    if (state.closeLoop.stage !== "interview") {
        state.closeLoop.stage = "running";
        state.closeLoop.ran = true;
        state.closeLoop.lastVerdict = {
            approved: evt.approved === true,
            id: txt(evt.contractId, "the contract"),
            at: Date.now(),
        };
        setCloseLoopText(verdictLine());
    }
    scheduleSession();
}

function verdictLine() {
    const v = state.closeLoop.lastVerdict;
    if (!v) {
        return "";
    }
    return v.approved
        ? `Warden approved ${v.id}.`
        : `Warden rejected ${v.id} — required actions were pinned for the agents.`;
}

// ---------------------------------------------------------------- feed helpers

function addFeedExtra(entry) {
    if (
        !entry ||
        (txt(entry.summary, "") === "" && txt(entry.kind, "") === "")
    ) {
        return;
    }
    state.feedExtras.unshift({
        kind: entry.kind ?? null,
        from: entry.from ?? null,
        summary: entry.summary ?? null,
        at: entry.at ?? null,
    });
    if (state.feedExtras.length > FEED_CAP) {
        state.feedExtras.length = FEED_CAP;
    }
}

function feedKey(entry) {
    return `${txt(entry.kind, "")}|${txt(entry.from, "")}|${txt(entry.summary, "")}`;
}

function feedEntries() {
    const merged = [...state.feedExtras, ...state.watercooler];
    const seen = new Set();
    const out = [];
    for (const entry of merged) {
        const key = feedKey(entry);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(entry);
    }
    out.sort((a, b) => timeOf(b.at) - timeOf(a.at));
    return out.slice(0, FEED_CAP);
}

// ---------------------------------------------------------------- renderers

function renderAll() {
    renderConn();
    renderIdentity();
    renderBudget();
    renderAgents();
    renderArtifacts();
    renderWatercooler();
    renderWarden();
    renderDeployments();
    updateCloseLoopFromSession();
}

function renderConn() {
    if (!dom.conn) {
        return;
    }
    let label = "Connecting…";
    let cls = "conn conn--retry";
    if (state.wsStatus === "open") {
        label = "Live";
        cls = "conn conn--live";
    } else if (state.wsStatus === "retrying") {
        if (state.restOk === true) {
            label = "Reconnecting…";
        } else if (state.restOk === false) {
            label = "Offline";
            cls = "conn conn--down";
        }
    }
    dom.conn.className = cls;
    dom.conn.textContent = label;
}

function renderIdentity() {
    const name =
        state.identity && (state.identity.username || state.identity.name);
    const email = state.identity && state.identity.email;
    const clean = txt(name, "");
    dom.identityName.textContent = clean === "" ? "Not signed in" : clean;
    dom.identityAvatar.textContent =
        clean === "" ? "?" : clean.slice(0, 1).toUpperCase();
    dom.identityChip.title =
        clean === "" ? "Connect with Pollinations to start" : txt(email, clean);
}

function renderBudget() {
    const budget = state.budget || {};
    const pct = pctOf(budget);
    const phase = txt(budget.phase, "normal").toLowerCase();
    const spent = num(budget.spent);
    const max = num(budget.maxPollen);
    dom.budgetNums.textContent = `${fmtPollen(spent)} / ${fmtPollen(max)} Pollen spent`;
    dom.phase.textContent = `Phase: ${phase}`;
    dom.phase.className = `phase phase--${phase}`;
    dom.meterFill.style.width = `${pct}%`;
    dom.meterFill.className =
        "meter__fill" +
        (pct >= 100
            ? " meter__fill--fail"
            : pct >= 75
              ? " meter__fill--warn"
              : "");
    dom.meter.setAttribute("aria-valuenow", String(Math.round(pct)));
    dom.meter.setAttribute(
        "aria-valuetext",
        `${Math.round(pct)} percent of the Pollen budget spent`,
    );
}

function statusPill(status) {
    const s = txt(status, "unknown").toLowerCase();
    const known = [
        "booting",
        "idle",
        "working",
        "closed_loop_running",
        "waiting_event",
        "budget_paused",
    ];
    const pill = el("span", `pill pill--${known.includes(s) ? s : "idle"}`);
    pill.textContent = s.replace(/_/g, " ");
    return pill;
}

function agentCard(agent) {
    const card = el("article", "card");
    const head = el("div", "card__head");
    const title = el("h3", "card__role");
    title.textContent = txt(agent.role, txt(agent.agent_id, "agent"));
    head.append(title, statusPill(agent.status));
    card.append(head);

    const goal = el("p", "card__goal");
    goal.textContent = txt(agent.current_goal, "No current goal set.");
    card.append(goal);

    const summary = txt(agent.last_summary, "");
    if (summary !== "") {
        const p = el("p", "card__summary");
        p.textContent = summary;
        card.append(p);
    }

    const paths = Array.isArray(agent.owned_paths)
        ? agent.owned_paths.filter(Boolean)
        : [];
    if (paths.length > 0) {
        const chips = el("div", "chips");
        for (const p of paths) {
            const chip = el("span", "chip mono");
            chip.textContent = String(p);
            chips.append(chip);
        }
        card.append(chips);
    }

    const meta = el("div", "card__meta");
    const id = el("span", "mono");
    id.textContent = txt(agent.agent_id, "unknown-id");
    meta.append(id);
    const preview = firstUrl(agent.preview_url);
    if (preview) {
        const link = document.createElement("a");
        link.href = preview;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "card__preview";
        link.textContent = "Preview ↗";
        meta.append(link);
    }
    card.append(meta);
    return card;
}

function renderAgents() {
    dom.agentsCount.textContent = String(state.agents.length);
    dom.agentsGrid.replaceChildren(...state.agents.map(agentCard));
    dom.agentsEmpty.hidden = state.agents.length > 0;
}

function artifactRow(artifact) {
    const tr = document.createElement("tr");
    const cells = [
        { value: txt(artifact.key), cls: "mono" },
        { value: txt(artifact.version), cls: "" },
        { value: txt(artifact.content_type), cls: "" },
        { value: txt(artifact.publisher), cls: "" },
        { value: txt(artifact.changelog), cls: "" },
        { value: fmtTime(artifact.at), cls: "" },
    ];
    for (const cell of cells) {
        const td = document.createElement("td");
        if (cell.cls) {
            td.className = cell.cls;
        }
        td.textContent = cell.value;
        tr.append(td);
    }
    return tr;
}

function renderArtifacts() {
    dom.artifactsCount.textContent = String(state.artifacts.length);
    dom.blackboardBody.replaceChildren(...state.artifacts.map(artifactRow));
    const empty = state.artifacts.length === 0;
    dom.blackboardWrap.hidden = empty;
    dom.blackboardEmpty.hidden = !empty;
}

function kindClass(kind) {
    const k = txt(kind, "").toLowerCase();
    const known = [
        "milestone",
        "blocked",
        "needs_review",
        "deployed",
        "reply",
        "inbox",
    ];
    return known.includes(k) ? k : "note";
}

function feedItem(entry) {
    const li = el("li", "feed-item");
    const time = el("span", "feed-item__time mono");
    time.textContent = fmtTime(entry.at);
    const pill = el(
        "span",
        `pill pill--kind pill--kind-${kindClass(entry.kind)}`,
    );
    pill.textContent = txt(entry.kind, "note");
    const from = el("span", "feed-item__from");
    from.textContent = txt(entry.from, "system");
    li.append(time, pill, from);
    const summary = txt(entry.summary, "");
    if (summary !== "") {
        const p = el("span", "feed-item__summary");
        p.textContent = summary;
        li.append(p);
    }
    return li;
}

function renderWatercooler() {
    const entries = feedEntries();
    dom.feedCount.textContent = String(entries.length);
    dom.feed.replaceChildren(...entries.slice(0, FEED_LIMIT).map(feedItem));
    dom.feedEmpty.hidden = entries.length > 0;
}

function renderWarden() {
    const warden =
        state.warden && typeof state.warden === "object" ? state.warden : {};
    const verdicts = Array.isArray(warden.verdicts)
        ? warden.verdicts.filter((v) => v && typeof v === "object")
        : [];
    const latest = verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
    dom.wardenBody.replaceChildren();
    if (warden.phase) {
        const phase = el("p", "warden-phase");
        phase.textContent = `Loop phase: ${txt(warden.phase)}`;
        dom.wardenBody.append(phase);
    }
    if (!latest) {
        dom.wardenEmpty.hidden = false;
        return;
    }
    dom.wardenEmpty.hidden = true;

    const head = el("div", "warden-head");
    const badge = el(
        "span",
        `verdict verdict--${latest.approved === true ? "pass" : "fail"}`,
    );
    badge.textContent = latest.approved === true ? "APPROVED" : "REJECTED";
    head.append(badge);
    const summary = txt(latest.summary, "");
    if (summary !== "") {
        const p = el("p", "warden-summary");
        p.textContent = summary;
        head.append(p);
    }
    dom.wardenBody.append(head);

    const results = Array.isArray(latest.results)
        ? latest.results.filter((r) => r && typeof r === "object")
        : [];
    if (results.length > 0) {
        const list = el("ul", "reqs");
        for (const r of results) {
            const pass = r.status === "PASS";
            const item = el("li", `req req--${pass ? "pass" : "fail"}`);
            const id = el("span", "req__id mono");
            id.textContent = txt(r.req_id, "REQ-?");
            const status = el("span", "req__status");
            status.textContent = txt(r.status, "—");
            item.append(id, status);
            const note = txt(pass ? r.evidence : r.defect, "");
            if (note !== "") {
                const detail = el("span", "req__note");
                detail.textContent = note;
                item.append(detail);
            }
            list.append(item);
        }
        dom.wardenBody.append(list);
    }

    const actions = Array.isArray(latest.required_actions)
        ? latest.required_actions.filter(Boolean)
        : [];
    if (actions.length > 0) {
        const title = el("h3", "warden-actions-title");
        title.textContent = "Required actions";
        const ol = el("ol", "actions");
        for (const action of actions) {
            const li = document.createElement("li");
            li.textContent = String(action);
            ol.append(li);
        }
        dom.wardenBody.append(title, ol);
    }
}

function deployItem(entry) {
    const li = el("li", "deploy-item");
    const time = el("span", "feed-item__time mono");
    time.textContent = fmtTime(entry.at);
    const who = el("span", "feed-item__from");
    who.textContent = entry.label;
    li.append(time, who);
    if (entry.url) {
        const link = document.createElement("a");
        link.href = entry.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "deploy-item__link";
        link.textContent = entry.url;
        li.append(link);
    } else {
        const span = el("span", "feed-item__summary");
        span.textContent = entry.detail;
        li.append(span);
    }
    return li;
}

function renderDeployments() {
    const items = [];
    for (const entry of feedEntries()) {
        if (String(entry.kind || "").toLowerCase() !== "deployed") {
            continue;
        }
        items.push({
            label: txt(entry.from, "agent"),
            detail: txt(entry.summary, "Deployed."),
            at: entry.at,
            url: firstUrl(entry.summary),
        });
    }
    for (const artifact of state.artifacts) {
        if (String(artifact.content_type || "").toLowerCase() !== "url") {
            continue;
        }
        items.push({
            label: txt(artifact.publisher, "agent"),
            detail: txt(artifact.key, "url artifact"),
            at: artifact.at,
            url: firstUrl(artifact.payload),
        });
    }
    items.sort((a, b) => timeOf(b.at) - timeOf(a.at));
    dom.deploymentsList.replaceChildren(...items.map(deployItem));
    dom.deploymentsEmpty.hidden = items.length > 0;
}

function setCloseLoopText(text) {
    dom.clStatus.textContent = text;
}

function updateCloseLoopFromSession() {
    if (state.closeLoop.stage !== "running") {
        return;
    }
    const warden =
        state.warden && typeof state.warden === "object" ? state.warden : null;
    const phase = warden && warden.phase ? String(warden.phase) : "";
    const verdict = state.closeLoop.lastVerdict;
    const fresh = verdict && Date.now() - verdict.at < 10000;
    if (phase) {
        setCloseLoopText(
            fresh
                ? `${verdictLine()} Loop phase: ${phase}.`
                : `Loop phase: ${phase}`,
        );
    } else {
        setCloseLoopText(fresh ? verdictLine() : "");
    }
}

// ---------------------------------------------------------------- actions

let noteTimer = 0;

function flashNote(message) {
    dom.note.textContent = message;
    dom.note.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        dom.note.hidden = true;
    }, 6000);
}

function bindActions() {
    dom.topupBtn.addEventListener("click", async () => {
        const raw = window.prompt(
            "Top-up amount in Pollen (1 Pollen = $1):",
            "5",
        );
        if (raw === null) {
            return;
        }
        const amount = num(raw);
        if (amount === null || amount <= 0) {
            flashNote("Top-up cancelled — enter a positive number of Pollen.");
            return;
        }
        try {
            await api("/api/budget/topup", {
                method: "POST",
                body: { amount },
            });
            flashNote(`Topped up ${fmtPollen(amount)} Pollen.`);
            await fetchSession();
        } catch (err) {
            flashNote(`Top-up failed: ${err.message}`);
        }
    });

    dom.clBtn.addEventListener("click", () => {
        state.closeLoop.stage = "interview";
        dom.clForm.hidden = false;
        setCloseLoopText(
            "Answer the five pre-flight questions, then start the loop.",
        );
        dom.clGoal.focus();
    });

    dom.clCancel.addEventListener("click", () => {
        dom.clForm.hidden = true;
        if (state.closeLoop.ran) {
            state.closeLoop.stage = "running";
            setCloseLoopText("Close-the-Loop continues in the background.");
        } else {
            state.closeLoop.stage = "idle";
            setCloseLoopText("");
        }
    });

    dom.clForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const goal = dom.clGoal.value.trim();
        const features = dom.clFeatures.value.trim();
        if (!goal || !features) {
            setCloseLoopText(
                "Project goal and required features are needed before the loop can start.",
            );
            return;
        }
        const answers = {
            project_goal: goal,
            required_features: features,
            edge_cases: dom.clEdge.value.trim(),
            deploy_target: dom.clTarget.value,
            constraints: dom.clConstraints.value.trim(),
        };
        dom.clSubmit.disabled = true;
        try {
            await api("/api/close-loop", { method: "POST", body: { answers } });
            state.closeLoop.stage = "running";
            state.closeLoop.ran = true;
            dom.clForm.hidden = true;
            setCloseLoopText(
                "Close-the-Loop started — autonomous execution in progress.",
            );
        } catch (err) {
            setCloseLoopText(`Could not start the loop: ${err.message}`);
        } finally {
            dom.clSubmit.disabled = false;
        }
    });

    const connect = document.querySelector("polli-connect");
    if (connect) {
        connect.addEventListener("change", async () => {
            const apiKey = connect.apiKey;
            if (apiKey) {
                try {
                    await api("/api/auth", {
                        method: "POST",
                        body: { apiKey },
                    });
                    flashNote("Signed in to Pollinations.");
                } catch (err) {
                    flashNote(`Sign-in failed: ${err.message}`);
                }
                await fetchSession();
            } else {
                state.identity = null;
                renderIdentity();
                flashNote(
                    "Signed out — session view cleared. The key is never stored by this page.",
                );
            }
        });
    }
}

// ---------------------------------------------------------------- boot

function init() {
    const missing = Object.entries(dom)
        .filter(([, node]) => !node)
        .map(([key]) => key);
    if (missing.length > 0) {
        console.error(
            `Agent Ground dashboard: missing element(s): ${missing.join(", ")}`,
        );
        return;
    }
    bindActions();
    renderAll();
    connectWs();
    fetchSession();
    setInterval(fetchSession, POLL_MS);
}

init();
