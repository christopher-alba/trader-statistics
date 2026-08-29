//+------------------------------------------------------------------+
//|  TraderStatistics.mq5                                            |
//|  Expert Advisor — two-way sync with the Angular app              |
//|                                                                  |
//|  SETUP:                                                          |
//|  1. Start the backend:  npm run dev  (in the project folder)     |
//|  2. In MT5: Tools → Options → Expert Advisors →                  |
//|     Allow WebRequest for listed URLs → add:                      |
//|       http://127.0.0.1:3000                                      |
//|  3. Compile this EA in MetaEditor (F7)                           |
//|  4. Drag onto any chart. Works across all symbols automatically. |
//+------------------------------------------------------------------+
#property copyright "TraderStatistics"
#property version   "1.11"
#property strict

//--- Inputs
input string ServerUrl    = "http://127.0.0.1:3000"; // Backend URL
input int    MagicNumber  = 0;                        // 0 = all trades
input int    PollMs       = 200;                      // Command poll interval (ms)

//--- State
double   g_LastPostedAsk     = -1;
datetime g_LastFailedPost    = 0;    // throttle retries when server is down
int      g_FailBackoffSec    = 30;   // seconds between retries after a failure
string   g_ChartSymbol       = "";   // symbol bars were last sent for
uint     g_LastTickMs        = 0;    // millisecond timestamp of last OnTick post
uint     g_LastAccountMs    = 0;    // millisecond timestamp of last account post
uint     g_LastIndicatorMs  = 0;    // millisecond timestamp of last indicator post
uint     g_LastBarMs        = 0;    // millisecond timestamp of last bar update post
bool     g_IndicatorHistorySent = false; // send full history once handles are warm
input int TickIntervalMs      = 500;   // min ms between tick-driven updates
input int AccountIntervalMs   = 500;   // min ms between account posts
input int IndicatorIntervalMs = 500;   // min ms between indicator posts

// Indicator handles
int g_AO_Handle   = INVALID_HANDLE;
int g_RSI_Handle  = INVALID_HANDLE;
int g_MACD_Handle = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("[TS] EA starting. Server: ", ServerUrl);
   EventSetMillisecondTimer(PollMs);

   // Heartbeat
   char post[], result[]; string rh;
   int code = WebRequest("GET", ServerUrl + "/api/health", "Content-Type: application/json\r\n", 5000, post, result, rh);
   if(code == 200)
      Print("[TS] Server reachable.");
   else
      Print("[TS] WARNING: server not reachable (code=", code, "). Is npm run dev running?");

   // Create indicator handles for the current chart
   g_AO_Handle   = iAO(Symbol(), PERIOD_CURRENT);
   g_RSI_Handle  = iRSI(Symbol(), PERIOD_CURRENT, 14, PRICE_CLOSE);
   g_MACD_Handle = iMACD(Symbol(), PERIOD_CURRENT, 12, 26, 9, PRICE_CLOSE);

   PostAccountBalance();
   SendHistoricalBars(Symbol(), PERIOD_CURRENT, 3000);
   SendOpenPositions();
   // Indicator history is sent from OnTimer once handles finish initializing
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

//+------------------------------------------------------------------+
//| Tick — price/account/positions updates at up to 5 Hz            |
//+------------------------------------------------------------------+
void OnTick()
{
   uint now = GetTickCount();
   if(now - g_LastTickMs < (uint)TickIntervalMs) return;
   g_LastTickMs = now;

   bool backingOff = (g_LastFailedPost > 0 && TimeCurrent() - g_LastFailedPost < g_FailBackoffSec);
   if(backingOff) return;

   // Price
   double ask = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
   double bid = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   if(ask != g_LastPostedAsk && ask > 0)
   {
      string priceJson = "{\"symbol\":\"" + Symbol() + "\","
                       + "\"bid\":"  + DoubleToString(bid, 8) + ","
                       + "\"ask\":"  + DoubleToString(ask, 8) + "}";
      if(PostRequest(ServerUrl + "/api/price", priceJson))
         g_LastPostedAsk = ask;
   }

   if(now - g_LastAccountMs >= (uint)AccountIntervalMs)
   {
      g_LastAccountMs = now;
      PostAccountBalance();
   }
   SendOpenPositions();
   if(now - g_LastIndicatorMs >= (uint)IndicatorIntervalMs)
   {
      g_LastIndicatorMs = now;
      PostIndicators();
   }

}

