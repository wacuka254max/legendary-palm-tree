/**
 * EVIE — the simulator's Deriv.
 *
 * The simulation is NOT a second copy of the analysis page. analyss.html loads
 * the very same app.js, bot.js, session.js, txn.js and analyser.js the real
 * page does; the only thing swapped underneath them is this file, which stands
 * in for deriv.js and for the WebSocket it would have opened.
 *
 * That is the whole design. A forked page would drift from the real one within
 * a week and would prove nothing about it. A fake server cannot drift: if a
 * trade works here, the same code made it work.
 *
 * ── How an outcome is arranged ──────────────────────────────────────────────
 *
 * The honest way, and the only one that keeps the screen consistent with
 * itself: the sim does not decide "you lost" and then write a losing number in
 * the ledger. It decides which side should win, and then CHOOSES THE SETTLING
 * TICK so that the contract genuinely settles that way.
 *
 * A scripted loss on Even really does land on an odd digit. That digit goes
 * into the same stream the analysis panel is reading, so the percentages, the
 * digit grid, the entry and exit spots and the transaction all agree — exactly
 * as they would if Deriv had sent it. Nothing on screen has to be special-
 * cased, because nothing on screen is being lied to.
 *
 * Prices are otherwise a plain random walk per symbol, at the same tick a
 * second the real feed runs at and with each index's own decimal places.
 *
 * ── The payout ──────────────────────────────────────────────────────────────
 *
 * One formula rather than a table: a fair payout is stake / probability, and
 * the house keeps a slice. At a 2.5% edge that lands on 1.95x for Even/Odd and
 * Rise/Fall, ~9.75x for Matches and ~1.08x for Differs — close enough to
 * Deriv's real board for a recovery ladder to behave the way it will live.
 */

