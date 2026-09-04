// TraderStatistics - Node/Express + WebSocket backend
// Connects to Angular frontend and optionally receives data from MT5 EA

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Persistence helpers ---
function isRealAccount() {
  return accountData && accountData.accountType === 'real';
}

function tradesFile() {
  return path.join(__dirname, 'server', isRealAccount() ? 'real_trades.json' : 'demo_trades.json');
}

function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(tradesFile(), 'utf8'));
  } catch {
    return { open: [], closed: [] };
  }
}

function saveTrades(data) {
  fs.writeFileSync(tradesFile(), JSON.stringify(data, null, 2), 'utf8');
}

// --- WebSocket setup ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify({ type: 'update', data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // Send current state on connect
  const trades = loadTrades();
  ws.send(JSON.stringify({ type: 'update', data: trades }));
  ws.send(JSON.stringify({ type: 'account', data: accountData }));
  ws.send(JSON.stringify({ type: 'positions', data: lastPositions }));
  ws.send(JSON.stringify({ type: 'trading_state', data: tradingState }));

  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

// --- REST API ---

// GET all trades (current account type)
app.get('/api/trades', (req, res) => {
  res.json(loadTrades());
});

// GET trades by account type explicitly
app.get('/api/trades/demo', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'server', 'demo_trades.json'), 'utf8')));
  } catch { res.json({ open: [], closed: [] }); }
});

app.get('/api/trades/real', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'server', 'real_trades.json'), 'utf8')));
  } catch { res.json({ open: [], closed: [] }); }
});

// POST open a new trade
app.post('/api/trade/open', (req, res) => {
  const trades = loadTrades();
  const body = req.body;

  // Reject phantom trades — missing symbol or zero price
  const instrument = body.instrument || body.symbol || '';
  if (!instrument || instrument === 'UNKNOWN' || !body.price || body.price === 0) {
    console.log(`[API] Phantom trade rejected: instrument="${instrument}" price=${body.price}`);
    return res.status(400).json({ error: 'incomplete trade data' });
  }

  // Dedup: reject if this MT5 ticket/positionId already exists in open or closed
  if (body.mt5Ticket || body.positionId) {
    const alreadyOpen = trades.open.some(t =>
      (body.mt5Ticket && t.mt5Ticket === body.mt5Ticket) ||
      (body.positionId && t.positionId === body.positionId)
    );
    const alreadyClosed = trades.closed.some(t =>
      (body.mt5Ticket && t.mt5Ticket === body.mt5Ticket) ||
      (body.positionId && t.positionId === body.positionId)
    );
    if (alreadyOpen || alreadyClosed) {
      console.log(`[API] Duplicate open ignored: ticket=${body.mt5Ticket} positionId=${body.positionId}`);
      const existing = trades.open.find(t =>
        (body.mt5Ticket && t.mt5Ticket === body.mt5Ticket) ||
        (body.positionId && t.positionId === body.positionId)
      ) || trades.closed.find(t =>
        (body.mt5Ticket && t.mt5Ticket === body.mt5Ticket) ||
        (body.positionId && t.positionId === body.positionId)
      );
      return res.status(200).json(existing);
    }
  }

  const newTrade = {
    id: Date.now(),
    instrument: body.instrument || body.symbol || 'UNKNOWN',
    investmentSize: body.investmentSize || body.volume || 0,
    riskPct: body.riskPct || 0,
    riskNzd: body.riskNzd || body.sl || 0,
    openDate: body.openDate || body.time || new Date().toISOString(),
    notes: body.notes || '',
    source: body.source || 'manual',
    mt5Ticket: body.mt5Ticket || body.ticket || undefined,
    positionId: body.positionId || undefined,
    volume: body.volume || undefined,
    slPrice: body.slPrice || body.sl || undefined,
    // MT5-specific fields stored for reference
    price: body.price,
    tp: body.tp,
    currency: body.currency,
  };

  trades.open.push(newTrade);
  saveTrades(trades);
  broadcast(trades);

  console.log(`[API] Trade opened: ${newTrade.instrument} (id=${newTrade.id})`);
  res.status(201).json(newTrade);
});