//+------------------------------------------------------------------+
//| Timer — polls pending trade commands from the Angular app        |
//+------------------------------------------------------------------+
void OnTimer()
{
   // Bar update on a reliable timer — not tick-dependent
   uint now = GetTickCount();
   if(now - g_LastBarMs >= (uint)TickIntervalMs)
   {
      g_LastBarMs = now;
      PostCurrentBar();
   }


   // Send full indicator history once — wait until handles have calculated enough bars
   if(!g_IndicatorHistorySent && g_AO_Handle != INVALID_HANDLE)
   {
      double probe[];
      if(CopyBuffer(g_AO_Handle, 0, 1, 50, probe) >= 50)
      {
         SendHistoricalIndicators(Symbol(), PERIOD_CURRENT, 3000);
         g_IndicatorHistorySent = true;
      }
   }

   PollMarginCalc();
   PollCloseCommands();
   PollModifyCommands();

   char post[], result[]; string rh;
   int code = WebRequest("GET", ServerUrl + "/api/commands", "Content-Type: application/json\r\n", 3000, post, result, rh);
   if(code != 200 || ArraySize(result) == 0) return;

   string json = CharArrayToString(result);
   if(json == "[]" || StringLen(json) < 5) return;

   // Parse each command object from the JSON array
   // Format: [{"id":123,"symbol":"BTCUSD","direction":"buy","riskNzd":50,"slPct":1,"tpPct":2,...}, ...]
   int pos = 0;
   while(true)
   {
      int start = StringFind(json, "{", pos);
      if(start == -1) break;
      int end = StringFind(json, "}", start);
      if(end == -1) break;

      string obj = StringSubstr(json, start, end - start + 1);
      pos = end + 1;

      long   cmdId     = (long)ParseJsonLong(obj, "id");
      string symbol    = ParseJsonString(obj, "symbol");
      string direction = ParseJsonString(obj, "direction");
      double riskNzd   = ParseJsonDouble(obj, "riskNzd");
      double slPct     = ParseJsonDouble(obj, "slPct");
      double slFixed   = ParseJsonDouble(obj, "slFixed"); // fixed price distance
      double tpNzd     = ParseJsonDouble(obj, "tpNzd");
      double tpPct     = ParseJsonDouble(obj, "tpPct"); // legacy

      if(cmdId == 0 || symbol == "" || (slPct <= 0 && slFixed <= 0)) continue;

      Print("[TS] Command received: ", direction, " ", symbol,
            " risk=$", riskNzd, " SL=", (slFixed > 0 ? DoubleToString(slFixed,5)+" pts" : DoubleToString(slPct,2)+"%"), " TP=$", tpNzd);

      bool ok = ExecuteTrade(symbol, direction, riskNzd, slPct, slFixed, tpNzd, tpPct);

      // Remove command regardless of outcome (prevent re-execution loops)
      char delPost[], delResult[]; string delRh;
      string delUrl = ServerUrl + "/api/commands/" + IntegerToString(cmdId);
      WebRequest("DELETE", delUrl, "Content-Type: application/json\r\n", 3000, delPost, delResult, delRh);

      if(ok)
         Print("[TS] Order placed and command removed.");
      else
         Print("[TS] Order FAILED. Command removed to prevent retry. Error: ", GetLastError());
   }
}

