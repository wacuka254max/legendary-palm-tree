/**
 * EVIE — Automatic AI (trading engine).
 *
 * This is magicbotslab.com's Smart Recovery Differ, copied whole. It is the
 * strategy Evie ships as "Automatic AI": it trades digit contracts on the
 * Volatility indices, and after a loss it stops guessing — it reads the recent
 * digit history of every market and switches to an OVER/UNDER recovery trade on
 * whichever one is leaning hardest.
 *
 * Copied rather than rewritten on purpose. This is money, and the version
 * running on magicbotslab has already met the awkward parts: reconnects,
 * rate limits, a trade update that never arrives, an authorisation that expires
 * mid-session. Only three things were changed — the class name, the global it
 * exports, and two status strings that named the old bot.
 *
 * It already speaks the NEW Deriv API: proposals carry `underlying_symbol`, and
 * `otpAuthenticated` skips the `authorize` step for a pre-authed OTP socket,
 * which is exactly how Evie connects it (see automatic-ai.js).
 */
(() => {
  class AutomaticAIBot {
    constructor(ui, options) {
      this.ui = ui;
      this.wsUrl = options.wsUrl;
      this.defaults = options.defaults;
      this.markets = options.markets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
      this.resolveAuthToken = options.resolveAuthToken;
      this.WebSocketImpl = options.WebSocketImpl || WebSocket;
      // When using Deriv Options OTP-authenticated WebSocket URLs, the server already authorizes.
      // In that case we should skip sending an explicit `authorize` message.
      this.otpAuthenticated = !!options.otpAuthenticated;

      this.resetState();
    }

    resetState() {
      this.stopKeepAlive();
      this.clearTradeWatchdog();
      if (this.resumeTimer) { clearTimeout(this.resumeTimer); }
      this.keepAliveTimer = null;
      this.tradeWatchdog = null;
      this.resumeTimer = null;
      this.ws = null;
      this.isRunning = false;
      this.stopRequested = false;
      this.stopMessage = null;
      this.config = { ...this.defaults };
      this.currentStake = this.defaults.initialStake;
      this.activeContractId = null;
      this.contractStreamId = null;
      this.awaitingBuy = false;
      this.ownContracts = new Set();      // contracts this run bought
      this.settledContracts = new Set();  // and the ones already counted
      this.tradeInProgress = false;
      this.lastMarket = null;
      this.lastDigit = null;
      this.currentMarket = null;
      this.currentDigit = null;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.balance = 0;
      this.accountCurrency = 'USD';
      this.startTime = null;
      this.runningTimer = null;
      this.reconnectAttempts = 0;
      this.reconnectTimeout = null;
      this.isReconnecting = false;
      this.storedToken = null;
      
      // Recovery mode state
      this.recoveryMode = false;
      this.recoveryMarket = null;
      this.recoveryTradeType = null; // 'OVER' or 'UNDER'
      this.marketAnalysis = {}; // Store digit history per market for analysis
      this.tickSubscriptions = {}; // Track tick subscriptions per market
    }

    async start(config) {
      if (this.isRunning) {
        this.ui.showStatus('Bot is already running. Stop it before starting again.', 'warning');
        return;
      }

      const token = this.resolveAuthToken();
      if (!token) {
        this.ui.showStatus('Connect your Deriv account before running Automatic AI.', 'error');
        return;
      }

      this.storedToken = token;
      this.reconnectAttempts = 0;

      this.config = { ...this.config, ...config };
      this.currentStake = this.config.initialStake;
      this.totalProfit = 0;
      this.totalTrades = 0;
      this.wins = 0;
      this.consecutiveLosses = 0;
      this.lastMarket = null;
      this.lastDigit = null;
      this.activeContractId = null;
      this.contractStreamId = null;
      this.awaitingBuy = false;
      this.ownContracts = new Set();
      this.settledContracts = new Set();
      this.tradeInProgress = false;
      this.recoveryMode = false;
      this.recoveryMarket = null;
      this.recoveryTradeType = null;
      this.marketAnalysis = {};
      this.tickSubscriptions = {};

      this.ui.resetHistory();
      this.ui.updateStats(this.getStatsSnapshot());
      this.ui.setRunningState(true);
      this.ui.showStatus('Authorizing with Deriv...', 'info');

      this.isRunning = true;
      this.stopRequested = false;
      this.startTime = new Date();
      this.startRunningTimer();

      this.connectWebSocket();
    }

    connectWebSocket() {
      if (this.stopRequested) return;

      this.ws = new this.WebSocketImpl(this.wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.startKeepAlive();
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        if (!this.otpAuthenticated) {
          const token = this.storedToken || this.resolveAuthToken();
          if (token) {
            this.ws.send(JSON.stringify({ authorize: token }));
          }
        } else {
          // OTP-authenticated WS: subscribe immediately and start trading.
          this.ui.showStatus('Connected. Automatic AI is running.', 'success');
          this.subscribeToBalance();
          this.subscribeToContracts();
          this.subscribeToAllMarketTicks();
          if (!this.tradeInProgress) {
            this.queueNextTrade();
          }
        }
      };

      this.ws.onmessage = (event) => this.handleMessage(event.data);

      this.ws.onerror = () => {
        if (!this.stopRequested && !this.isReconnecting) {
          this.attemptReconnect('WebSocket error. Reconnecting...');
        }
      };

      this.ws.onclose = () => {
        if (this.stopRequested) {
          this.finishStop();
        } else if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost. Reconnecting...');
        }
      };
    }

    stop(message = 'Bot stopped', type = 'info') {
      if (!this.isRunning && !this.ws) {
        this.ui.showStatus('Bot is already stopped.', 'warning');
        return;
      }
      this.stopRequested = true;
      this.stopMessage = { message, type };
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close();
      } else {
        this.finishStop();
      }
    }

    attemptReconnect(message) {
      if (this.stopRequested || this.isReconnecting) return;

      this.isReconnecting = true;
      this.reconnectAttempts += 1;

      if (this.reconnectAttempts > 10) {
        this.ui.showStatus('Max reconnection attempts reached. Please restart the bot.', 'error');
        this.stop('Connection failed after multiple attempts', 'error');
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      this.ui.showStatus(`${message} (Attempt ${this.reconnectAttempts}/10)`, 'warning');

      if (this.ws) {
        try {
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.onclose = null;
          this.ws.close();
        } catch (e) {
          console.error('Error closing WebSocket during reconnect:', e);
        }
      }

      this.reconnectTimeout = setTimeout(() => {
        if (!this.stopRequested) {
          this.connectWebSocket();
        }
      }, delay);
    }

    finishStop() {
      this.isRunning = false;
      this.tradeInProgress = false;
      this.activeContractId = null;
      this.stopKeepAlive();
      this.clearTradeWatchdog();
      if (this.resumeTimer) {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
      }
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
        this.runningTimer = null;
      }
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.ui.setRunningState(false);
      if (this.stopMessage) {
        this.ui.showStatus(this.stopMessage.message, this.stopMessage.type);
      }
    }

    startRunningTimer() {
      if (this.runningTimer) {
        clearInterval(this.runningTimer);
      }
      this.runningTimer = setInterval(() => {
        if (this.isRunning && this.startTime) {
          const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
          const hours = Math.floor(elapsed / 3600);
          const minutes = Math.floor((elapsed % 3600) / 60);
          const seconds = elapsed % 60;
          const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
          this.ui.updateRunningTime(timeString);
        }
      }, 1000);
    }

    handleMessage(raw) {
      if (!this.isRunning && !this.isReconnecting) return;

      try {
        const data = JSON.parse(raw);

        if (data.error) {
          const errorCode = data.error?.code;
          const message = data.error.message || 'Deriv returned an error.';
          
          if (errorCode === 'InvalidToken' || errorCode === 'AuthorizationRequired') {
            this.ui.showStatus('Authorization expired. Reconnecting...', 'warning');
            this.attemptReconnect('Re-authenticating...');
            return;
          }
          
          if (errorCode === 'RateLimit' || errorCode === 'TooManyRequests') {
            this.ui.showStatus('Rate limited. Waiting before retry...', 'warning');
            setTimeout(() => {
              if (this.isRunning && !this.stopRequested) {
                this.attemptReconnect('Retrying after rate limit...');
              }
            }, 5000);
            return;
          }
          
          /* An account that cannot cover the stake will not start covering it
             by being retried. Stop, and say the one thing that fixes it. */
          if (/insufficient/i.test(message)) {
            if (window.PopupNotifications) window.PopupNotifications.showNeedsDeposit();
            this.stop('Stopped — the account balance is insufficient.', 'error');
            return;
          }

          console.error('Deriv API error:', data.error);
          this.ui.showStatus(message, 'error');

          // An error answering a proposal or a buy leaves the trade half-placed.
          // The next trade is only ever scheduled from the settle handler, so if
          // tradeInProgress is left set here nothing reschedules and the bot sits
          // idle for good. Release it and pick the loop back up.
          const req = data.echo_req || {};
          const answeringTrade = data.msg_type === 'proposal' || data.msg_type === 'buy' ||
            req.proposal !== undefined || req.buy !== undefined;
          if (answeringTrade) {
            this.releaseTrade();
            this.resumeTrading(1500);
          }
          return;
        }

        switch (data.msg_type) {
          case 'authorize':
            if (!data.authorize) {
              console.error('Authorize response missing authorize data:', data);
              return;
            }
            this.accountCurrency = data.authorize.currency || 'USD';
            this.balance = Number(data.authorize.balance) || 0;
            this.ui.updateBalance(this.balance, this.accountCurrency);
            
            if (this.isReconnecting) {
              this.ui.showStatus('Reconnected. Resuming trading...', 'success');
              this.isReconnecting = false;
            } else {
              this.ui.showStatus('Connected. Automatic AI is running.', 'success');
            }

            this.subscribeToBalance();
            this.subscribeToContracts();
            
            // Subscribe to ticks for all markets for analysis
            this.subscribeToAllMarketTicks();
            
            if (!this.tradeInProgress) {
              this.queueNextTrade();
            }
            break;
          case 'balance':
            if (typeof data.balance?.balance !== 'undefined') {
              this.accountCurrency = data.balance.currency || this.accountCurrency;
              this.balance = Number(data.balance.balance);
              this.ui.updateBalance(this.balance, data.balance.currency || this.accountCurrency);
            }
            break;
          case 'proposal':
            /* ONE buy per trade.
             *
             * This used to buy on every proposal message that arrived, with
             * nothing tying the message to the trade being placed. A proposal
             * on this API is a priced quote that can be sent more than once —
             * it re-prices as the market moves — so a single request could
             * produce a second and a third message, and each one bought. That
             * is two contracts open at once from the very first trade, both
             * staked, neither asked for.
             *
             * The flag is the whole fix: it is raised when the proposal is
             * sent and lowered by the buy it authorises. Anything after that,
             * for this trade, is a price update and nothing more. */
            if (!this.isRunning || !data.proposal?.id) break;

            // Stop the re-pricing stream if this one came with a subscription.
            if (data.subscription?.id && this.ws?.readyState === WebSocket.OPEN) {
              try { this.ws.send(JSON.stringify({ forget: data.subscription.id })); } catch (_) {}
            }

            if (!this.awaitingBuy || this.activeContractId) break;
            if (this.ws?.readyState !== WebSocket.OPEN) break;

            this.awaitingBuy = false;
            this.ws.send(JSON.stringify({
              buy: data.proposal.id,
              price: data.proposal.ask_price
            }));
            break;
          case 'buy':
            if (data.buy?.contract_id) {
              this.activeContractId = data.buy.contract_id;
              this.ownContracts.add(data.buy.contract_id);

              /* Subscribe to THIS contract by id, not only through the blanket
                 "all contracts" stream opened at connect.

                 That blanket subscription is a single long-lived stream, and
                 when it stops delivering — which it does — nothing tells the
                 bot its contract has settled. It waits out the watchdog, gives
                 up, and starts another: a trade every thirty-five seconds
                 instead of a trade every four. A subscription made per contract
                 is the one the analysis page has always used, and it is asked
                 for at the moment the contract exists. */
              if (this.ws?.readyState === WebSocket.OPEN) {
                try {
                  this.ws.send(JSON.stringify({
                    proposal_open_contract: 1,
                    contract_id: data.buy.contract_id,
                    subscribe: 1
                  }));
                } catch (_) {}
              }
            }
            break;
          case 'proposal_open_contract':
            /* Keep the stream id: a per-contract subscription that is never
               closed is a stream left open for a contract that no longer
               exists, and they accumulate for as long as the bot runs. */
            if (data.subscription?.id && data.proposal_open_contract?.contract_id === this.activeContractId) {
              this.contractStreamId = data.subscription.id;
            }
            this.handleContractUpdate(data.proposal_open_contract);
            break;
          case 'tick':
            // Store digit from tick for market analysis
            if (data.tick && data.tick.symbol && data.tick.quote) {
              const market = data.tick.symbol;
              const tickValue = data.tick.quote.toString();
              const digit = parseInt(tickValue.slice(-1));
              
              if (!this.marketAnalysis[market]) {
                this.marketAnalysis[market] = {
                  digits: [],
                  over4Count: 0,
                  under5Count: 0,
                  totalTicks: 0
                };
              }
              
              const analysis = this.marketAnalysis[market];
              analysis.digits.push(digit);

              // Keep only the last 50 digits: that is the window being judged.
              if (analysis.digits.length > 50) {
                analysis.digits.shift();
              }

              /* Counted FROM that window, not accumulated forever.
                 They used to be running totals that never came down while the
                 digit list was trimmed, so after a few minutes every market
                 read as an even 50/50 — the lifetime average of a fair digit —
                 and the "is one side ahead by 60%?" test could never be true
                 again. The bias it was built to find was being averaged away. */
              analysis.over4Count = 0;
              analysis.under5Count = 0;
              for (let i = 0; i < analysis.digits.length; i++) {
                if (analysis.digits[i] > 4) analysis.over4Count++;
                else analysis.under5Count++;
              }
              analysis.totalTicks = analysis.digits.length;
            }
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Error handling message', error);
      }
    }

    subscribeToBalance() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
    }

    subscribeToContracts() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
    }

    subscribeToAllMarketTicks() {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      
      // Subscribe to ticks for all markets to analyze them
      this.markets.forEach(market => {
        if (!this.tickSubscriptions[market]) {
          this.ws.send(JSON.stringify({
            ticks: market,
            subscribe: 1
          }));
          this.tickSubscriptions[market] = true;
        }
      });
    }

    analyzeMarketsForRecovery() {
      // Analyze all markets to find the best one for digit over 4 or under 5
      let bestMarket = null;
      let bestTradeType = null;
      let bestScore = 0;

      this.markets.forEach(market => {
        const analysis = this.marketAnalysis[market];
        if (!analysis || analysis.totalTicks < 10) {
          return; // Need at least 10 ticks for analysis
        }

        // Calculate probability scores
        const over4Probability = analysis.over4Count / analysis.totalTicks;
        const under5Probability = analysis.under5Count / analysis.totalTicks;

        // Score based on probability (higher is better)
        // Prefer markets with strong bias (>60% probability)
        if (over4Probability > 0.6 && over4Probability > bestScore) {
          bestScore = over4Probability;
          bestMarket = market;
          bestTradeType = 'OVER';
        }
        
        if (under5Probability > 0.6 && under5Probability > bestScore) {
          bestScore = under5Probability;
          bestMarket = market;
          bestTradeType = 'UNDER';
        }
      });

      // If no strong bias found, use recent digit patterns
      if (!bestMarket) {
        this.markets.forEach(market => {
          const analysis = this.marketAnalysis[market];
          if (!analysis || analysis.digits.length < 10) return;

          // Check last 10 digits
          const recentDigits = analysis.digits.slice(-10);
          const over4Recent = recentDigits.filter(d => d > 4).length;
          const under5Recent = recentDigits.filter(d => d < 5).length;

          const over4Score = over4Recent / 10;
          const under5Score = under5Recent / 10;

          if (over4Score > 0.6 && over4Score > bestScore) {
            bestScore = over4Score;
            bestMarket = market;
            bestTradeType = 'OVER';
          }

          if (under5Score > 0.6 && under5Score > bestScore) {
            bestScore = under5Score;
            bestMarket = market;
            bestTradeType = 'UNDER';
          }
        });
      }

      /* Fallback: no market has a strong bias, so take the one with the most
         data — and take the side that is actually ahead on it.

         Over 4 and Under 5 are complements: every digit is either above 4 or
         below 5, so their shares add to 1 and one of them is always at least
         half. Defaulting to OVER here, as this did, meant that whenever no
         market cleared 60% the bot could take the WEAKER side of a market it
         had already measured — paying for a coin flip it knew was tilted the
         other way. */
      if (!bestMarket) {
        let maxTicks = 0;
        this.markets.forEach(market => {
          const analysis = this.marketAnalysis[market];
          if (analysis && analysis.totalTicks > maxTicks) {
            maxTicks = analysis.totalTicks;
            bestMarket = market;
            bestTradeType = analysis.over4Count >= analysis.under5Count ? 'OVER' : 'UNDER';
          }
        });
      }

      // Final fallback: nothing measured at all yet.
      if (!bestMarket) {
        bestMarket = this.markets[Math.floor(Math.random() * this.markets.length)];
        bestTradeType = 'OVER';
      }

      return { market: bestMarket, tradeType: bestTradeType };
    }

    /**
     * Recovery helpers. The trade loop is driven entirely by contract
     * settlements, so anything that stops a settlement arriving stops the bot
     * for good. These put it back on its feet without touching how it trades.
     */

    /** Clear the in-flight trade so the loop is allowed to run again. */
    releaseTrade() {
      this.tradeInProgress = false;
      this.awaitingBuy = false;
      this.activeContractId = null;
      this.clearTradeWatchdog();
    }

    /** Ask for the next trade after a pause, the same way a settle does. */
    resumeTrading(delay) {
      if (!this.isRunning || this.stopRequested) return;
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (this.isRunning && !this.stopRequested && !this.tradeInProgress) {
          this.queueNextTrade();
        }
      }, delay || 900);
    }

    /** Deriv drops idle sockets. Without traffic the connection can die quietly,
     *  and a half-dead socket never fires onclose, so nothing reconnects. */
    startKeepAlive() {
      this.stopKeepAlive();
      this.keepAliveTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try { this.ws.send(JSON.stringify({ ping: 1 })); } catch (_) {}
        }
      }, 20000);
    }

    stopKeepAlive() {
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
    }

    /**
     * A contract update is late. What to do about it depends entirely on
     * whether a contract EXISTS.
     *
     * If it does — we have its id, Deriv confirmed the buy — then it will
     * settle, and the only correct response is to keep asking for the update.
     * The old behaviour was to give up and start another trade, which put two
     * live contracts on the account at once: the abandoned one settled a
     * moment later against a bot that had already moved on, and the stake had
     * been committed twice. That is what "two trades at the same time" was.
     *
     * If there is no contract id, nothing was bought and there is nothing to
     * wait for, so the loop is released and picks up again.
     *
     * A contract that never reports at all eventually stops the bot rather
     * than being traded over. Standing still is recoverable; two positions
     * nobody asked for is not.
     */
    armTradeWatchdog() {
      this.clearTradeWatchdog();
      this.watchdogRounds = 0;

      const check = () => {
        if (!this.isRunning || this.stopRequested || !this.tradeInProgress) return;
        this.watchdogRounds++;

        if (this.activeContractId) {
          // The contract is real. Ask again — never buy over the top of it.
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: this.activeContractId,
                subscribe: 1
              }));
            } catch (_) {}
          }

          if (this.watchdogRounds >= 8) {
            this.stop('A contract stopped reporting. Stopped rather than trade over it.', 'error');
            return;
          }

          this.ui.showStatus('Waiting on a contract update — re-asking Deriv...', 'warning');
          this.tradeWatchdog = setTimeout(check, 8000);
          return;
        }

        // No contract was ever confirmed: nothing is open, so start again.
        this.ui.showStatus('That trade never opened — starting the next one...', 'warning');
        this.releaseTrade();
        this.resumeTrading(1200);
      };

      this.tradeWatchdog = setTimeout(check, 12000);
    }

    clearTradeWatchdog() {
      if (this.tradeWatchdog) {
        clearTimeout(this.tradeWatchdog);
        this.tradeWatchdog = null;
      }
    }

    queueNextTrade() {
      if (!this.isRunning || this.tradeInProgress) {
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (!this.isReconnecting) {
          this.attemptReconnect('Connection lost during trade. Reconnecting...');
        }
        return;
      }

      let market, digit, contractType, barrier, displayTarget;

      if (this.recoveryMode) {
        /* Re-read the market before EVERY recovery trade, not just the first.

           A recovery can run for several trades, and the bias it was chosen on
           moves while it does — each new tick shifts the counts. Deciding once
           on entry meant the second and third rungs of a ladder were still
           trading a lead that had since flipped, at three and nine times the
           stake. It now takes whichever side is ahead at the moment it buys. */
        const recovery = this.analyzeMarketsForRecovery();
        this.recoveryMarket = recovery.market;
        this.recoveryTradeType = recovery.tradeType;

        market = this.recoveryMarket;
        
        if (this.recoveryTradeType === 'OVER') {
          contractType = 'DIGITOVER';
          barrier = '4';
          digit = 4;
          displayTarget = 'Over 4';
        } else {
          contractType = 'DIGITUNDER';
          barrier = '5';
          digit = 5;
          displayTarget = 'Under 5';
        }
      } else {
        // Normal mode: digit differ on random number, one market
        market = this.getNextMarket();
        digit = this.getNextDigit();
        contractType = 'DIGITDIFF';
        barrier = digit.toString();
        displayTarget = `Differ ${digit}`;
      }

      this.tradeInProgress = true;
      this.awaitingBuy = true;      // exactly one buy answers this proposal
      this.armTradeWatchdog();
      this.currentMarket = market;
      this.currentDigit = digit;
      this.ui.updateTargets(market, displayTarget);

      const proposal = {
        proposal: 1,
        amount: this.currentStake.toFixed(2),
        basis: 'stake',
        contract_type: contractType,
        currency: this.accountCurrency || 'USD',
        duration: 1,
        duration_unit: 't',
        // Deriv Options WebSocket schema expects underlying_symbol
        underlying_symbol: market,
        barrier: barrier
      };

      this.ws.send(JSON.stringify(proposal));
    }

    getNextMarket() {
      // In normal mode, use one market consistently until loss
      if (!this.lastMarket) {
        this.lastMarket = this.markets[Math.floor(Math.random() * this.markets.length)];
      }
      return this.lastMarket;
    }

    getNextDigit() {
      let digit = Math.floor(Math.random() * 10);
      if (digit === this.lastDigit) {
        digit = (digit + 3) % 10;
      }
      this.lastDigit = digit;
      return digit;
    }

    handleContractUpdate(contract) {
      if (!contract || !contract.contract_id) return;
      const id = contract.contract_id;

      /* Only contracts THIS run bought. The blanket subscription reports every
         contract on the account, including any opened somewhere else. */
      if (!this.ownContracts.has(id)) return;

      /* And each of them exactly once.
       *
       * A settled contract is now announced twice — once down the blanket
       * stream, once down the per-contract subscription opened when it was
       * bought. The old guard let the second one through: it compared against
       * activeContractId, which the FIRST update had just set to null, so the
       * check short-circuited to false and the duplicate was counted as
       * another trade. One contract became two rows, two trade counts and
       * twice the profit — identical market, identical digit, identical
       * figure, which is exactly what it looked like on screen. */
      if (contract.is_sold && this.settledContracts.has(id)) return;

      if (contract.is_sold) {
        this.settledContracts.add(id);
        /* Bounded: a long run must not accumulate ids forever. Well past any
           window in which a duplicate could still arrive. */
        if (this.settledContracts.size > 200) {
          this.settledContracts.delete(this.settledContracts.values().next().value);
        }
        const isWin = contract.profit > 0;
        const profit = parseFloat(contract.profit) || 0;
        const stake = parseFloat(contract.buy_price) || this.currentStake;

        this.totalProfit = parseFloat((this.totalProfit + profit).toFixed(2));
        this.totalTrades += 1;
        this.tradeInProgress = false;
        this.awaitingBuy = false;
        this.activeContractId = null;
        this.clearTradeWatchdog();

        // Close this contract's stream; the next trade opens its own.
        if (this.contractStreamId && this.ws?.readyState === WebSocket.OPEN) {
          try { this.ws.send(JSON.stringify({ forget: this.contractStreamId })); } catch (_) {}
        }
        this.contractStreamId = null;

        if (isWin) {
          this.wins += 1;
          this.consecutiveLosses = 0;
          this.currentStake = this.config.initialStake;
          
          // Exit recovery mode on win
          if (this.recoveryMode) {
            this.recoveryMode = false;
            this.recoveryMarket = null;
            this.recoveryTradeType = null;
            this.ui.showStatus('Recovery successful! Returning to normal mode...', 'success');
          }
        } else {
          this.consecutiveLosses += 1;
          
          // Apply martingale
          this.currentStake = parseFloat((this.currentStake * (this.config.martingaleMultiplier || 3.1)).toFixed(2));
          
          /* Enter recovery. The market and the side are NOT chosen here:
             queueNextTrade reads them fresh at the moment it buys, so deciding
             now would only be an earlier answer that gets thrown away. */
          if (!this.recoveryMode) {
            this.recoveryMode = true;
            this.ui.showStatus('Loss detected. Recovering on the stronger side...', 'warning');
          }
        }

        this.ui.addHistoryEntry({
          win: isWin,
          profit: profit,
          stake: stake,
          market: this.currentMarket,
          digit: this.currentDigit,
          timestamp: new Date()
        });

        this.ui.updateStats(this.getStatsSnapshot());

        // Check stop conditions
        if (this.shouldStop()) {
          return;
        }

        // Continue trading
        if (this.isRunning && !this.stopRequested) {
          setTimeout(() => {
            if (this.isRunning && !this.tradeInProgress) {
              this.queueNextTrade();
            }
          }, 900);
        }
      }
    }

    shouldStop() {
      if (this.config.takeProfit > 0 && this.totalProfit >= this.config.takeProfit) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showTakeProfit({
            profit: stats.totalProfit,
            trades: stats.totalTrades,
            time: stats.runningTime
          });
        }
        this.stop('Take profit reached. Bot stopped.', 'success');
        return true;
      }

      if (this.config.stopLoss > 0 && this.totalProfit <= -Math.abs(this.config.stopLoss)) {
        const stats = this.getStatsSnapshot();
        if (window.PopupNotifications) {
          window.PopupNotifications.showStopLoss({
            profit: stats.totalProfit,
            trades: stats.totalTrades,
            time: stats.runningTime
          });
        }
        this.stop('Stop loss hit. Bot stopped.', 'error');
        return true;
      }

      return false;
    }

    getStatsSnapshot() {
      const winRate = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(2) : '0.00';
      return {
        balance: this.balance,
        currency: this.accountCurrency,
        totalProfit: this.totalProfit,
        totalTrades: this.totalTrades,
        winRate: winRate,
        currentStake: this.currentStake,
        consecutiveLosses: this.consecutiveLosses,
        market: this.currentMarket || '-',
        digit: typeof this.currentDigit === 'number' ? this.currentDigit : '-',
        runningTime: this.getRunningTime()
      };
    }

    getRunningTime() {
      if (!this.startTime) return '00:00:00';
      const elapsed = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
      const hours = Math.floor(elapsed / 3600);
      const minutes = Math.floor((elapsed % 3600) / 60);
      const seconds = elapsed % 60;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
  }

  window.EvieAutomaticAI = AutomaticAIBot;
})();