// POST close a trade (move from open → closed)
app.post('/api/trade/close', (req, res) => {
  const trades = loadTrades();
  const body = req.body;

  // Dedup: if already in closed, return it without duplicating
  const alreadyClosed = trades.closed.find(t =>
    (body.positionId && t.positionId === body.positionId) ||
    (body.ticket && t.mt5Ticket === body.ticket)
  );
  if (alreadyClosed) {
    console.log(`[API] Duplicate close ignored: ticket=${body.ticket} positionId=${body.positionId}`);
    return res.status(200).json(alreadyClosed);
  }

  // Find by id, positionId, or mt5Ticket
  const idx = trades.open.findIndex(t =>
    t.id === body.id ||
    (body.positionId && t.positionId === body.positionId) ||
    (body.ticket && t.mt5Ticket === body.ticket)
  );

  if (idx === -1) {
    return res.status(404).json({ error: 'Open trade not found' });
  }

  const trade = trades.open.splice(idx, 1)[0];
  const profit = body.profit !== undefined ? body.profit : body.amount || 0;

  const closedTrade = {
    ...trade,
    outcome: body.outcome || (profit >= 0 ? 'win' : 'loss'),
    amount: body.amount !== undefined ? body.amount : profit,
    closeDate: body.closeDate || body.time || new Date().toISOString(),
    closeNotes: body.closeNotes || '',
  };

  trades.closed.unshift(closedTrade); // newest first
  saveTrades(trades);
  broadcast(trades);
  applyCircuitBreaker(closedTrade.outcome);

  console.log(`[API] Trade closed: ${closedTrade.instrument} outcome=${closedTrade.outcome} amount=${closedTrade.amount}`);
  res.json(closedTrade);
});

// DELETE a single trade (open or closed)
app.delete('/api/trade/:id', (req, res) => {
  const trades = loadTrades();
  const id = parseInt(req.params.id, 10);

  const openIdx = trades.open.findIndex(t => t.id === id);
  if (openIdx !== -1) {
    trades.open.splice(openIdx, 1);
    saveTrades(trades);
    broadcast(trades);
    return res.json({ deleted: true });
  }

  const closedIdx = trades.closed.findIndex(t => t.id === id);
  if (closedIdx !== -1) {
    trades.closed.splice(closedIdx, 1);
    saveTrades(trades);
    broadcast(trades);
    return res.json({ deleted: true });
  }

  res.status(404).json({ error: 'Trade not found' });
});