//+------------------------------------------------------------------+
//| Execute a trade order from a queued command                      |
//+------------------------------------------------------------------+
bool ExecuteTrade(string symbol, string direction, double riskNzd, double slPct, double slFixed, double tpNzd, double tpPct = 0)
{
   // Validate symbol
   if(!SymbolSelect(symbol, true))
   {
      Print("[TS] Symbol not found: ", symbol);
      return false;
   }

   // Wait for quote refresh
   Sleep(200);

   ENUM_ORDER_TYPE orderType = (direction == "buy") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   double entryPrice = (orderType == ORDER_TYPE_BUY) ? ask : bid;

   if(entryPrice <= 0)
   {
      Print("[TS] Could not get price for ", symbol);
      return false;
   }

   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);

   if(tickSize <= 0 || tickValue <= 0)
   {
      Print("[TS] Cannot get tick info for ", symbol);
      return false;
   }

   // SL distance from entry — either fixed price distance or % of entry price
   double slDistance = (slFixed > 0) ? slFixed : entryPrice * slPct / 100.0;
   double slTicks    = slDistance / tickSize;
   double lots       = riskNzd / (slTicks * tickValue);

   // Clamp to symbol limits and round to lot step
   double minLot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(lots, minLot);
   lots = MathMin(lots, maxLot);

   // TP price: back-calculate from desired NZD profit and actual lot size
   double tpDistance = 0;
   if(tpNzd > 0 && lots > 0)
      tpDistance = tpNzd * tickSize / (tickValue * lots);
   else if(tpPct > 0)
      tpDistance = entryPrice * tpPct / 100.0;

   double slPrice, tpPrice;
   if(orderType == ORDER_TYPE_BUY)
   {
      slPrice = entryPrice - slDistance;
      tpPrice = (tpDistance > 0) ? entryPrice + tpDistance : 0;
   }
   else
   {
      slPrice = entryPrice + slDistance;
      tpPrice = (tpDistance > 0) ? entryPrice - tpDistance : 0;
   }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   slPrice = NormalizeDouble(slPrice, digits);
   tpPrice = (tpPrice > 0) ? NormalizeDouble(tpPrice, digits) : 0;

   Print("[TS] Placing ", direction, " ", lots, " lots of ", symbol,
         " entry=", entryPrice, " SL=", slPrice, " TP=", tpPrice,
         " (risk=$", riskNzd, " tp=$", tpNzd, ")");

   // Build and send the order
   MqlTradeRequest req = {};
   MqlTradeResult  res = {};

   // Detect the broker-supported filling mode for this symbol
   int fillFlags = (int)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   ENUM_ORDER_TYPE_FILLING filling;
   if((fillFlags & SYMBOL_FILLING_FOK) != 0)       filling = ORDER_FILLING_FOK;
   else if((fillFlags & SYMBOL_FILLING_IOC) != 0)  filling = ORDER_FILLING_IOC;
   else                                             filling = ORDER_FILLING_RETURN;

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = symbol;
   req.volume       = lots;
   req.type         = orderType;
   req.price        = entryPrice;
   req.sl           = slPrice;
   req.tp           = tpPrice;
   req.deviation    = 30;
   req.magic        = MagicNumber;
   req.comment      = "TraderStatistics";
   req.type_filling = filling;

   bool sent = OrderSend(req, res);

   if(sent && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED))
   {
      Print("[TS] Order accepted (filling=", EnumToString(filling), "). Ticket: ", res.deal);
      return true;
   }
   else
   {
      Print("[TS] OrderSend failed. retcode=", res.retcode, " comment=", res.comment);
      return false;
   }
}

//+------------------------------------------------------------------+
//| Trade Transaction — auto-records opens/closes in the app         |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;

   ulong dealTicket = trans.deal;
   if(dealTicket == 0) return;
   if(!HistoryDealSelect(dealTicket)) return;

   if(MagicNumber != 0)
   {
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != MagicNumber) return;
   }

   ENUM_DEAL_ENTRY dealEntry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
   string symbol    = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
   double volume    = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
   double price     = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
   double sl        = HistoryDealGetDouble(dealTicket, DEAL_SL);
   double tp        = HistoryDealGetDouble(dealTicket, DEAL_TP);
   double profit    = HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
   long   posId     = HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   long   dealType  = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
   datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
   string currency  = AccountInfoString(ACCOUNT_CURRENCY);
   string timeStr   = TimeToString(dealTime, TIME_DATE | TIME_MINUTES | TIME_SECONDS);
   string typeName  = (dealType == DEAL_TYPE_BUY) ? "buy" : (dealType == DEAL_TYPE_SELL) ? "sell" : "other";

   if(dealEntry == DEAL_ENTRY_IN)
   {
      Print("[TS] Position opened: ", symbol, " vol=", volume, " @ ", price);

      // Compute actual risk in account currency
      double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
      double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
      double slDist    = (sl > 0) ? MathAbs(price - sl) : 0;
      double riskAmt   = (slDist > 0 && tickSize > 0 && tickValue > 0)
                         ? volume * (slDist / tickSize) * tickValue : 0;
      double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
      double riskPct   = (balance > 0 && riskAmt > 0) ? riskAmt / balance * 100.0 : 0;

      string json = BuildOpenJson(dealTicket, posId, symbol, volume, price, sl, tp, riskAmt, riskPct, timeStr, typeName, currency);
      PostRequest(ServerUrl + "/api/trade/open", json);
   }
   else if(dealEntry == DEAL_ENTRY_OUT || dealEntry == DEAL_ENTRY_OUT_BY)
   {
      Print("[TS] Position closed: ", symbol, " profit=", profit);
      string outcome = (profit >= 0) ? "win" : "loss";
      string json = BuildCloseJson(dealTicket, posId, symbol, volume, price, profit, MathAbs(profit), outcome, timeStr, currency);
      PostRequest(ServerUrl + "/api/trade/close", json);
   }

   // Balance changes after every deal — push updated account state immediately
   PostAccountBalance();
}

