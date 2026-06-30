// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  BETTING: "betting",
  SHOWDOWN: "showdown",
  STANDUP: "standup",   // chair-game side mode (winner sits, last stander pays)
};
const STREETS = ["preflop", "flop", "turn", "river"];
const ACTION_MS = 30_000;       // per-action decision clock
const SHOWDOWN_AUTO_MS = 0;     // showdown waits for host NEXT (no auto)
const MAX_PLAYERS = 8;          // 8*4 hole + 3*5 board = 47 cards <= 52
const MIN_PLAYERS = 2;
const GRACE_MS = 20_000;        // keep a disconnected player's seat this long
const DEFAULT_START_STACK = 50_000;
// Selectable blind levels (host picks one; applies from the next hand).
const BLIND_LEVELS = [
  { sb: 100, bb: 200 },
  { sb: 200, bb: 300 },
  { sb: 300, bb: 500 },
];
const DEFAULT_MAX_REBUYS = 3;   // busts allowed before a player is eliminated
const CHIP = 100;               // smallest chip denomination — all amounts are multiples of this
const NUM_BOARDS = 3;
const VANISH_COUNT = 1;         // how many boards vanish at the river

const SUITS = [
  { sym: "♠", color: "black" },
  { sym: "♥", color: "red" },
  { sym: "♦", color: "red" },
  { sym: "♣", color: "black" },
];
const RANKS = [
  { v: 2, label: "2" }, { v: 3, label: "3" }, { v: 4, label: "4" },
  { v: 5, label: "5" }, { v: 6, label: "6" }, { v: 7, label: "7" },
  { v: 8, label: "8" }, { v: 9, label: "9" }, { v: 10, label: "10" },
  { v: 11, label: "J" }, { v: 12, label: "Q" }, { v: 13, label: "K" },
  { v: 14, label: "A" },
];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ ...r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ===== Hand evaluator (5-card poker) =====
const TIER_NAMES = [
  "ハイカード", "ワンペア", "ツーペア", "スリーカード",
  "ストレート", "フラッシュ", "フルハウス", "フォーカード",
  "ストレートフラッシュ", "ロイヤルフラッシュ",
];

function evaluate5(hand) {
  const ranks = hand.map(c => c.v).sort((a, b) => b - a);
  const suitsArr = hand.map(c => c.suit.sym);
  const flush = suitsArr.every(s => s === suitsArr[0]);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const sortedCounts = Object.entries(counts)
    .map(([k, v]) => ({ rank: +k, count: v }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const countVals = sortedCounts.map(c => c.count);

  let isStraight = false;
  let straightTop = 0;
  if (countVals[0] === 1) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true;
      straightTop = ranks[0];
    } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
      isStraight = true;
      straightTop = 5;
    }
  }

  let tier;
  let primary = [];
  if (flush && isStraight) {
    tier = (straightTop === 14) ? 9 : 8;
    primary = [straightTop];
  } else if (countVals[0] === 4) {
    tier = 7;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank];
  } else if (countVals[0] === 3 && countVals[1] === 2) {
    tier = 6;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank];
  } else if (flush) {
    tier = 5;
    primary = ranks;
  } else if (isStraight) {
    tier = 4;
    primary = [straightTop];
  } else if (countVals[0] === 3) {
    tier = 3;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank, sortedCounts[2].rank];
  } else if (countVals[0] === 2 && countVals[1] === 2) {
    tier = 2;
    primary = [sortedCounts[0].rank, sortedCounts[1].rank, sortedCounts[2].rank];
  } else if (countVals[0] === 2) {
    tier = 1;
    primary = sortedCounts.map(c => c.rank);
  } else {
    tier = 0;
    primary = ranks;
  }
  return { tier, primary, name: TIER_NAMES[tier] };
}