// DELETE all trades
app.delete('/api/trades', (req, res) => {
  const empty = { open: [], closed: [] };
  saveTrades(empty);
  broadcast(empty);
  console.log('[API] All trades cleared');
  res.json({ cleared: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- Close position queue (Angular → MT5) ---
const closeQueue = [];

app.post('/api/close', (req, res) => {
  const { ticket } = req.body;
  if (!ticket) return res.status(400).json({ error: 'ticket required' });
  const existing = closeQueue.find(c => c.ticket === Number(ticket));
  if (existing) {
    console.log(`[Close] Duplicate ignored: ticket #${ticket} already queued`);
    return res.status(200).json(existing);
  }
  const cmd = { id: Date.now(), ticket: Number(ticket), createdAt: new Date().toISOString() };
  closeQueue.push(cmd);
  console.log(`[Close] Queued close for ticket #${ticket}`);
  res.status(201).json(cmd);
});

app.get('/api/close', (req, res) => res.json(closeQueue));

app.delete('/api/close/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = closeQueue.findIndex(c => c.id === id);
  if (idx !== -1) closeQueue.splice(idx, 1);
  res.json({ removed: true });
});

// --- Margin calc (Angular → MT5 → Angular) ---
let marginCalcRequest = null;  // { symbol, direction, lots }
let marginCalcResult  = null;  // { margin } or null

// Angular posts a calc request; MT5 polls it, computes, and posts back the result
app.post('/api/calc-margin/request', (req, res) => {
  const { symbol, direction, riskNzd, slPct, slFixed } = req.body;
  if (!symbol || !riskNzd) return res.status(400).json({ error: 'invalid' });
  marginCalcRequest = {
    symbol: symbol.toUpperCase(),
    direction: direction || 'buy',
    riskNzd: parseFloat(riskNzd),
    slPct:   parseFloat(slPct)   || 0,
    slFixed: parseFloat(slFixed) || 0,
  };
  marginCalcResult = null;
  res.json({ ok: true });
});

app.get('/api/calc-margin/request', (req, res) => {
  res.json(marginCalcRequest || {});
});

app.post('/api/calc-margin/result', (req, res) => {
  marginCalcResult = { margin: parseFloat(req.body.margin) || 0 };
  marginCalcRequest = null;
  res.json({ ok: true });
});

app.get('/api/calc-margin/result', (req, res) => {
  res.json(marginCalcResult || null);
});

// --- SL/TP modify queue (Angular → MT5) ---
const modifyQueue = [];

app.post('/api/modify', (req, res) => {
  const { ticket, sl, tp } = req.body;
  if (!ticket) return res.status(400).json({ error: 'ticket required' });
  // Replace any existing pending modify for the same ticket
  const idx = modifyQueue.findIndex(m => m.ticket === Number(ticket));
  if (idx !== -1) modifyQueue.splice(idx, 1);
  const { slNzd, tpNzd } = req.body;
  const cmd = {
    id: Date.now(),
    ticket: Number(ticket),
    slNzd: parseFloat(slNzd) || 0,
    tpNzd: parseFloat(tpNzd) || 0,
    createdAt: new Date().toISOString(),
  };
  modifyQueue.push(cmd);
  console.log(`[Modify] Queued SL/TP change for #${ticket}: SL=${cmd.sl} TP=${cmd.tp}`);
  res.status(201).json(cmd);
});

app.get('/api/modify', (req, res) => res.json(modifyQueue));

app.delete('/api/modify/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = modifyQueue.findIndex(m => m.id === id);
  if (idx !== -1) modifyQueue.splice(idx, 1);
  res.json({ removed: true });
});

// --- Depth of Market (MT5 → Angular) ---
const domStore = {}; // { BTCUSD: { bids, asks } }

app.post('/api/dom', (req, res) => {
  const { symbol, bids, asks } = req.body;
  if (!symbol) return res.status(400).json({ error: 'invalid' });
  const sym = symbol.toUpperCase();
  domStore[sym] = { bids: bids || [], asks: asks || [] };
  const msg = JSON.stringify({ type: 'dom', data: { symbol: sym, bids: bids || [], asks: asks || [] } });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  res.json({ ok: true });
});

app.get('/api/dom/:symbol', (req, res) => {
  res.json(domStore[req.params.symbol.toUpperCase()] || null);
});

// --- Candlestick bars + live positions ---
const barsStore = {}; // { BTCUSD: { timeframe, bars: [], secsLeft } }
let lastPositions = [];

app.post('/api/bars', (req, res) => {
  const { symbol, timeframe, bars, append } = req.body;
  if (!symbol || !Array.isArray(bars)) return res.status(400).json({ error: 'invalid' });
  const sym = symbol.toUpperCase();
  if (append && barsStore[sym]) {
    barsStore[sym].bars.push(...bars);
  } else {
    barsStore[sym] = { timeframe, bars: [...bars] };
  }
  console.log(`[API] Bars for ${sym}: ${barsStore[sym].bars.length} total (chunk of ${bars.length})`);
  res.json({ stored: barsStore[sym].bars.length });
});

app.get('/api/bars/:symbol', (req, res) => {
  const data = barsStore[req.params.symbol.toUpperCase()];
  if (!data) return res.status(404).json({ error: 'No bars for ' + req.params.symbol });
  res.json({ ...data, secsLeft: data.secsLeft ?? null });
});

app.post('/api/bar/update', (req, res) => {
  const { symbol, bar, secsLeft } = req.body;
  if (!symbol || !bar) return res.status(400).json({ error: 'invalid' });
  const sym = symbol.toUpperCase();
  if (barsStore[sym]) {
    const bars = barsStore[sym].bars;
    const last = bars[bars.length - 1];
    if (last && last.time === bar.time) {
      bars[bars.length - 1] = bar;
    } else {
      bars.push(bar);
      if (bars.length > 3500) bars.shift();
    }
    if (secsLeft !== undefined) barsStore[sym].secsLeft = secsLeft;
  }
  const msg = JSON.stringify({ type: 'bar_update', data: { symbol: sym, bar, secsLeft: secsLeft ?? null } });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  res.json({ ok: true });
});

app.post('/api/positions', (req, res) => {
  const positions = Array.isArray(req.body) ? req.body : [];
  lastPositions = positions;
  const msg = JSON.stringify({ type: 'positions', data: positions });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  res.json({ ok: true });
});

app.get('/api/positions', (req, res) => {
  res.json(lastPositions);
});

// --- Live prices (MT5 → Angular) ---
const livePrices = {}; // { BTCUSD: { bid, ask, updatedAt } }

app.post('/api/price', (req, res) => {
  const { symbol, bid, ask, nzdusdBid, nzdusdAsk } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const entry = {
    bid: parseFloat(bid),
    ask: parseFloat(ask),
    updatedAt: new Date().toISOString(),
    ...(nzdusdBid ? { nzdusdBid: parseFloat(nzdusdBid) } : {}),
    ...(nzdusdAsk ? { nzdusdAsk: parseFloat(nzdusdAsk) } : {}),
  };
  livePrices[symbol.toUpperCase()] = entry;
  const msg = JSON.stringify({ type: 'price', data: { symbol: symbol.toUpperCase(), ...entry } });
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
  res.json(entry);
});

app.get('/api/price/:symbol', (req, res) => {
  const entry = livePrices[req.params.symbol.toUpperCase()];
  if (!entry) return res.status(404).json({ error: 'No price data for ' + req.params.symbol });
  res.json(entry);
});

// --- Account data (MT5 → Angular) ---
const ACCOUNT_FILE = path.join(__dirname, 'server', 'account.json');

function loadAccount() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); }
  catch { return { balance: null, equity: null, currency: null, updatedAt: null }; }
}
function saveAccount(data) {
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let accountData = loadAccount();

// MT5 EA pushes account state here
app.post('/api/account', (req, res) => {
  const body = req.body;
  accountData = {
    balance:     parseFloat(body.balance)     || accountData.balance,
    equity:      parseFloat(body.equity)      || accountData.equity,
    margin:      parseFloat(body.margin)      ?? accountData.margin,
    freeMargin:  parseFloat(body.freeMargin)  ?? accountData.freeMargin,
    marginLevel: parseFloat(body.marginLevel) ?? accountData.marginLevel,
    currency:    body.currency                || accountData.currency,
    accountType: body.accountType             || accountData.accountType || 'demo',
    updatedAt:   new Date().toISOString(),
  };
  console.log(`[API] Account update: balance=${accountData.balance} equity=${accountData.equity} ${accountData.currency}`);
  saveAccount(accountData);

  // Persist balance into goals file so it survives server restarts
  if (accountData.balance && accountData.accountType) {
    const goals = loadGoals();
    const type  = accountData.accountType === 'real' ? 'real' : 'demo';
    if (!goals[type]) goals[type] = { goalPct: 2, balance: null };
    goals[type].balance = accountData.balance;
    saveGoals(goals);
  }
  // Broadcast so connected frontends update immediately
  const msg = JSON.stringify({ type: 'account', data: accountData });
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
  res.json(accountData);
});

// Frontend fetches current account state
app.get('/api/account', (req, res) => {
  res.json(accountData);
});

// --- Trading circuit breaker ---
const DAILY_TRADE_LIMIT    = 5;
const CONSEC_LOSS_LIMIT    = 2;

let tradingState = {
  enabled: true,
  disabledReason: null,   // null | string
  consecutiveLosses: 0,
  tradesToday: 0,
  lastResetDate: new Date().toDateString(),
};

function broadcastTradingState() {
  const msg = JSON.stringify({ type: 'trading_state', data: tradingState });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function checkDailyReset() {
  const today = new Date().toDateString();
  if (tradingState.lastResetDate === today) return;
  tradingState.lastResetDate      = today;
  tradingState.consecutiveLosses  = 0;
  tradingState.tradesToday        = 0;
  if (!tradingState.enabled) {
    tradingState.enabled        = true;
    tradingState.disabledReason = null;
    console.log('[Circuit] New day — trading re-enabled');
    broadcastTradingState();
  }
}

function applyCircuitBreaker(outcome) {
  checkDailyReset();
  tradingState.tradesToday++;
  if (outcome === 'loss') tradingState.consecutiveLosses++;
  else                    tradingState.consecutiveLosses = 0;

  let reason = null;
  if (tradingState.consecutiveLosses >= CONSEC_LOSS_LIMIT)
    reason = `${CONSEC_LOSS_LIMIT} consecutive losses today`;
  else if (tradingState.tradesToday >= DAILY_TRADE_LIMIT)
    reason = `${DAILY_TRADE_LIMIT}-trade daily limit reached`;

  if (reason && tradingState.enabled) {
    tradingState.enabled        = false;
    tradingState.disabledReason = reason;
    console.log(`[Circuit] Trading DISABLED — ${reason}`);
    broadcastTradingState();
  }
}

// Rebuild state from today's closed trades on startup
function initTradingState() {
  const today  = new Date().toDateString();
  const trades = loadTrades();
  const todaysClosed = trades.closed
    .filter(t => t.closeDate && new Date(t.closeDate).toDateString() === today)
    .sort((a, b) => new Date(a.closeDate) - new Date(b.closeDate));

  tradingState.tradesToday = todaysClosed.length;
  tradingState.consecutiveLosses = 0;
  for (let i = todaysClosed.length - 1; i >= 0; i--) {
    if (todaysClosed[i].outcome === 'loss') tradingState.consecutiveLosses++;
    else break;
  }

  if (tradingState.consecutiveLosses >= CONSEC_LOSS_LIMIT) {
    tradingState.enabled        = false;
    tradingState.disabledReason = `${CONSEC_LOSS_LIMIT} consecutive losses today`;
  } else if (tradingState.tradesToday >= DAILY_TRADE_LIMIT) {
    tradingState.enabled        = false;
    tradingState.disabledReason = `${DAILY_TRADE_LIMIT}-trade daily limit reached`;
  }
  console.log(`[Circuit] Init: ${tradingState.tradesToday} trades today, ${tradingState.consecutiveLosses} consec losses, enabled=${tradingState.enabled}`);
}

app.get('/api/trading-status', (req, res) => {
  checkDailyReset();
  res.json(tradingState);
});

// --- Trade commands (Angular → MT5) ---
const COMMANDS_FILE = path.join(__dirname, 'server', 'commands.json');

function loadCommands() {
  try { return JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8')); }
  catch { return []; }
}
function saveCommands(cmds) {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify(cmds, null, 2), 'utf8');
}

// EA polls this every second — returns only unread commands and marks them read immediately
app.get('/api/commands', (req, res) => {
  const cmds = loadCommands();
  const unread = cmds.filter(c => !c.read);
  if (unread.length > 0) {
    unread.forEach(c => { c.read = true; });
    saveCommands(cmds);
    console.log(`[Commands] Marked ${unread.length} command(s) as read`);
  }
  res.json(unread);
});

// Angular posts a trade command here
app.post('/api/commands', (req, res) => {
  checkDailyReset();
  if (!tradingState.enabled && isRealAccount()) {
    return res.status(403).json({ error: 'Trading disabled', reason: tradingState.disabledReason });
  }
  const cmds = loadCommands();
  const cmd = {
    id: Date.now(),
    symbol:    (req.body.symbol || '').toUpperCase(),
    direction: req.body.direction || 'buy',
    riskNzd:  parseFloat(req.body.riskNzd)  || 0,
    slPct:    parseFloat(req.body.slPct)    || 0,
    slFixed:  parseFloat(req.body.slFixed)  || 0,
    tpNzd:    parseFloat(req.body.tpNzd)    || 0,
    tpPct:    parseFloat(req.body.tpPct)    || 0,  // legacy fallback
    status:   'pending',
    read:     false,
    createdAt: new Date().toISOString(),
  };
  cmds.push(cmd);
  saveCommands(cmds);
  console.log(`[Commands] Trade queued: ${cmd.direction.toUpperCase()} ${cmd.symbol} risk=$${cmd.riskNzd} SL=${cmd.slPct}% TP=${cmd.tpPct}%`);
  res.status(201).json(cmd);
});

// EA deletes the command after execution
app.delete('/api/commands/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cmds = loadCommands().filter(c => c.id !== id);
  saveCommands(cmds);
  console.log(`[Commands] Command ${id} executed and removed`);
  res.json({ removed: true });
});

// Angular can cancel a pending command
app.delete('/api/commands', (req, res) => {
  saveCommands([]);
  res.json({ cleared: true });
});

// Clear stale commands on startup so old unexecuted commands don't fire
saveCommands([]);
initTradingState();

// --- Daily goals ---
const GOALS_FILE = path.join(__dirname, 'server', 'goals.json');

function loadGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); }
  catch { return { demo: 2, real: 2 }; }
}
function saveGoals(data) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

app.get('/api/goals', (req, res) => res.json(loadGoals()));

app.post('/api/goals', (req, res) => {
  const { type, value } = req.body;
  if ((type !== 'demo' && type !== 'real') || typeof value !== 'number') {
    return res.status(400).json({ error: 'invalid' });
  }
  const goals = loadGoals();
  if (!goals[type]) goals[type] = { goalPct: 2, balance: null };
  goals[type].goalPct = value;
  saveGoals(goals);
  res.json(goals);
});

// --- Start server ---
server.listen(PORT, () => {
  console.log(`[Server] Trader Statistics backend running on http://localhost:${PORT}`);
  console.log(`[Server] WebSocket listening on ws://localhost:${PORT}`);
});