//+------------------------------------------------------------------+
//| JSON builders                                                    |
//+------------------------------------------------------------------+
string BuildOpenJson(ulong ticket, long posId, string symbol, double volume,
                     double price, double sl, double tp, double riskAmt, double riskPct,
                     string timeStr, string dealType, string currency)
{
   string j = "{";
   j += "\"source\":\"mt5\",";
   j += "\"mt5Ticket\":"     + IntegerToString(ticket)         + ",";
   j += "\"positionId\":"    + IntegerToString(posId)          + ",";
   j += "\"instrument\":\""  + symbol                          + "\",";
   j += "\"volume\":"        + DoubleToString(volume, 4)       + ",";
   j += "\"investmentSize\":"+ DoubleToString(volume, 4)       + ",";
   j += "\"price\":"         + DoubleToString(price, 8)        + ",";
   j += "\"slPrice\":"       + DoubleToString(sl, 8)           + ",";
   j += "\"sl\":"            + DoubleToString(sl, 8)           + ",";
   j += "\"tp\":"            + DoubleToString(tp, 8)           + ",";
   j += "\"riskNzd\":"       + DoubleToString(riskAmt, 2)      + ",";
   j += "\"riskPct\":"       + DoubleToString(riskPct, 2)      + ",";
   j += "\"openDate\":\""    + timeStr                         + "\",";
   j += "\"dealType\":\""    + dealType                        + "\",";
   j += "\"currency\":\""    + currency                        + "\"";
   j += "}";
   return j;
}

string BuildCloseJson(ulong ticket, long posId, string symbol, double volume,
                      double price, double profit, double amount, string outcome,
                      string timeStr, string currency)
{
   string j = "{";
   j += "\"ticket\":"       + IntegerToString(ticket)          + ",";
   j += "\"mt5Ticket\":"    + IntegerToString(ticket)          + ",";
   j += "\"positionId\":"   + IntegerToString(posId)           + ",";
   j += "\"symbol\":\""     + symbol                           + "\",";
   j += "\"volume\":"       + DoubleToString(volume, 4)        + ",";
   j += "\"price\":"        + DoubleToString(price, 8)         + ",";
   j += "\"profit\":"       + DoubleToString(profit, 2)        + ",";
   j += "\"amount\":"       + DoubleToString(amount, 2)        + ",";
   j += "\"outcome\":\""    + outcome                          + "\",";
   j += "\"closeDate\":\""  + timeStr                          + "\",";
   j += "\"currency\":\""   + currency                         + "\"";
   j += "}";
   return j;
}

//+------------------------------------------------------------------+
//| Account balance sync (MT5 → Angular)                            |
//+------------------------------------------------------------------+
void PostAccountBalance()
{
   double balance     = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity      = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin      = AccountInfoDouble(ACCOUNT_MARGIN);
   double freeMargin  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double marginLevel = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   string currency    = AccountInfoString(ACCOUNT_CURRENCY);

   string json = "{";
   json += "\"balance\":"     + DoubleToString(balance,     2) + ",";
   json += "\"equity\":"      + DoubleToString(equity,      2) + ",";
   json += "\"margin\":"      + DoubleToString(margin,      2) + ",";
   json += "\"freeMargin\":"  + DoubleToString(freeMargin,  2) + ",";
   json += "\"marginLevel\":" + DoubleToString(marginLevel, 2) + ",";
   json += "\"currency\":\"" + currency + "\"";
   json += "}";

   if(PostRequest(ServerUrl + "/api/account", json))
      Print("[TS] Account posted: balance=", balance, " equity=", equity, " margin=", margin, " ", currency);
}

//+------------------------------------------------------------------+
//| Send latest indicator values (MT5 → Angular)                    |
//+------------------------------------------------------------------+
void PostIndicators()
{
   if(g_AO_Handle == INVALID_HANDLE || g_RSI_Handle == INVALID_HANDLE || g_MACD_Handle == INVALID_HANDLE)
      return;

   double ao_buf[], rsi_buf[], macd_main[], macd_signal[];
   ArraySetAsSeries(ao_buf,     true);
   ArraySetAsSeries(rsi_buf,    true);
   ArraySetAsSeries(macd_main,  true);
   ArraySetAsSeries(macd_signal,true);

   if(CopyBuffer(g_AO_Handle,   0, 0, 1, ao_buf)      <= 0) return;
   if(CopyBuffer(g_RSI_Handle,  0, 0, 1, rsi_buf)     <= 0) return;
   if(CopyBuffer(g_MACD_Handle, 0, 0, 1, macd_main)   <= 0) return;
   if(CopyBuffer(g_MACD_Handle, 1, 0, 1, macd_signal) <= 0) return;
   if(ao_buf[0] == EMPTY_VALUE || rsi_buf[0] == EMPTY_VALUE ||
      macd_main[0] == EMPTY_VALUE || macd_signal[0] == EMPTY_VALUE) return;

   datetime barTime = iTime(Symbol(), PERIOD_CURRENT, 0);
   double   macdHist = macd_main[0] - macd_signal[0];

   string json = "{";
   json += "\"symbol\":\"" + Symbol() + "\",";
   json += "\"time\":"     + IntegerToString((long)barTime) + ",";
   json += "\"indicators\":{";
   json += "\"AO\":"         + DoubleToString(ao_buf[0],    5) + ",";
   json += "\"RSI\":"        + DoubleToString(rsi_buf[0],   2) + ",";
   json += "\"MACD_main\":"  + DoubleToString(macd_main[0], 5) + ",";
   json += "\"MACD_signal\":" + DoubleToString(macd_signal[0], 5) + ",";
   json += "\"MACD_hist\":"  + DoubleToString(macdHist,     5);
   json += "}}";

   PostRequest(ServerUrl + "/api/indicators", json);
}