(function (global) {
  "use strict";

  var DECIMALS = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2 };
  var START = { R_10: 6500, R_25: 2400, R_50: 240, R_75: 95000, R_100: 1200 };
  var VOL = { R_10: 0.10, R_25: 0.25, R_50: 0.50, R_75: 0.75, R_100: 1.00 };

  /* Volatility 10 through 100 tick every TWO seconds. Only the 1s variants —
     which this page deliberately does not carry — tick every second. Generating
     one a second ran the whole simulation at double speed: a one-tick contract
     settled in half the time it can, and the bot looked twice as quick as it
     will ever be. */
  var TICK_MS = 2000;
  var EDGE = 0.025;

  /* No app markup here.

     Deriv's markup — a percentage of the payout, deducted from it — is set on
     the app registration and applied by Deriv, not by this page. Charging it in
     the simulator on top of that would either double it or invent one that is
     not configured, and either way the practice numbers would stop matching the
     demo account they are meant to be checked against.

     The margin already in the payout below is Deriv's own pricing, which is a
     different thing and does belong here. */

  /* Deriv caps what a single contract can return. */
  var MAX_PAYOUT = 50000;

  /* Nothing on a network is instant, and a simulator that answers in the same
     millisecond teaches the wrong rhythm: trades appear to fire in a burst and
     a bot looks faster than it can ever be. Every reply waits the way a real
     round trip does. */
  function latency() { return 120 + Math.floor(Math.random() * 260); }

  /* ── the plan: which trades lose ─────────────────────────────────────────
   *
   * Read once at start-up and then simply asked, trade after trade, "does this
   * one lose?". Three shapes, and the first trade can be forced to lose on top
   * of any of them.
   */

  var CFG_KEY = "evie_sim_config";

  function config() {
    var d = {
      balance: 1000,
      currency: "USD",
      mode: "none",     // none | consecutive | random
      count: 3,         // losses in the run, or losses per 10 trades
      firstLoss: false
    };
    try {
      var raw = JSON.parse(sessionStorage.getItem(CFG_KEY) || "null");
      if (raw) Object.keys(d).forEach(function (k) { if (raw[k] !== undefined) d[k] = raw[k]; });
    } catch (e) {}
    return d;
  }

  function Plan(cfg) {
    this.cfg = cfg;
    this.n = 0;          // trades placed so far
    this.runLeft = 0;    // losses still owed by a consecutive run
    this.runDone = false;
    this.block = [];     // the shuffled ten that random mode deals from
  }

  Plan.prototype.loses = function () {
    var cfg = this.cfg;
    var first = this.n === 0;
    this.n++;

    if (first && cfg.firstLoss) {
      // The forced first loss IS the start of the run, not an extra one.
      if (cfg.mode === "consecutive") {
        this.runLeft = Math.max(0, cfg.count - 1);
        this.runDone = true;
      }
      return true;
    }

    if (cfg.mode === "none") return false;

    if (cfg.mode === "consecutive") {
      if (this.runLeft > 0) { this.runLeft--; return true; }
      if (this.runDone) return false;          // the drawdown has been and gone
      /* Without a forced first loss the run starts on the second trade, so
         there is a win to lose from — which is the case worth watching. */
      if (this.n >= 2 && cfg.count > 0) {
        this.runDone = true;
        this.runLeft = Math.max(0, cfg.count - 1);
        return true;
      }
      return false;
    }

    /* Random: n losses in every ten, shuffled, so the count is exact over a
       block rather than merely likely. */
    if (!this.block.length) {
      var k = Math.max(0, Math.min(10, Math.round(cfg.count)));
      var i;
      for (i = 0; i < 10; i++) this.block.push(i < k);
      for (i = this.block.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = this.block[i]; this.block[i] = this.block[j]; this.block[j] = t;
      }
    }
    return this.block.shift();
  };

  /* ── prices ──────────────────────────────────────────────────────────── */

  function Market(sym) {
    this.sym = sym;
    this.dec = DECIMALS[sym] != null ? DECIMALS[sym] : 2;
    this.price = START[sym] || 1000;
    this.vol = (VOL[sym] || 1) * (START[sym] || 1000) / 5000;
  }

  Market.prototype.round = function (v) { return Number(Number(v).toFixed(this.dec)); };

  Market.prototype.step = function () {
    // A plain random walk, roughly gaussian so the tape is not a sawtooth.
    var g = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    this.price = Math.max(this.price * 0.5, this.price + g * this.vol);
    return this.round(this.price);
  };

  /** The smallest step this index quotes — one unit in its last place. */
  Market.prototype.tickSize = function () { return Math.pow(10, -this.dec); };

  /**
   * Move a quote so its LAST DIGIT is the one we need, changing the price as
   * little as possible. This is what makes a scripted outcome real rather than
   * declared: the tick that settles the contract is the tick everyone sees.
   */
  Market.prototype.withDigit = function (quote, digit) {
    var unit = this.tickSize();
    var scaled = Math.round(quote / unit);          // whole units of last place
    var have = ((scaled % 10) + 10) % 10;
    var delta = digit - have;
    // The nearest quote carrying that digit: at most five steps either way.
    if (delta > 5) delta -= 10;
    if (delta < -5) delta += 10;
    return this.round((scaled + delta) * unit);
  };

  /* ── which digit settles a contract the way we want ──────────────────── */

  function all() { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; }

  var WINNERS = {
    DIGITEVEN: function () { return [0, 2, 4, 6, 8]; },
    DIGITODD: function () { return [1, 3, 5, 7, 9]; },
    DIGITMATCH: function (b) { return [b]; },
    DIGITDIFF: function (b) { return all().filter(function (d) { return d !== b; }); },
    DIGITOVER: function (b) { return all().filter(function (d) { return d > b; }); },
    DIGITUNDER: function (b) { return all().filter(function (d) { return d < b; }); }
  };

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  /** The chance this contract wins on a fair digit — what the payout prices. */
  function probability(type, barrier) {
    switch (type) {
      case "DIGITMATCH": return 0.1;
      case "DIGITDIFF": return 0.9;
      case "DIGITOVER": return (9 - barrier) / 10;
      case "DIGITUNDER": return barrier / 10;
      default: return 0.5;               // Even, Odd, Rise, Fall
    }
  }

  /**
   * Deriv does not price every contract with the same margin, and one flat
   * number was the reason a trade here paid differently from the same trade on
   * demo. A fair payout is stake / probability; what Deriv actually quotes is
   * that, less a margin THAT VARIES BY CONTRACT TYPE:
   *
   *   Even / Odd        ~+95%     on an even-money bet
   *   Rise / Fall       ~+95%
   *   Differs           ~+9.7%    a near-certainty, priced very tight
   *   Matches           ~+809%    a long shot, priced widest
   *   Over / Under      between the two, by barrier
   *
   * These are calibrated to Deriv's published returns rather than invented.
   * They remain an APPROXIMATION: the live page never guesses, because every
   * real trade takes its payout from Deriv's own proposal. What matters here is
   * that a martingale ladder practised in the simulation recovers at close to
   * the rate it will recover live, instead of at a rate one flat margin made up.
   */
  var MARGIN = {
    DIGITEVEN: 0.025,
    DIGITODD: 0.025,
    CALL: 0.025,
    PUT: 0.025,
    DIGITDIFF: 0.012,
    DIGITMATCH: 0.091,
    DIGITOVER: 0.035,
    DIGITUNDER: 0.035
  };

  function payoutFor(type, barrier, stake) {
    var p = probability(type, barrier);
    if (p <= 0) p = 0.05;
    var margin = MARGIN[type] != null ? MARGIN[type] : EDGE;
    return Math.min(MAX_PAYOUT, round2(stake / p * (1 - margin)));
  }



  function round2(n) { return Math.round(n * 100) / 100; }

  /* ── the socket ──────────────────────────────────────────────────────────
   *
   * Everything above is the world; this is the part that speaks Deriv. It
   * answers the same requests session.js and app.js send, in the same shapes
   * and with the same message types — including the two-stage
   * proposal_open_contract, which is where the entry and exit spots come from.
   */

  var plan = null;
  var markets = {};
  var balance = 0;
  var currency = "USD";

  function market(sym) {
    if (!markets[sym]) markets[sym] = new Market(sym);
    return markets[sym];
  }

  function FakeSocket() {
    var self = this;
    this.readyState = 0;
    this.subs = {};         // subscription id -> { sym }
    this.timers = [];
    this.pending = [];      // contracts waiting for their settling tick
    this.props = {};
    this.contracts = {};
    this.nextId = 1;

    setTimeout(function () {
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    }, 60);
  }

  /** A reply, after the wire has taken its share of the time. */
  FakeSocket.prototype.emit = function (obj) {
    var self = this;
    var wire = JSON.stringify(obj);
    setTimeout(function () {
      if (self.readyState !== 1 || !self.onmessage) return;
      self.onmessage({ data: wire });
    }, latency());
  };

  /** Ticks are not replies — they arrive when the market says so. */
  FakeSocket.prototype.push = function (obj) {
    if (this.readyState !== 1 || !this.onmessage) return;
    this.onmessage({ data: JSON.stringify(obj) });
  };

  FakeSocket.prototype.close = function () {
    this.readyState = 3;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.onclose) this.onclose({});
  };

  FakeSocket.prototype.send = function (raw) {
    var req;
    try { req = JSON.parse(raw); } catch (e) { return; }

    if (req.ping) return this.emit({ msg_type: "ping", ping: "pong", echo_req: req });
    if (req.forget) { delete this.subs[req.forget]; return; }

    /* Two pages talk to this server and they ask for prices differently. The
       analysis page wants a window of history it can measure; Automatic AI
       wants the stream only. Same feed underneath either way. */
    if (req.ticks_history) return this.history(req);
    if (req.ticks) return this.ticks(req);

    if (req.balance) return this.balanceNow(req);
    if (req.proposal) return this.proposal(req);
    if (req.buy) return this.buy(req);
    if (req.proposal_open_contract) return this.watch(req);
  };

  /** A tick stream with no history in front of it. */
  FakeSocket.prototype.ticks = function (req) {
    var self = this;
    var sym = req.ticks;
    market(sym);                                  // exists from here on

    var id = "sub-" + (this.nextId++);
    this.subs[id] = { sym: sym };

    if (!req.subscribe) return;

    var timer = setInterval(function () {
      if (self.readyState !== 1 || !self.subs[id]) return;
      self.tick(sym);
    }, TICK_MS);
    this.timers.push(timer);
  };

  FakeSocket.prototype.balanceNow = function (req) {
    this.emit({
      msg_type: "balance",
      echo_req: req,
      balance: { balance: balance, currency: currency, loginid: ACCOUNT }
    });
  };

  FakeSocket.prototype.history = function (req) {
    var self = this;
    var sym = req.ticks_history;
    var m = market(sym);
    var count = Math.max(10, Math.min(5000, Number(req.count) || 130));

    var prices = [], times = [], now = Math.floor(Date.now() / 1000), i;
    for (i = 0; i < count; i++) { prices.push(m.step()); times.push(now - (count - i)); }

    var id = "sub-" + (this.nextId++);
    this.subs[id] = { sym: sym };

    this.emit({
      msg_type: "history",
      echo_req: req,
      history: { prices: prices, times: times },
      subscription: { id: id }
    });

    if (!req.subscribe) return;

    var timer = setInterval(function () {
      if (self.readyState !== 1) return;
      if (!self.subs[id]) return;
      self.tick(sym);
    }, TICK_MS);
    this.timers.push(timer);
  };

  /**
   * One tick, and with it whatever the contracts on this symbol are waiting for.
   *
   * A real one-tick contract is not bought and settled in the same breath. It
   * STARTS on the first tick after the purchase — that tick is the entry spot —
   * and settles on the one after it. Two ticks, about two seconds, plus the
   * round trips either side.
   *
   * The sim used to settle on the very next tick, which made a trade look like
   * it took a heartbeat and taught a pace no live account can keep. This is the
   * real shape, and it is the settling tick that is bent to the scripted
   * outcome, before anybody — the analysis panel included — sees it.
   */
  FakeSocket.prototype.tick = function (sym) {
    var self = this;
    var m = market(sym);
    var quote = m.step();

    var starting = this.pending.filter(function (c) { return c.sym === sym && !c.started; });
    var settling = this.pending.filter(function (c) { return c.sym === sym && c.started; });

    // The settling tick has to carry the digit the outcome needs.
    if (settling.length) {
      quote = this.settleQuote(settling[0], quote);
      m.price = quote;
    }

    this.push({
      msg_type: "tick",
      tick: {
        symbol: sym, quote: quote, pip_size: m.dec,
        epoch: Math.floor(Date.now() / 1000), id: sym
      }
    });

    // A contract bought a moment ago opens on this tick and lives one more.
    starting.forEach(function (c) {
      c.started = true;
      c.entry = quote;
      self.openUpdate(c);
    });

    settling.forEach(function (c) { self.settle(c, quote); });
  };

  /** Tell whoever is watching that the contract is open, and at what spot. */
  FakeSocket.prototype.openUpdate = function (c) {
    if (!c.watchId) return;                 // nobody subscribed to it yet
    var m = market(c.sym);
    this.emit({
      msg_type: "proposal_open_contract",
      subscription: { id: c.watchId },
      proposal_open_contract: {
        contract_id: c.id,
        underlying: c.sym,
        buy_price: c.price,
        payout: c.payout,
        is_sold: 0,
        entry_tick: c.entry,
        entry_tick_display_value: c.entry.toFixed(m.dec),
        current_spot: c.entry,
        current_spot_display_value: c.entry.toFixed(m.dec),
        profit: 0
      }
    });
  };

  /** The quote that makes this contract end the way the plan says. */
  FakeSocket.prototype.settleQuote = function (c, quote) {
    var m = market(c.sym);

    if (c.contract === "CALL" || c.contract === "PUT") {
      var up = (c.contract === "CALL") === c.shouldWin;
      var step = m.tickSize() * (2 + Math.floor(Math.random() * 8));
      return m.round(c.entry + (up ? step : -step));
    }

    var w = WINNERS[c.contract];
    if (!w) return quote;
    var winners = w(c.barrier);
    var wanted = c.shouldWin
      ? winners
      : all().filter(function (d) { return winners.indexOf(d) < 0; });
    if (!wanted.length) return quote;
    return m.withDigit(quote, pick(wanted));
  };

  FakeSocket.prototype.proposal = function (req) {
    var stake = Number(req.amount);
    var barrier = req.barrier == null ? null : Number(req.barrier);
    var id = "prop-" + (this.nextId++);

    this.props[id] = {
      sym: req.underlying_symbol,
      contract: req.contract_type,
      barrier: barrier,
      stake: stake
    };

    this.emit({
      msg_type: "proposal",
      echo_req: req,
      proposal: {
        id: id,
        ask_price: stake,
        payout: payoutFor(req.contract_type, barrier, stake),
        display_value: stake.toFixed(2),
        longcode: "Simulated contract."
      }
    });
  };

  FakeSocket.prototype.buy = function (req) {
    var p = this.props[req.buy];
    if (!p) {
      return this.emit({
        msg_type: "buy", echo_req: req,
        error: { code: "InvalidContractProposal", message: "That proposal has expired." }
      });
    }
    delete this.props[req.buy];

    var m = market(p.sym);
    var price = p.stake;

    /* You cannot buy what you cannot afford, and a simulator that lets you is
       worth nothing: the whole point of setting a balance of 80 is to find out
       what a 100 stake does. Deriv refuses at the buy, in these words, and so
       does this — and the martingale ladder meets that wall here for the same
       reason it will meet it live. */
    if (price > balance) {
      return this.emit({
        msg_type: "buy",
        echo_req: req,
        error: {
          code: "InsufficientBalance",
          message: "Your account balance (" + balance.toFixed(2) + " " + currency +
            ") is insufficient to buy this contract (" + price.toFixed(2) + " " + currency + ")."
        }
      });
    }

    var id = "sim-" + (this.nextId++);
    balance = round2(balance - price);

    var contract = {
      id: id,
      sym: p.sym,
      contract: p.contract,
      barrier: p.barrier,
      stake: p.stake,
      price: price,                 // what was paid for it
      payout: payoutFor(p.contract, p.barrier, p.stake),
      /* The contract has not started yet — it opens on the next tick, and that
         tick is its entry spot. Until then this is only a placeholder. */
      started: false,
      entry: m.round(m.price),
      // Decided the moment it is bought, so what settles it is already known.
      shouldWin: !plan.loses()
    };

    this.contracts[id] = contract;
    this.pending.push(contract);

    this.emit({
      msg_type: "buy",
      echo_req: req,
      buy: {
        contract_id: id,
        buy_price: price,
        balance_after: balance,
        longcode: "Simulated contract.",
        transaction_id: this.nextId++
      }
    });

    this.emit({ msg_type: "balance", balance: { balance: balance, currency: currency } });
  };

  /** The open contract, before it settles: this is where the entry spot lives. */
  FakeSocket.prototype.watch = function (req) {
    /* Without a contract id this is the blanket subscription — "tell me about
       everything on this account". Automatic AI opens one at connect and
       expects settlements to arrive down it. */
    if (!req.contract_id) { this.watchAll = true; return; }

    var c = this.contracts[req.contract_id];
    if (!c) return;
    var m = market(c.sym);
    var id = "poc-" + (this.nextId++);
    c.watchId = id;

    var poc = {
      contract_id: c.id,
      underlying: c.sym,
      buy_price: c.price,
      payout: c.payout,
      is_sold: 0,
      profit: 0
    };

    /* Before its opening tick a contract has no entry spot, and Deriv does not
       invent one. The update that carries it comes from openUpdate() the moment
       the tick lands. */
    if (c.started) {
      poc.entry_tick = c.entry;
      poc.entry_tick_display_value = c.entry.toFixed(m.dec);
      poc.current_spot = c.entry;
      poc.current_spot_display_value = c.entry.toFixed(m.dec);
    }

    this.emit({
      msg_type: "proposal_open_contract",
      echo_req: req,
      subscription: { id: id },
      proposal_open_contract: poc
    });
  };

  FakeSocket.prototype.settle = function (c, quote) {
    var m = market(c.sym);
    this.pending = this.pending.filter(function (x) { return x !== c; });

    var won = c.shouldWin;

    // A win returns the payout; a loss returns nothing at all.
    var returned = won ? c.payout : 0;
    var profit = round2(returned - c.price);
    balance = round2(balance + returned);

    /* Announced down the per-contract subscription if one was opened, and down
       the blanket one if that is what the page is using. A real Deriv sends it
       on both; the page is responsible for counting it once. */
    this.emit({
      msg_type: "proposal_open_contract",
      subscription: c.watchId ? { id: c.watchId } : undefined,
      proposal_open_contract: {
        contract_id: c.id,
        underlying: c.sym,
        buy_price: c.price,
        payout: returned,
        is_sold: 1,
        status: won ? "won" : "lost",
        profit: profit,
        entry_tick: c.entry,
        entry_tick_display_value: c.entry.toFixed(m.dec),
        exit_tick: quote,
        exit_tick_display_value: quote.toFixed(m.dec),
        current_spot: quote,
        current_spot_display_value: quote.toFixed(m.dec),
        sell_price: returned
      }
    });

    this.emit({ msg_type: "balance", balance: { balance: balance, currency: currency } });
  };

  /* ── standing in for deriv.js ────────────────────────────────────────── */

  var ACCOUNT = "SIM000001";

  function boot() {
    var cfg = config();
    plan = new Plan(cfg);
    balance = Number(cfg.balance) || 0;
    currency = cfg.currency || "USD";
  }

  boot();

  global.EvieDeriv = {
    isConnected: function () { return true; },
    requireConnection: function () { return true; },
    disconnect: function () { global.location.replace("/home.html"); },
    connect: function () { return Promise.resolve(); },
    handleRedirect: function () { return Promise.resolve(null); },

    portfolio: function () {
      return Promise.resolve({
        real: { id: ACCOUNT, amount: balance, currency: currency },
        /* An ordinary real options account, described exactly as Deriv would
           describe one. The point of the simulation is to be indistinguishable
           from the live page while you are in it — a badge reading Simulation
           and a softer warning underneath would make it a different screen to
           practise on, which is the one thing it must not be. The setup card
           on the way in is where it says what it is. */
        accounts: [{
          id: ACCOUNT, kind: "Options", demo: false,
          balance: balance, currency: currency
        }]
      });
    },

    /* session.js opens a WebSocket to whatever this resolves with, and the
       class below is what answers, so the URL is a label and nothing more. */
    tradeSocket: function () { return Promise.resolve("wss://simulation.evie.local/"); },

    sim: {
      balance: function () { return balance; },
      config: config,
      reboot: boot,
      CFG_KEY: CFG_KEY
    }
  };

  /* The real WebSocket class carries these, and code checks against them:
     `ws.readyState !== WebSocket.OPEN` is the usual way to ask "is this
     connection up?". Without them the comparison is against undefined, every
     check answers "not open", and a page that is perfectly connected spends
     its life reconnecting. session.js compares against the number 1 and never
     noticed; the Automatic AI engine uses the constant and could not trade. */
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  FakeSocket.CLOSING = 2;
  FakeSocket.CLOSED = 3;
  FakeSocket.prototype.CONNECTING = 0;
  FakeSocket.prototype.OPEN = 1;
  FakeSocket.prototype.CLOSING = 2;
  FakeSocket.prototype.CLOSED = 3;

  // The only WebSocket either page opens.
  global.WebSocket = FakeSocket;
})(window);