function compareHands(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  for (let i = 0; i < Math.max(a.primary.length, b.primary.length); i++) {
    const av = a.primary[i] || 0;
    const bv = b.primary[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations(arr, k) {
  const result = [];
  const n = arr.length;
  if (k > n || k < 0) return result;
  const indices = Array.from({ length: k }, (_, i) => i);
  while (true) {
    result.push(indices.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && indices[i] === n - k + i) i--;
    if (i < 0) break;
    indices[i]++;
    for (let j = i + 1; j < k; j++) indices[j] = indices[j - 1] + 1;
  }
  return result;
}

// Omaha: best 5 from EXACTLY 2 of 4 hole + EXACTLY 3 of 5 board.
function omahaBest(hole, board) {
  if (!hole || hole.length < 2 || !board || board.length < 5) return null;
  let best = null;
  let bestCards = null;
  for (const h2 of combinations(hole, 2)) {
    for (const b3 of combinations(board, 3)) {
      const ev = evaluate5([...h2, ...b3]);
      if (!best || compareHands(ev, best) > 0) {
        best = ev;
        bestCards = [...h2, ...b3];
      }
    }
  }
  return { ...best, cards: bestCards };
}

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();  // clientId -> { ws }
    this.players = new Map();   // clientId -> player record (see addPlayer)
    this.order = [];            // clientId[] in seat order (join order)
    this.phase = PHASES.LOBBY;
    this.hostId = null;

    // Host-configurable table settings (changeable between hands).
    this.blindLevel = 0;        // index into BLIND_LEVELS
    this.sb = BLIND_LEVELS[0].sb;
    this.bb = BLIND_LEVELS[0].bb;
    this.startStack = DEFAULT_START_STACK;
    this.maxRebuys = DEFAULT_MAX_REBUYS;

    // Hand state
    this.handPlayers = [];      // clientId[] dealt into the current hand (fixed for hand)
    this.buttonId = null;
    this.streetIdx = 0;         // index into STREETS
    this.boards = [[], [], []]; // three community boards
    this.vanished = [];         // board indices removed at the river
    this.deck = [];
    this.currentBet = 0;        // highest streetBet this street
    this.lastRaiseSize = this.bb;
    this.actorId = null;
    this.phaseEndAt = null;
    this.timer = null;
    this.result = null;
    this.handNo = 0;

    // Stand-up (chair game) state
    this.su = null;             // null when inactive; otherwise the round object
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    let rejectCode = 0;
    let rejectReason = "";
    if (!existing) {
      if (this.players.size >= MAX_PLAYERS) {
        rejectCode = 4030; rejectReason = "Room full";
      } else if (this.phase !== PHASES.LOBBY) {
        rejectCode = 4023; rejectReason = "Game in progress";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (rejectCode) {
      try { server.close(rejectCode, rejectReason); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing) {
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.name = name;
      existing.connected = true;
    } else {
      this.addPlayer(clientId, name);
      if (!this.hostId) this.hostId = clientId;
    }

    const prior = existing ? this.sessions.get(clientId) : null;
    this.sessions.set(clientId, { ws: server });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) this.handleDisconnect(clientId);
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    if (prior) {
      try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
    }

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  addPlayer(clientId, name) {
    this.players.set(clientId, {
      name,
      stack: this.startStack,
      hole: null,
      committed: 0,       // total chips in pot this hand (all streets)
      streetBet: 0,       // chips in this street
      folded: false,
      allIn: false,
      acted: false,       // acted this street
      inHand: false,      // dealt into the current hand
      rebuysUsed: 0,      // busts so far (eliminated once it hits maxRebuys)
      eliminated: false,
      handStartStack: this.startStack,
      connected: true,
      removeTimer: null,
    });
    this.order.push(clientId);
  }

  // ===== Connection lifecycle =====
  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    const player = this.players.get(clientId);
    if (!player) return;
    player.connected = false;

    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(clientId);
      this.broadcast();
      return;
    }

    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      // If it's their turn, fold them before removing.
      if (this.phase === PHASES.BETTING && this.actorId === clientId) {
        this.applyAction(clientId, "fold", 0);
      }
      this.removePlayer(clientId);
      if (this.players.size === 0) {
        this.clearTimer();
        this.phase = PHASES.LOBBY;
        this.result = null;
        return;
      }
      this.broadcast();
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayer(clientId) {
    const wasInHand = this.players.get(clientId)?.inHand;
    this.players.delete(clientId);
    this.order = this.order.filter(id => id !== clientId);
    this.handPlayers = this.handPlayers.filter(id => id !== clientId);
    if (this.su) {
      this.su.standing = this.su.standing.filter(id => id !== clientId);
      this.su.sat = this.su.sat.filter(id => id !== clientId);
    }
    if (this.hostId === clientId) {
      this.hostId = this.order[0] || null;
    }
    // A mid-hand departure can collapse the table to 1 — end the hand.
    if (this.phase === PHASES.BETTING && wasInHand) {
      const live = this.handPlayers.filter(id => !this.players.get(id)?.folded);
      if (live.length <= 1) this.endHand();
    }
  }

  async handleMessage(clientId, msg) {
    switch (msg.type) {
      case "ping": {
        const sess = this.sessions.get(clientId);
        if (sess) { try { sess.ws.send(JSON.stringify({ type: "pong" })); } catch {} }
        break;
      }
      case "start":
        if (clientId === this.hostId && this.phase === PHASES.LOBBY) {
          if (this.eligiblePlayers().length >= MIN_PLAYERS) this.startHand();
        }
        break;
      case "action":
        if (this.phase === PHASES.BETTING && this.actorId === clientId) {
          this.applyAction(clientId, msg.action, Number(msg.amount) || 0);
        }
        break;
      case "next":
        if (clientId === this.hostId && this.phase === PHASES.SHOWDOWN) {
          if (this.su && this.su.active) {
            if (this.su.done) this.finishStandup();   // settle the chair game
            else this.startHand();                    // next stand-up hand
          } else if (this.eligiblePlayers().length >= MIN_PLAYERS) {
            this.startHand();
          } else {
            this.resetToLobby();
          }
        }
        break;
      case "config":
        // Host adjusts table settings between hands (not mid-hand).
        if (clientId === this.hostId && this.phase !== PHASES.BETTING) {
          this.applyConfig(msg);
          this.broadcast();
        }
        break;
      case "standup_start":
        // Host launches the chair game from the lobby, between hands, or
        // straight from a finished stand-up's result screen (consecutive run).
        if (clientId === this.hostId
            && (this.phase === PHASES.LOBBY || this.phase === PHASES.SHOWDOWN)
            && !(this.su && this.su.active && !this.su.done)) {
          this.startStandup(Number(msg.amount) || 0);
        }
        break;
    }
  }

  applyConfig(msg) {
    if (Number.isInteger(msg.blindLevel) && BLIND_LEVELS[msg.blindLevel]) {
      this.blindLevel = msg.blindLevel;
      this.sb = BLIND_LEVELS[msg.blindLevel].sb;
      this.bb = BLIND_LEVELS[msg.blindLevel].bb;
    }
    // Rebuy cap is only settable before the game starts (the very first hand).
    if (this.handNo === 0
        && Number.isInteger(msg.maxRebuys) && msg.maxRebuys >= 0 && msg.maxRebuys <= 99) {
      this.maxRebuys = msg.maxRebuys;
    }
  }

  // ===== Hand setup =====
  eligiblePlayers() {
    // Players with chips left who aren't eliminated, in seat order.
    return this.order.filter(id => {
      const p = this.players.get(id);
      return p && p.stack > 0 && !p.eliminated;
    });
  }

  startHand() {
    const su = this.su && this.su.active ? this.su : null;
    // In a stand-up, EVERY participant is dealt into every hand (even those who
    // already sat / are safe) — only the "standing" set decides the loser.
    const eligible = su
      ? su.participants.filter(id => {
          const p = this.players.get(id);
          return p && p.stack > 0 && !p.eliminated;
        })
      : this.eligiblePlayers();
    if (eligible.length < MIN_PLAYERS) {
      if (su) {
        // Can't deal another chair-game hand — settle with whoever's left.
        su.done = true;
        su.loser = su.standing[0] || eligible[0] || null;
        this.computeStandupBounty();
        this.applyStandupBounty();
        su.totalNets = {};
        for (const id of su.participants) {
          const p = this.players.get(id);
          if (p) su.totalNets[id] = p.stack - su.startStacks[id];
        }
        this.finishStandup();
        return;
      }
      this.resetToLobby();
      return;
    }

    this.phase = PHASES.BETTING;
    this.result = null;
    this.handNo++;
    if (su) su.roundNo++;
    this.handPlayers = eligible.slice();
    this.boards = [[], [], []];
    this.vanished = [];
    this.streetIdx = 0;
    this.deck = buildDeck();

    // Advance button to the next eligible seat.
    this.buttonId = this.nextEligibleButton();

    for (const id of this.handPlayers) {
      const p = this.players.get(id);
      p.hole = [this.deck.pop(), this.deck.pop(), this.deck.pop(), this.deck.pop()];
      p.committed = 0;
      p.streetBet = 0;
      p.folded = false;
      p.allIn = false;
      p.acted = false;
      p.inHand = true;
      p.handStartStack = p.stack;
    }

    const n = this.handPlayers.length;
    const btnIdx = this.handPlayers.indexOf(this.buttonId);
    let sbIdx, bbIdx, firstIdx;
    if (n === 2) {
      // Heads-up: button is the small blind and acts first preflop.
      sbIdx = btnIdx;
      bbIdx = (btnIdx + 1) % n;
      firstIdx = btnIdx;
    } else {
      sbIdx = (btnIdx + 1) % n;
      bbIdx = (btnIdx + 2) % n;
      firstIdx = (btnIdx + 3) % n;
    }

    this.postBlind(this.handPlayers[sbIdx], this.sb);
    this.postBlind(this.handPlayers[bbIdx], this.bb);
    this.currentBet = this.bb;
    this.lastRaiseSize = this.bb;

    // First actor must be live (not all-in from a short blind).
    this.actorId = this.firstLiveFrom(firstIdx);
    if (this.actorId === null) {
      // Everyone is all-in from blinds — run it out.
      this.runOut();
    } else {
      this.startActionTimer();
    }
    this.broadcast();
  }

  nextEligibleButton() {
    const eligible = this.handPlayers;
    if (!this.buttonId || !eligible.includes(this.buttonId)) {
      // Find first eligible at/after the previous button's seat in global order.
      if (this.buttonId) {
        const start = this.order.indexOf(this.buttonId);
        for (let i = 1; i <= this.order.length; i++) {
          const id = this.order[(start + i) % this.order.length];
          if (eligible.includes(id)) return id;
        }
      }
      return eligible[0];
    }
    const idx = eligible.indexOf(this.buttonId);
    return eligible[(idx + 1) % eligible.length];
  }

  postBlind(id, amount) {
    const p = this.players.get(id);
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.streetBet = pay;
    p.committed += pay;
    if (p.stack === 0) p.allIn = true;
  }

  // ===== Pot helpers =====
  potTotal() {
    let sum = 0;
    for (const id of this.handPlayers) sum += this.players.get(id).committed;
    return sum;
  }

  // Pot-limit action envelope for the current actor.
  actionOptions(id) {
    const p = this.players.get(id);
    const toCall = Math.max(0, this.currentBet - p.streetBet);
    const callAmt = Math.min(toCall, p.stack);
    const canCheck = toCall === 0;
    const pot = this.potTotal();
    // Max raise (pot-limit): call, then raise by the size of the resulting pot.
    const maxRaiseTo = this.currentBet + pot + toCall;
    const maxByStack = p.streetBet + p.stack; // shove ceiling
    const cappedMaxTo = Math.min(maxRaiseTo, maxByStack);
    // Min raise: at least one previous raise increment over the current bet.
    let minRaiseTo = this.currentBet === 0
      ? Math.min(this.bb, maxByStack)                         // opening bet
      : this.currentBet + this.lastRaiseSize;                 // re-raise
    minRaiseTo = Math.min(minRaiseTo, cappedMaxTo);
    // Can raise only if the player has chips beyond the call.
    const canRaise = p.stack > toCall && cappedMaxTo > this.currentBet;
    return {
      toCall: callAmt,
      canCheck,
      canRaise,
      minRaiseTo,
      maxRaiseTo: cappedMaxTo,
      currentBet: this.currentBet,
      stack: p.stack,
      pot,
    };
  }

  // ===== Actions =====
  applyAction(id, action, amount) {
    const p = this.players.get(id);
    if (!p || p.folded || p.allIn) return;
    const opt = this.actionOptions(id);

    if (action === "fold") {
      p.folded = true;
      p.acted = true;
    } else if (action === "check") {
      if (!opt.canCheck) return;
      p.acted = true;
    } else if (action === "call") {
      const pay = opt.toCall;
      p.stack -= pay;
      p.streetBet += pay;
      p.committed += pay;
      p.acted = true;
      if (p.stack === 0) p.allIn = true;
    } else if (action === "raise" || action === "bet") {
      if (!opt.canRaise) return;
      // Target total street bet, snapped to the chip unit. Clamp to [min, max];
      // an all-in below min is allowed.
      let target = Math.round(amount / CHIP) * CHIP;
      const shove = p.streetBet + p.stack;
      if (target >= shove) target = shove;            // all-in
      else if (target < opt.minRaiseTo) target = opt.minRaiseTo;
      if (target > opt.maxRaiseTo) target = opt.maxRaiseTo;
      const pay = target - p.streetBet;
      if (pay <= 0) return;
      const raiseSize = target - this.currentBet;
      p.stack -= pay;
      p.streetBet = target;
      p.committed += pay;
      if (p.stack === 0) p.allIn = true;
      // A full raise re-opens the action; a short all-in raise does not
      // reset the min-raise increment but still requires a response.
      if (raiseSize >= this.lastRaiseSize) this.lastRaiseSize = raiseSize;
      this.currentBet = target;
      for (const oid of this.handPlayers) {
        const op = this.players.get(oid);
        if (oid !== id && !op.folded && !op.allIn) op.acted = false;
      }
      p.acted = true;
    } else {
      return;
    }

    this.clearTimer();
    this.advance();
  }

  advance() {
    // Hand ends if only one player remains.
    const live = this.handPlayers.filter(id => !this.players.get(id).folded);
    if (live.length <= 1) { this.endHand(); return; }

    const actable = this.handPlayers.filter(id => {
      const p = this.players.get(id);
      return !p.folded && !p.allIn;
    });
    const roundComplete = actable.every(id => {
      const p = this.players.get(id);
      return p.acted && p.streetBet === this.currentBet;
    });

    if (!roundComplete) {
      this.actorId = this.nextLiveAfter(this.actorId);
      if (this.actorId === null) { this.endHand(); return; }
      this.startActionTimer();
      this.broadcast();
      return;
    }

    // Street complete.
    if (this.streetIdx >= STREETS.length - 1) { this.endHand(); return; }
    this.advanceStreet();
  }

  advanceStreet() {
    this.streetIdx++;
    const street = STREETS[this.streetIdx];

    if (street === "flop") {
      for (const b of this.boards) b.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (street === "turn") {
      for (const b of this.boards) b.push(this.deck.pop());
    } else if (street === "river") {
      for (const b of this.boards) b.push(this.deck.pop());
      // River Vanish: lowest river card removes its board from contention.
      this.vanished = this.pickVanished();
    }

    // Reset street betting.
    for (const id of this.handPlayers) {
      const p = this.players.get(id);
      p.streetBet = 0;
      if (!p.folded && !p.allIn) p.acted = false;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bb;

    const actable = this.handPlayers.filter(id => {
      const p = this.players.get(id);
      return !p.folded && !p.allIn;
    });
    if (actable.length <= 1) {
      // No more betting possible — deal the rest, then show down.
      if (this.streetIdx >= STREETS.length - 1) { this.endHand(); return; }
      this.advanceStreet();
      return;
    }

    const btnIdx = this.handPlayers.indexOf(this.buttonId);
    this.actorId = this.firstLiveFrom((btnIdx + 1) % this.handPlayers.length);
    this.startActionTimer();
    this.broadcast();
  }

  // Deal every remaining street with no betting (all-in run-out).
  runOut() {
    while (this.streetIdx < STREETS.length - 1) {
      this.streetIdx++;
      const street = STREETS[this.streetIdx];
      if (street === "flop") {
        for (const b of this.boards) b.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      } else if (street === "turn") {
        for (const b of this.boards) b.push(this.deck.pop());
      } else if (street === "river") {
        for (const b of this.boards) b.push(this.deck.pop());
        this.vanished = this.pickVanished();
      }
    }
    this.endHand();
  }

  // River Vanish: the board whose RIVER card is the lowest disappears.
  // Lowest by rank; ties broken by suit using the standard high-card order
  // (♠ > ♥ > ♦ > ♣), exactly like deciding the button — so the lowest suit
  // is ♣.
  pickVanished() {
    const suitRank = { "♠": 4, "♥": 3, "♦": 2, "♣": 1 };
    const riverVal = (bi) => {
      const c = this.boards[bi][4];
      return c.v * 10 + suitRank[c.suit.sym];
    };
    let worst = 0;
    for (let i = 1; i < NUM_BOARDS; i++) {
      if (riverVal(i) < riverVal(worst)) worst = i;
    }
    const out = [worst];
    if (VANISH_COUNT > 1) {
      const rest = [0, 1, 2].filter(i => i !== worst).sort((a, b) => riverVal(a) - riverVal(b));
      out.push(...rest.slice(0, VANISH_COUNT - 1));
    }
    return out.sort((a, b) => a - b);
  }

  survivingBoards() {
    const out = [];
    for (let i = 0; i < NUM_BOARDS; i++) {
      if (!this.vanished.includes(i)) out.push(i);
    }
    return out;
  }

  firstLiveFrom(idx) {
    const n = this.handPlayers.length;
    for (let i = 0; i < n; i++) {
      const id = this.handPlayers[(idx + i) % n];
      const p = this.players.get(id);
      if (!p.folded && !p.allIn) return id;
    }
    return null;
  }

  nextLiveAfter(id) {
    const n = this.handPlayers.length;
    const start = this.handPlayers.indexOf(id);
    if (start < 0) return null;
    for (let i = 1; i <= n; i++) {
      const nid = this.handPlayers[(start + i) % n];
      const p = this.players.get(nid);
      if (!p.folded && !p.allIn) return nid;
    }
    return null;
  }

  // ===== Showdown / pot distribution =====
  endHand() {
    this.clearTimer();
    this.phase = PHASES.SHOWDOWN;
    this.actorId = null;
    this.phaseEndAt = null;

    const contenders = this.handPlayers.filter(id => !this.players.get(id).folded);
    const survivors = this.survivingBoards();
    const boardComplete = this.boards[0].length === 5;

    // Per-board best hands (only meaningful at a complete river showdown).
    const boardResults = [];
    if (contenders.length > 1 && boardComplete) {
      for (const bi of survivors) {
        const board = this.boards[bi];
        const handsById = {};
        for (const id of contenders) {
          handsById[id] = omahaBest(this.players.get(id).hole, board);
        }
        boardResults.push({ board: bi, handsById });
      }
    }

    const winnings = {};
    for (const id of this.handPlayers) winnings[id] = 0;

    if (contenders.length === 1) {
      // Uncontested — sole survivor scoops the whole pot.
      winnings[contenders[0]] = this.potTotal();
    } else {
      const pots = this.buildSidePots();
      const numBoards = survivors.length;
      for (const pot of pots) {
        // Work in whole chips (units of CHIP) so every payout is a multiple
        // of the smallest denomination. Split each side pot across the
        // surviving boards; leftover chips go to the earlier boards.
        const potChips = Math.round(pot.amount / CHIP);
        const baseChips = Math.floor(potChips / numBoards);
        let remChips = potChips - baseChips * numBoards;
        survivors.forEach((bi) => {
          let shareChips = baseChips + (remChips > 0 ? 1 : 0);
          if (remChips > 0) remChips -= 1;
          if (shareChips <= 0) return;
          const br = boardResults.find(r => r.board === bi);
          const eligible = pot.eligible.filter(id => !this.players.get(id).folded);
          if (eligible.length === 0 || !br) return;
          // Winners on this board among eligible contenders.
          let best = null;
          let winners = [];
          for (const id of eligible) {
            const h = br.handsById[id];
            if (!h) continue;
            if (!best || compareHands(h, best) > 0) { best = h; winners = [id]; }
            else if (compareHands(h, best) === 0) winners.push(id);
          }
          if (winners.length === 0) return;
          const perChips = Math.floor(shareChips / winners.length);
          let oddChips = shareChips - perChips * winners.length;
          // Earliest seat after the button collects the odd chip(s).
          const ordered = this.seatOrderFromButton(winners);
          for (const id of ordered) {
            winnings[id] += (perChips + (oddChips > 0 ? 1 : 0)) * CHIP;
            if (oddChips > 0) oddChips -= 1;
          }
        });
      }
    }

    // Apply winnings.
    for (const id of this.handPlayers) {
      this.players.get(id).stack += winnings[id];
    }

    // Net chip change this hand, captured BEFORE any rebuy resets the stack.
    const nets = Object.fromEntries(this.handPlayers.map(id => {
      const p = this.players.get(id);
      return [id, p.stack - p.handStartStack];
    }));

    // Busted players: rebuy if any rebuys remain, otherwise eliminate.
    const busted = [];     // rebought this hand
    const eliminated = []; // out of rebuys — eliminated this hand
    for (const id of this.handPlayers) {
      const p = this.players.get(id);
      if (p.stack <= 0 && !p.eliminated) {
        if (p.rebuysUsed < this.maxRebuys) {
          p.rebuysUsed += 1;
          p.stack = this.startStack;          // rebuy back to the starting stack
          busted.push(id);
        } else {
          p.eliminated = true;                // no rebuys left — sit out the rest
          p.stack = 0;
          eliminated.push(id);
        }
      }
    }

    // Stand-up: sit the hand's winners and settle if one player remains.
    if (this.su && this.su.active) this.standupAfterHand(winnings, nets);

    this.result = {
      boards: this.boards,
      vanished: this.vanished,
      survivors,
      uncontested: contenders.length === 1,
      contenders,
      winnings,
      busted,
      eliminated,
      boardWinners: boardResults.map(r => {
        let best = null;
        let winners = [];
        for (const id of contenders) {
          const h = r.handsById[id];
          if (!h) continue;
          if (!best || compareHands(h, best) > 0) { best = h; winners = [id]; }
          else if (compareHands(h, best) === 0) winners.push(id);
        }
        return {
          board: r.board,
          winners,
          hands: Object.fromEntries(
            Object.entries(r.handsById).map(([id, h]) => [id, h ? { name: h.name, cards: h.cards } : null])
          ),
        };
      }),
      hands: Object.fromEntries(contenders.map(id => [id, this.players.get(id).hole])),
      stacks: Object.fromEntries(this.handPlayers.map(id => [id, this.players.get(id).stack])),
      nets,
      pot: this.potTotal(),
      standup: this.su && this.su.active ? {
        amount: this.su.amount,
        roundNo: this.su.roundNo,
        sat: this.su.sat.slice(),
        standing: this.su.standing.slice(),
        lastSat: this.su.lastSat.slice(),
        done: this.su.done,
        loser: this.su.loser,
        payouts: { ...this.su.payouts },
        loserPays: this.su.loserPays,
        totalNets: { ...this.su.totalNets },
        participants: this.su.participants.slice(),
      } : null,
    };
    for (const id of this.handPlayers) this.players.get(id).inHand = false;
    this.broadcast();
  }

  // Layered side pots from per-player commitments. Folded chips stay in but
  // their owners are not eligible to win.
  buildSidePots() {
    const contribs = this.handPlayers
      .map(id => ({ id, amt: this.players.get(id).committed, folded: this.players.get(id).folded }))
      .filter(c => c.amt > 0);
    const levels = [...new Set(contribs.map(c => c.amt))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      const delta = level - prev;
      const inLayer = contribs.filter(c => c.amt >= level);
      const amount = delta * inLayer.length;
      const eligible = inLayer.filter(c => !c.folded).map(c => c.id);
      if (amount > 0) {
        const last = pots[pots.length - 1];
        if (last && sameSet(last.eligible, eligible)) last.amount += amount;
        else pots.push({ amount, eligible });
      }
      prev = level;
    }
    return pots;
  }

  seatOrderFromButton(ids) {
    const n = this.handPlayers.length;
    const btnIdx = this.handPlayers.indexOf(this.buttonId);
    const set = new Set(ids);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const id = this.handPlayers[(btnIdx + i) % n];
      if (set.has(id)) out.push(id);
    }
    return out;
  }

  // freshGame=true restores everyone to a clean starting stack (new game).
  // freshGame=false just returns to the lobby and KEEPS current chips — used
  // after a stand-up so its payout survives.
  resetToLobby(freshGame = true) {
    this.phase = PHASES.LOBBY;
    this.clearTimer();
    this.actorId = null;
    this.phaseEndAt = null;
    this.boards = [[], [], []];
    this.vanished = [];
    this.handPlayers = [];
    this.su = null;
    if (freshGame) this.handNo = 0;   // a new game re-opens the rebuy setting
    for (const p of this.players.values()) {
      p.hole = null;
      p.folded = false;
      p.allIn = false;
      p.inHand = false;
      p.committed = 0;
      p.streetBet = 0;
      if (freshGame) {
        p.stack = this.startStack;
        p.rebuysUsed = 0;
        p.eliminated = false;
      }
    }
    this.broadcast();
  }

  // ===== Stand-up (chair game) =====
  // Played as a series of NORMAL triple-board pot-limit hands (chips move for
  // real). After each hand, everyone who WON chips sits down (safe) and drops
  // out of the standing pool. Repeat among the rest until one player is left
  // standing — the loser, who then pays the fixed amount to every player who
  // managed to sit. (See startHand/endHand for the per-hand hooks.)
  startStandup(amount) {
    const amt = Math.max(CHIP, Math.round((amount || 0) / CHIP) * CHIP);
    const players = this.eligiblePlayers();
    if (players.length < 2) return;
    // Remember each participant's stack at the start so we can report the
    // whole chair game's net swing (all hands + the final bounty) at the end.
    const startStacks = {};
    for (const id of players) startStacks[id] = this.players.get(id).stack;
    this.su = {
      active: true,
      amount: amt,
      standing: players.slice(),   // still standing, in seat order
      sat: [],                     // sat down (won a hand), in sit order
      lastSat: [],                 // who sat in the most recent hand
      participants: players.slice(),
      startStacks,
      roundNo: 0,
      done: false,
      loser: null,
      payouts: {},                 // id -> chips owed to them by the loser
      loserPays: 0,
      totalNets: {},               // id -> net swing over the whole stand-up
    };
    this.startHand();              // first chair-game hand among the standers
  }

  // Called from endHand once a stand-up hand resolves: sit the winners and,
  // if only one player is left standing, finish the chair game (apply bounty).
  standupAfterHand(winnings, nets) {
    const su = this.su;
    // Everyone is dealt, but only STANDING players who won chips this hand sit
    // down (safe). Already-safe players who win again don't change the pool.
    let newlySat = su.standing.filter(id => (winnings[id] || 0) > 0);
    // Guaranteed progress: if no standing player won a pot (it all went to
    // already-safe players), the standing player(s) who did best this hand sit
    // anyway, so the chair game always converges.
    if (newlySat.length === 0 && su.standing.length > 1) {
      let bestNet = -Infinity;
      for (const id of su.standing) bestNet = Math.max(bestNet, (nets?.[id] ?? 0));
      newlySat = su.standing.filter(id => (nets?.[id] ?? 0) === bestNet);
      // Don't let the whole pool sit at once (that would leave no loser).
      if (newlySat.length >= su.standing.length) newlySat = newlySat.slice(0, su.standing.length - 1);
    }
    // Chop tiebreak: if every standing player won chips (they'd ALL sit and
    // leave no loser — e.g. the last two split the two boards), the player who
    // "took the LOWER board" loses. Lower = the bottom-most surviving board
    // (highest index); whoever made the strongest Omaha hand on it is the loser
    // and stays standing. Everyone else sits. Exact tie there → genuine draw.
    if (newlySat.length > 1 && newlySat.length === su.standing.length) {
      const survivors = this.survivingBoards();
      const lowerBoard = this.boards[Math.max(...survivors)];
      if (lowerBoard && lowerBoard.length === 5) {
        let best = null;
        let losers = [];
        for (const id of su.standing) {
          const h = omahaBest(this.players.get(id).hole, lowerBoard);
          if (!h) continue;
          if (!best || compareHands(h, best) > 0) { best = h; losers = [id]; }
          else if (compareHands(h, best) === 0) losers.push(id);
        }
        if (losers.length === 1) newlySat = su.standing.filter(id => id !== losers[0]);
      }
    }
    su.lastSat = newlySat.slice();
    for (const id of newlySat) su.sat.push(id);
    const newlySatSet = new Set(newlySat);
    su.standing = su.standing.filter(id => {
      const p = this.players.get(id);
      return p && !p.eliminated && !newlySatSet.has(id);
    });
    if (su.standing.length <= 1) {
      su.done = true;
      su.loser = su.standing[0] || null;   // null = everyone won out (draw)
      this.computeStandupBounty();
      this.applyStandupBounty();
      // Net swing across the whole stand-up (now that the bounty is applied).
      su.totalNets = {};
      for (const id of su.participants) {
        const p = this.players.get(id);
        if (p) su.totalNets[id] = p.stack - su.startStacks[id];
      }
    }
  }

  // Compute (but don't yet apply) what the lone loser owes each sat player.
  computeStandupBounty() {
    const su = this.su;
    su.payouts = {};
    su.loserPays = 0;
    if (!su.loser || su.sat.length === 0) return;
    const loser = this.players.get(su.loser);
    const winners = su.sat.slice();
    const owed = su.amount * winners.length;
    const avail = loser.stack;
    if (avail >= owed) {
      for (const id of winners) su.payouts[id] = su.amount;
      su.loserPays = owed;
    } else {
      // Short loser: split what they have, in chip units, by sit order.
      const availChips = Math.floor(avail / CHIP);
      const per = Math.floor(availChips / winners.length);
      let odd = availChips - per * winners.length;
      let paid = 0;
      for (const id of winners) {
        const amt = (per + (odd > 0 ? 1 : 0)) * CHIP;
        if (odd > 0) odd -= 1;
        su.payouts[id] = amt;
        paid += amt;
      }
      su.loserPays = paid;
    }
  }

  // Move the bounty chips: loser pays each sat player; a busted loser rebuys
  // or is eliminated just like in the cash game.
  applyStandupBounty() {
    const su = this.su;
    if (!su || !su.loser) return;
    const loser = this.players.get(su.loser);
    if (!loser) return;
    loser.stack -= su.loserPays;
    for (const [id, amt] of Object.entries(su.payouts)) {
      const w = this.players.get(id);
      if (w) w.stack += amt;
    }
    if (loser.stack <= 0 && !loser.eliminated) {
      if (loser.rebuysUsed < this.maxRebuys) {
        loser.rebuysUsed += 1;
        loser.stack = this.startStack;
      } else {
        loser.eliminated = true;
        loser.stack = 0;
      }
    }
  }

  // End the chair game and CONTINUE the cash game straight away (the bounty is
  // already applied). Falls back to a fresh lobby only if too few remain.
  finishStandup() {
    this.su = null;
    if (this.eligiblePlayers().length >= MIN_PLAYERS) this.startHand();
    else this.resetToLobby(true);
  }

  // ===== Timers =====
  startActionTimer() {
    this.clearTimer();
    this.phaseEndAt = Date.now() + ACTION_MS;
    this.timer = setTimeout(() => this.timeoutAction(), ACTION_MS);
  }

  timeoutAction() {
    const id = this.actorId;
    if (!id || this.phase !== PHASES.BETTING) return;
    const opt = this.actionOptions(id);
    this.applyAction(id, opt.canCheck ? "check" : "fold", 0);
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.phaseEndAt = null;
  }

  // ===== Broadcast / views =====
  broadcast() {
    for (const [id, session] of this.sessions) {
      try {
        session.ws.send(JSON.stringify(this.viewForPlayer(id)));
      } catch {}
    }
  }

  viewForPlayer(viewerId) {
    const showdown = this.phase === PHASES.SHOWDOWN;
    const players = this.order.map(id => {
      const p = this.players.get(id);
      const isYou = id === viewerId;
      let hole = null;
      if (isYou && p.hole) hole = p.hole;
      else if (showdown && p.inHand === false && this.result && this.result.contenders?.includes(id)) {
        hole = this.result.hands[id] || null;
      }
      return {
        id,
        name: p.name,
        stack: p.stack,
        streetBet: p.streetBet,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        connected: p.connected,
        rebuysUsed: p.rebuysUsed,
        eliminated: p.eliminated,
        isYou,
        hole,
      };
    });

    const boardsView = this.phase === PHASES.LOBBY ? [[], [], []] : this.boards;

    const view = {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: viewerId,
        buttonId: this.buttonId,
        boards: boardsView,
        vanished: this.vanished,
        street: STREETS[this.streetIdx],
        pot: this.phase === PHASES.LOBBY ? 0 : this.potTotal(),
        currentBet: this.currentBet,
        actorId: this.phase === PHASES.BETTING ? this.actorId : null,
        phaseEndAt: this.phaseEndAt,
        config: {
          sb: this.sb, bb: this.bb, blindLevel: this.blindLevel,
          blindLevels: BLIND_LEVELS, startStack: this.startStack,
          maxPlayers: MAX_PLAYERS, maxRebuys: this.maxRebuys,
        },
        handNo: this.handNo,
        result: showdown ? this.result : null,
        // Live stand-up context (present whenever a chair game is running, so
        // the betting + showdown screens can show round / sat / standing).
        standup: this.su && this.su.active ? {
          amount: this.su.amount,
          roundNo: this.su.roundNo,
          standing: this.su.standing,
          sat: this.su.sat,
          lastSat: this.su.lastSat,
          done: this.su.done,
          loser: this.su.loser,
          payouts: this.su.payouts,
          loserPays: this.su.loserPays,
        } : null,
      },
    };

    // Attach action options only for the player to act.
    if (this.phase === PHASES.BETTING && this.actorId === viewerId) {
      view.state.options = this.actionOptions(viewerId);
    }
    return view;
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}