//+------------------------------------------------------------------+
//| Send historical indicator values on startup                      |
//+------------------------------------------------------------------+
void SendHistoricalIndicators(string symbol, ENUM_TIMEFRAMES tf, int count)
{
   if(g_AO_Handle == INVALID_HANDLE || g_RSI_Handle == INVALID_HANDLE || g_MACD_Handle == INVALID_HANDLE)
      return;

   double ao_buf[], rsi_buf[], macd_main[], macd_signal[];
   datetime times[];
   ArraySetAsSeries(ao_buf,     false);
   ArraySetAsSeries(rsi_buf,    false);
   ArraySetAsSeries(macd_main,  false);
   ArraySetAsSeries(macd_signal,false);
   ArraySetAsSeries(times,      false);

   int copied = CopyBuffer(g_AO_Handle, 0, 1, count, ao_buf);
   if(copied <= 0) return;
   CopyBuffer(g_RSI_Handle,  0, 1, copied, rsi_buf);
   CopyBuffer(g_MACD_Handle, 0, 1, copied, macd_main);
   CopyBuffer(g_MACD_Handle, 1, 1, copied, macd_signal);
   CopyTime(symbol, tf, 1, copied, times);

   // Send in chunks of 200
   int chunkSize = 200;
   int chunks = (int)MathCeil((double)copied / chunkSize);
   for(int chunk = 0; chunk < chunks; chunk++)
   {
      int from = chunk * chunkSize;
      int to   = MathMin(from + chunkSize, copied);

      string json = "{\"symbol\":\"" + symbol + "\",\"history\":[";
      for(int i = from; i < to; i++)
      {
         double hist = macd_main[i] - macd_signal[i];
         if(ao_buf[i] == EMPTY_VALUE || rsi_buf[i] == EMPTY_VALUE ||
            macd_main[i] == EMPTY_VALUE || macd_signal[i] == EMPTY_VALUE) continue;
         if(i > from) json += ",";
         json += "{\"time\":"         + IntegerToString((long)times[i]) + ",";
         json += "\"AO\":"            + DoubleToString(ao_buf[i],     5) + ",";
         json += "\"RSI\":"           + DoubleToString(rsi_buf[i],    2) + ",";
         json += "\"MACD_main\":"     + DoubleToString(macd_main[i],  5) + ",";
         json += "\"MACD_signal\":"   + DoubleToString(macd_signal[i],5) + ",";
         json += "\"MACD_hist\":"     + DoubleToString(hist,          5) + "}";
      }
      json += "]}";

      if(!PostRequest(ServerUrl + "/api/indicators/history", json))
      {
         Print("[TS] Indicator history chunk failed");
         return;
      }
   }
   Print("[TS] Sent ", copied, " historical indicator bars for ", symbol);
}

//+------------------------------------------------------------------+
//| Poll margin calc requests from Angular                          |
//+------------------------------------------------------------------+
void PollMarginCalc()
{
   char post[], result[]; string rh;
   int code = WebRequest("GET", ServerUrl + "/api/calc-margin/request",
                         "Content-Type: application/json\r\n", 2000, post, result, rh);
   if(code != 200 || ArraySize(result) == 0) return;
   string json = CharArrayToString(result);
   if(json == "{}" || StringLen(json) < 5) return;

   string sym    = ParseJsonString(json, "symbol");
   string dir    = ParseJsonString(json, "direction");
   double riskNzd = ParseJsonDouble(json, "riskNzd");
   double slPct   = ParseJsonDouble(json, "slPct");
   double slFixed = ParseJsonDouble(json, "slFixed");
   if(sym == "" || riskNzd <= 0 || (slPct <= 0 && slFixed <= 0)) return;

   if(!SymbolSelect(sym, true)) return;
   ENUM_ORDER_TYPE ot = (dir == "sell") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double price = (ot == ORDER_TYPE_BUY) ? ask : bid;
   if(price <= 0) return;

   double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0 || tickValue <= 0) return;

   double slDist = (slFixed > 0) ? slFixed : price * slPct / 100.0;
   double lots   = riskNzd / ((slDist / tickSize) * tickValue);

   double lotStep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double minLot  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   lots = MathMax(minLot, MathMin(maxLot, MathFloor(lots / lotStep) * lotStep));

   double margin = 0;
   OrderCalcMargin(ot, sym, lots, price, margin);

   string body = "{\"margin\":" + DoubleToString(margin, 2) + "}";
   char bodyArr[]; StringToCharArray(body, bodyArr, 0, StringLen(body));
   WebRequest("POST", ServerUrl + "/api/calc-margin/result",
              "Content-Type: application/json\r\n", 2000, bodyArr, result, rh);
}

//+------------------------------------------------------------------+
//| Poll position close commands from Angular                       |
//+------------------------------------------------------------------+
void PollCloseCommands()
{
   char post[], result[]; string rh;
   int code = WebRequest("GET", ServerUrl + "/api/close", "Content-Type: application/json\r\n", 3000, post, result, rh);
   if(code != 200 || ArraySize(result) == 0) return;

   string json = CharArrayToString(result);
   if(json == "[]" || StringLen(json) < 5) return;

   int pos = 0;
   while(true)
   {
      int start = StringFind(json, "{", pos);
      if(start == -1) break;
      int end = StringFind(json, "}", start);
      if(end == -1) break;

      string obj = StringSubstr(json, start, end - start + 1);
      pos = end + 1;

      long cmdId  = ParseJsonLong(obj, "id");
      long ticket = ParseJsonLong(obj, "ticket");
      if(cmdId == 0 || ticket == 0) continue;

      bool ok = ClosePosition((ulong)ticket);
      Print("[TS] Close #", ticket, " → ", ok ? "OK" : "FAILED");

      char delPost[], delResult[]; string delRh;
      WebRequest("DELETE", ServerUrl + "/api/close/" + IntegerToString(cmdId),
                 "Content-Type: application/json\r\n", 3000, delPost, delResult, delRh);
   }
}

bool ClosePosition(ulong ticket)
{
   if(!PositionSelectByTicket(ticket))
   {
      Print("[TS] ClosePosition: #", ticket, " not found");
      return false;
   }

   string symbol = PositionGetString(POSITION_SYMBOL);
   double volume = PositionGetDouble(POSITION_VOLUME);
   long   type   = PositionGetInteger(POSITION_TYPE);

   ENUM_ORDER_TYPE closeType = (type == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double price = (closeType == ORDER_TYPE_SELL)
                  ? SymbolInfoDouble(symbol, SYMBOL_BID)
                  : SymbolInfoDouble(symbol, SYMBOL_ASK);

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action    = TRADE_ACTION_DEAL;
   req.position  = ticket;
   req.symbol    = symbol;
   req.volume    = volume;
   req.type      = closeType;
   req.price     = price;
   req.deviation = 30;
   req.magic     = MagicNumber;
   req.comment   = "TraderStatistics";
   req.type_filling = ORDER_FILLING_FOK;

   bool sent = OrderSend(req, res);
   if(sent && res.retcode == TRADE_RETCODE_DONE) return true;

   req.type_filling = ORDER_FILLING_IOC;
   sent = OrderSend(req, res);
   if(sent && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED)) return true;

   Print("[TS] ClosePosition failed: retcode=", res.retcode, " comment=", res.comment);
   return false;
}

//+------------------------------------------------------------------+
//| Poll SL/TP modification commands from Angular                   |
//+------------------------------------------------------------------+
void PollModifyCommands()
{
   char post[], result[]; string rh;
   int code = WebRequest("GET", ServerUrl + "/api/modify", "Content-Type: application/json\r\n", 3000, post, result, rh);
   if(code != 200 || ArraySize(result) == 0) return;

   string json = CharArrayToString(result);
   if(json == "[]" || StringLen(json) < 5) return;

   int pos = 0;
   while(true)
   {
      int start = StringFind(json, "{", pos);
      if(start == -1) break;
      int end = StringFind(json, "}", start);
      if(end == -1) break;

      string obj = StringSubstr(json, start, end - start + 1);
      pos = end + 1;

      long   cmdId  = ParseJsonLong(obj, "id");
      long   ticket = ParseJsonLong(obj, "ticket");
      double slNzd  = ParseJsonDouble(obj, "slNzd");
      double tpNzd  = ParseJsonDouble(obj, "tpNzd");

      if(cmdId == 0 || ticket == 0) continue;

      bool ok = ModifyPositionByNzd((ulong)ticket, slNzd, tpNzd);
      Print("[TS] Modify #", ticket, " SL=$", slNzd, " TP=$", tpNzd, " → ", ok ? "OK" : "FAILED");

      char delPost[], delResult[]; string delRh;
      WebRequest("DELETE", ServerUrl + "/api/modify/" + IntegerToString(cmdId),
                 "Content-Type: application/json\r\n", 3000, delPost, delResult, delRh);
   }
}

bool ModifyPositionByNzd(ulong ticket, double slNzd, double tpNzd)
{
   if(!PositionSelectByTicket(ticket))
   {
      Print("[TS] ModifyPositionByNzd: ticket #", ticket, " not found");
      return false;
   }

   string symbol  = PositionGetString(POSITION_SYMBOL);
   int    digits  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double entry   = PositionGetDouble(POSITION_PRICE_OPEN);
   double volume  = PositionGetDouble(POSITION_VOLUME);
   long   posType = PositionGetInteger(POSITION_TYPE);
   double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);

   if(tickSize <= 0 || tickValue <= 0 || volume <= 0)
   {
      Print("[TS] ModifyPositionByNzd: cannot get tick info for ", symbol);
      return false;
   }

   // Convert NZD amount → price distance → price level
   double slDist = (slNzd > 0) ? slNzd * tickSize / (tickValue * volume) : 0;
   double tpDist = (tpNzd > 0) ? tpNzd * tickSize / (tickValue * volume) : 0;

   double sl = 0, tp = 0;
   if(posType == POSITION_TYPE_BUY)
   {
      sl = (slDist > 0) ? NormalizeDouble(entry - slDist, digits) : 0;
      tp = (tpDist > 0) ? NormalizeDouble(entry + tpDist, digits) : 0;
   }
   else
   {
      sl = (slDist > 0) ? NormalizeDouble(entry + slDist, digits) : 0;
      tp = (tpDist > 0) ? NormalizeDouble(entry - tpDist, digits) : 0;
   }

   Print("[TS] NZD→Price: entry=", entry, " SL=", sl, " TP=", tp);

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action   = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.symbol   = symbol;
   req.sl       = sl;
   req.tp       = tp;

   bool sent = OrderSend(req, res);
   if(sent && res.retcode == TRADE_RETCODE_DONE) return true;

   Print("[TS] ModifyPositionByNzd failed: retcode=", res.retcode, " comment=", res.comment);
   return false;
}

//+------------------------------------------------------------------+
//| Send historical OHLC bars to the backend                        |
//+------------------------------------------------------------------+
void SendHistoricalBars(string symbol, ENUM_TIMEFRAMES tf, int count)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(symbol, tf, 1, count, rates); // skip bar[0] (forming candle)
   if(copied < 1) { Print("[TS] Could not copy bars for ", symbol); return; }

   int chunkSize = 500;
   int chunks    = (int)MathCeil((double)copied / chunkSize);

   for(int chunk = 0; chunk < chunks; chunk++)
   {
      int from   = chunk * chunkSize;
      int to     = MathMin(from + chunkSize, copied);
      bool first = (chunk == 0);

      string json = "{\"symbol\":\"" + symbol + "\","
                  + "\"timeframe\":" + IntegerToString(PeriodSeconds(tf)) + ","
                  + "\"append\":"    + (first ? "false" : "true") + ","
                  + "\"bars\":[";
      for(int i = from; i < to; i++)
      {
         if(i > from) json += ",";
         json += "{\"time\":"  + IntegerToString((long)rates[i].time) + ","
               + "\"open\":"   + DoubleToString(rates[i].open,  8) + ","
               + "\"high\":"   + DoubleToString(rates[i].high,  8) + ","
               + "\"low\":"    + DoubleToString(rates[i].low,   8) + ","
               + "\"close\":"  + DoubleToString(rates[i].close, 8) + "}";
      }
      json += "]}";

      if(!PostRequest(ServerUrl + "/api/bars", json))
      {
         Print("[TS] Bars chunk ", chunk+1, "/", chunks, " failed — aborting");
         return;
      }
      Print("[TS] Bars chunk ", chunk+1, "/", chunks, " sent (", from, "–", to-1, ")");
   }

   Print("[TS] Done: ", copied, " bars sent in ", chunks, " chunks for ", symbol);
   g_ChartSymbol = symbol;
}

//+------------------------------------------------------------------+
//| Post the current forming candle                                  |
//+------------------------------------------------------------------+
void PostCurrentBar()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   if(CopyRates(Symbol(), PERIOD_CURRENT, 0, 1, rates) < 1) return;

   long secsLeft = (long)(rates[0].time + PeriodSeconds(PERIOD_CURRENT)) - (long)TimeCurrent();
   if(secsLeft < 0) secsLeft = 0;
   if(secsLeft > 60) secsLeft = 60;

   string json = "{\"symbol\":\"" + Symbol() + "\","
               + "\"secsLeft\":" + IntegerToString(secsLeft) + ","
               + "\"bar\":{"
               + "\"time\":"  + IntegerToString((long)rates[0].time) + ","
               + "\"open\":"  + DoubleToString(rates[0].open,  8) + ","
               + "\"high\":"  + DoubleToString(rates[0].high,  8) + ","
               + "\"low\":"   + DoubleToString(rates[0].low,   8) + ","
               + "\"close\":" + DoubleToString(rates[0].close, 8) + "}}";

   // Use a silent POST — bar update failures don't trigger the global backoff
   char post[], result[]; string rh;
   StringToCharArray(json, post, 0, StringLen(json));
   WebRequest("POST", ServerUrl + "/api/bar/update", "Content-Type: application/json\r\n", 2000, post, result, rh);
}

//+------------------------------------------------------------------+
//| Post all open positions with SL/TP                              |
//+------------------------------------------------------------------+
void SendOpenPositions()
{
   string json = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(MagicNumber != 0 && PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;

      string sym    = PositionGetString(POSITION_SYMBOL);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      double price  = PositionGetDouble(POSITION_PRICE_OPEN);
      double profit = PositionGetDouble(POSITION_PROFIT);
      double volume = PositionGetDouble(POSITION_VOLUME);
      long   type   = PositionGetInteger(POSITION_TYPE);

      double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
      double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);

      // NZD risk if SL is hit (always negative — it's a loss)
      double slNzd = 0;
      if(sl > 0 && tickSize > 0 && tickValue > 0)
         slNzd = -(MathAbs(price - sl) / tickSize * tickValue * volume);

      // NZD reward if TP is hit (always positive — it's a gain)
      double tpNzd = 0;
      if(tp > 0 && tickSize > 0 && tickValue > 0)
         tpNzd = MathAbs(tp - price) / tickSize * tickValue * volume;

      if(!first) json += ",";
      json += "{\"ticket\":"  + IntegerToString((long)ticket) + ","
            + "\"symbol\":\""  + sym   + "\","
            + "\"sl\":"        + DoubleToString(sl,     8) + ","
            + "\"tp\":"        + DoubleToString(tp,     8) + ","
            + "\"slNzd\":"     + DoubleToString(slNzd,  2) + ","
            + "\"tpNzd\":"     + DoubleToString(tpNzd,  2) + ","
            + "\"price\":"     + DoubleToString(price,   8) + ","
            + "\"profit\":"    + DoubleToString(profit,  2) + ","
            + "\"type\":\""    + (type == POSITION_TYPE_BUY ? "buy" : "sell") + "\"}";
      first = false;
   }
   json += "]";
   PostRequest(ServerUrl + "/api/positions", json);
}

//+------------------------------------------------------------------+
//| HTTP helpers                                                     |
//+------------------------------------------------------------------+
bool PostRequest(string url, string body)
{
   char post[], result[]; string rh;
   StringToCharArray(body, post, 0, StringLen(body));
   int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, post, result, rh);
   if(code == 200 || code == 201)
   {
      g_LastFailedPost = 0; // clear backoff on success
      return true;
   }
   if(g_LastFailedPost == 0) // only log the first failure, not every retry
      Print("[TS] POST failed. code=", code, " url=", url, ". Retrying in ", g_FailBackoffSec, "s.");
   g_LastFailedPost = TimeCurrent();
   return false;
}

//+------------------------------------------------------------------+
//| Minimal JSON field parsers (no external library needed)          |
//+------------------------------------------------------------------+
string ParseJsonString(string json, string key)
{
   string search = "\"" + key + "\":\"";
   int s = StringFind(json, search);
   if(s == -1) return "";
   s += StringLen(search);
   int e = StringFind(json, "\"", s);
   if(e == -1) return "";
   return StringSubstr(json, s, e - s);
}

double ParseJsonDouble(string json, string key)
{
   string search = "\"" + key + "\":";
   int s = StringFind(json, search);
   if(s == -1) return 0;
   s += StringLen(search);
   // Read until comma, } or ]
   string val = "";
   for(int i = s; i < StringLen(json); i++)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == ',' || c == '}' || c == ']') break;
      val += ShortToString(c);
   }
   return StringToDouble(val);
}

long ParseJsonLong(string json, string key)
{
   return (long)ParseJsonDouble(json, key);
}

//+------------------------------------------------------------------+
