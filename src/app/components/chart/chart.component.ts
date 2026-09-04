import {
  Component, OnInit, OnDestroy, AfterViewInit,
  ViewChild, ElementRef, ChangeDetectorRef, NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import {
  createChart, IChartApi, ISeriesApi,
  CrosshairMode, LineStyle, ColorType,
  CandlestickSeries, LineSeries, HistogramSeries,
} from 'lightweight-charts';
import { TradeService } from '../../services/trade.service';
import { WebSocketService, Position, DOMData, DOMLevel, TradingState } from '../../services/websocket.service';

@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chart.component.html',
  styleUrls: ['./chart.component.scss'],
})
export class ChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartContainer') chartContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('indicatorPanesEl') indicatorPanesEl!: ElementRef<HTMLDivElement>;
  @ViewChild('tickChartContainer') tickChartContainer!: ElementRef<HTMLDivElement>;

  symbol = '';
  activeSymbol = '';
  positions: Position[] = [];
  loadError = '';
  timeframeLabel = '';
  secsLeft: number | null = null;
  private nzdusd = 0.6;

  get secsLeftLabel(): string {
    if (this.secsLeft === null) return '';
    return this.formatSecsLeft(this.secsLeft);
  }

  private formatSecsLeft(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  private lastClose = 0;
  private lastOpen = 0;
  modifyForms: Record<number, { slNzd: number; tpNzd: number; saving: boolean; saved: boolean }> = {};

  // Open trade form
  tradeDirection: 'buy' | 'sell' = 'buy';
  riskMode: 'pct' | 'fixed' = 'pct';
  riskPct   = 0.5;  // % of balance to risk if SL hit
  riskFixed = 20;   // fixed NZD risk if SL hit
  tradeSlMode: 'pct' | 'fixed' = 'pct';
  tradeSl     = 1;    // SL distance as % of entry price
  tradeSlFixed = 0;   // SL distance as fixed price units
  tradeTp   = 4;    // TP distance as % of entry price
  tradePlacing = false;
  tradeCooldown = 0;
  tradeError = '';
  accountBalance = 0;
  freeMargin = 0;

  tradeTpNzd = 80;  // desired TP profit in NZD (used when autoRR is off)
  tradeAutoRR = true;
  tradeRRMultiplier = 4;

  get tradeEffectiveTp(): number {
    return this.tradeAutoRR ? +(this.tradeRiskNzd * this.tradeRRMultiplier).toFixed(2) : this.tradeTpNzd;
  }

  get tradeRiskNzd(): number {
    return this.riskMode === 'pct'
      ? +(this.accountBalance * this.riskPct / 100).toFixed(2)
      : this.riskFixed;
  }
  get tradeRR(): string { return this.tradeRiskNzd ? (this.tradeEffectiveTp / this.tradeRiskNzd).toFixed(2) : '—'; }
  get maxRisk(): number    { return +(this.accountBalance * 0.02).toFixed(2); }
  get overLimit(): boolean { return this.accountBalance > 0 && this.tradeRiskNzd > this.maxRisk; }
  get marginInsufficient(): boolean {
    return this.freeMargin > 0 && this.marginNzd !== null && this.marginNzd > this.freeMargin;
  }
  lineMarginInsufficient(d: (typeof this.drawnLines)[0]): boolean {
    return this.freeMargin > 0 && d.marginNzd !== null && d.marginNzd > this.freeMargin;
  }

  currentAsk = 0;
  marginNzd: number | null = null;
  private marginCalcDebounce?: ReturnType<typeof setTimeout>;

  private get autoSlFixed(): number {
    return this.candleStats?.avgRange ? +this.candleStats.avgRange.toFixed(8) : 0;
  }

  requestMarginCalc(): void {
    if (!this.activeSymbol || !this.tradeRiskNzd) { this.marginNzd = null; return; }
    const slFixed = this.autoSlFixed;
    const slPct   = slFixed ? 0 : 1; // fallback 1% if no bar data yet
    if (!slPct && !slFixed) { this.marginNzd = null; return; }
    clearTimeout(this.marginCalcDebounce);
    this.marginCalcDebounce = setTimeout(() => {
      this.tradeService.requestMarginCalc(this.activeSymbol, this.tradeDirection, this.tradeRiskNzd, slPct, slFixed)
        .subscribe({ next: () => this.pollMarginResult(), error: () => {} });
    }, 400);
  }

  private pollMarginResult(attempts = 0): void {
    if (attempts > 15) return;
    this.tradeService.getMarginCalcResult().subscribe({
      next: r => {
        if (r?.margin != null) { this.marginNzd = r.margin; this.cdr.detectChanges(); }
        else setTimeout(() => this.pollMarginResult(attempts + 1), 200);
      },
      error: () => {},
    });
  }

  // Close state per ticket
  closingTickets = new Set<number>();

  // ── Drawing ───────────────────────────────────────────────────────
  drawMode = false;
  pendingDrawPrice: number | null = null;
  drawLabel = '';
  drawColor = '#facc15';
  readonly DRAW_COLORS = [
    { value: '#facc15', label: 'Yellow' },
    { value: '#f87171', label: 'Red'    },
    { value: '#4ade80', label: 'Green'  },
    { value: '#60a5fa', label: 'Blue'   },
    { value: '#c084fc', label: 'Purple' },
    { value: '#ffffff', label: 'White'  },
  ];
  drawnLines: {
    id: string; label: string; price: number; color: string; line: any;
    // order config — persisted
    orderDirection: 'buy' | 'sell';
    orderRiskMode: 'pct' | 'fixed';
    orderRiskPct: number;
    orderRiskNzd: number;
    orderSlMode: 'pct' | 'fixed';
    orderSlPct: number;
    orderSlFixed: number;
    orderAutoRR: boolean;
    orderRRMultiplier: number;
    orderTpNzd: number;
    // order config — persisted
    orderArmed: boolean;
    // ui state — not persisted
    showOrder: boolean;
    orderStatus: 'idle' | 'sending' | 'sent' | 'error';
    marginNzd: number | null;
  }[] = [];

  lineRiskNzd(d: (typeof this.drawnLines)[0]): number {
    return d.orderRiskMode === 'pct'
      ? +(this.accountBalance * d.orderRiskPct / 100).toFixed(2)
      : d.orderRiskNzd;
  }
  lineEffectiveTp(d: (typeof this.drawnLines)[0]): number {
    return d.orderAutoRR ? +(this.lineRiskNzd(d) * d.orderRRMultiplier).toFixed(2) : d.orderTpNzd;
  }
  lineRR(d: (typeof this.drawnLines)[0]): string {
    const r = this.lineRiskNzd(d);
    return r ? (this.lineEffectiveTp(d) / r).toFixed(2) : '—';
  }
  lineOverLimit(d: (typeof this.drawnLines)[0]): boolean {
    return this.accountBalance > 0 && this.lineRiskNzd(d) > this.maxRisk;
  }

  toggleLineArmed(d: (typeof this.drawnLines)[0]): void {
    d.orderArmed = !d.orderArmed;
    // Reset prev prices so the first tick doesn't false-fire
    this.prevAsk = 0;
    this.prevBid = 0;
    this.saveDrawnLines();
    this.cdr.detectChanges();
  }

  private checkLineTriggers(ask: number, bid: number): void {
    if (!this.prevAsk || !this.prevBid) return;
    for (const d of this.drawnLines) {
      if (!d.orderArmed || d.orderStatus !== 'idle') continue;
      const price = d.orderDirection === 'buy' ? ask  : bid;
      const prev  = d.orderDirection === 'buy' ? this.prevAsk : this.prevBid;
      const crossed = (prev > d.price && price <= d.price) ||
                      (prev < d.price && price >= d.price);
      if (crossed) {
        this.ngZone.run(() => this.executeLineOrder(d));
      }
    }
  }

  requestLineMarginCalc(d: (typeof this.drawnLines)[0]): void {
    if (!this.activeSymbol) { d.marginNzd = null; return; }
    const risk    = this.lineRiskNzd(d);
    const slPct   = d.orderSlMode === 'pct'   ? d.orderSlPct   : 0;
    const slFixed = d.orderSlMode === 'fixed' ? d.orderSlFixed : 0;
    if (!risk || (!slPct && !slFixed)) { d.marginNzd = null; return; }
    clearTimeout(this._lineMarginDebounces.get(d.id));
    this._lineMarginDebounces.set(d.id, setTimeout(() => {
      this.tradeService.requestMarginCalc(this.activeSymbol, d.orderDirection, risk, slPct, slFixed)
        .subscribe({ next: () => this.pollLineMarginResult(d), error: () => {} });
    }, 400));
  }

  private pollLineMarginResult(d: (typeof this.drawnLines)[0], attempts = 0): void {
    if (attempts > 15) return;
    this.tradeService.getMarginCalcResult().subscribe({
      next: r => {
        if (r?.margin != null) { d.marginNzd = r.margin; this.cdr.detectChanges(); }
        else setTimeout(() => this.pollLineMarginResult(d, attempts + 1), 200);
      },
      error: () => {},
    });
  }

  private dragging:
    | { kind: 'drawn';    id: string }
    | { kind: 'position'; ticket: number; type: 'sl' | 'tp' }
    | null = null;
  private _wasDragging = false;
  private _chartCleanup: (() => void)[] = [];
  private _lineMarginDebounces = new Map<string, ReturnType<typeof setTimeout>>();
  private prevAsk = 0;
  private prevBid = 0;

  private chart: IChartApi | null = null;
  private candleSeries: ISeriesApi<'Candlestick', any> | null = null;
  private domWallEl: HTMLDivElement | null = null;
  private tickChart: IChartApi | null = null;
  private tickSeries: ISeriesApi<'Line', any> | null = null;
  private tickResizeObserver: ResizeObserver | null = null;
  private tickIndex = 0;

  // ── Position odds ────────────────────────────────────────────────
  positionOdds: Map<number, { pSL: number; pTP: number; samples: number }> = new Map();

  private computePositionOdds(): void {
    const bars = this.barData.slice(0, -1);
    if (bars.length < 10 || !this.positions.length) return;

    const MAX_FORWARD = 100; // bars to look ahead per simulation
    const result = new Map<number, { pSL: number; pTP: number; samples: number }>();

    for (const pos of this.positions) {
      if (!pos.sl || !pos.tp) { result.set(pos.ticket, { pSL: 50, pTP: 50, samples: 0 }); continue; }
      const isBuy  = pos.type === 'buy';
      const slDist = Math.abs(pos.price - pos.sl);
      const tpDist = Math.abs(pos.tp   - pos.price);
      if (slDist <= 0 || tpDist <= 0) { result.set(pos.ticket, { pSL: 50, pTP: 50, samples: 0 }); continue; }

      let slCount = 0, tpCount = 0, resolved = 0;

      for (let i = 0; i < bars.length - 1; i++) {
        const entry   = bars[i].open;
        const slLevel = isBuy ? entry - slDist : entry + slDist;
        const tpLevel = isBuy ? entry + tpDist : entry - tpDist;

        for (let j = i; j < Math.min(i + MAX_FORWARD, bars.length); j++) {
          const b     = bars[j];
          const hitSL = isBuy ? b.low  <= slLevel : b.high >= slLevel;
          const hitTP = isBuy ? b.high >= tpLevel : b.low  <= tpLevel;

          if (!hitSL && !hitTP) continue;

          // Both hit in same candle — use candle direction as tiebreaker:
          // if the candle closed in the TP direction, TP likely hit first
          if (hitSL && hitTP) {
            const tpFirst = isBuy ? b.close >= b.open : b.close <= b.open;
            if (tpFirst) tpCount++; else slCount++;
          } else if (hitTP) {
            tpCount++;
          } else {
            slCount++;
          }
          resolved++;
          break;
        }
      }

      const total = slCount + tpCount;
      result.set(pos.ticket, {
        pSL:     total > 0 ? (slCount / total) * 100 : 50,
        pTP:     total > 0 ? (tpCount / total) * 100 : 50,
        samples: resolved,
      });
    }

    this.positionOdds = result;
    this.cdr.detectChanges();
  }

  // ── Candle & streak statistics ───────────────────────────────────
  candleStats: {
    pGreen: number; pRed: number;
    greenCount: number; redCount: number;
    avgRange: number; maxRange: number; minRange: number;
    avgUpMove: number; avgDownMove: number;
    sampleSize: number;
  } | null = null;

  private computeCandleStats(): void {
    const bars = this.barData.slice(0, -1); // exclude forming candle
    if (bars.length < 2) { this.candleStats = null; return; }

    let green = 0, red = 0;
    let totalRange = 0, maxRange = 0, minRange = Infinity;
    let totalUp = 0, totalDown = 0;

    for (const b of bars) {
      const range = b.high - b.low;
      if (b.close > b.open) green++; else if (b.close < b.open) red++;
      totalRange += range;
      totalUp   += b.high - b.open;
      totalDown += b.open - b.low;
      if (range > maxRange) maxRange = range;
      if (range < minRange) minRange = range;
    }

    const total = green + red;
    const n = bars.length;
    this.candleStats = {
      pGreen: total ? (green / total) * 100 : 50,
      pRed:   total ? (red   / total) * 100 : 50,
      greenCount: green, redCount: red,
      avgRange:  totalRange / n,
      maxRange,
      minRange:  minRange === Infinity ? 0 : minRange,
      avgUpMove:   totalUp   / n,
      avgDownMove: totalDown / n,
      sampleSize: n,
    };
    this.cdr.detectChanges();
  }

  streakStats: {
    currentColor: 'green' | 'red' | 'none';
    currentCount: number;
    pContinue: number;
    pReverse: number;
    samples: number;
    greenStreaks: { length: number; count: number; chance: number }[];
    redStreaks:   { length: number; count: number; chance: number }[];
  } | null = null;

  private computeStreakStats(): void {
    const bars = this.barData.slice(0, -1);
    if (bars.length < 5) { this.streakStats = null; return; }

    const colors: ('green' | 'red' | 'doji')[] = bars.map((b: any) =>
      b.close > b.open ? 'green' : b.close < b.open ? 'red' : 'doji'
    );

    // Streak length ending at each index
    const streakLen: number[] = new Array(colors.length).fill(0);
    for (let j = 0; j < colors.length; j++) {
      if (colors[j] === 'doji') { streakLen[j] = 0; continue; }
      streakLen[j] = (j > 0 && colors[j] === colors[j - 1]) ? streakLen[j - 1] + 1 : 1;
    }

    // Current streak (from end of completed bars)
    let currentColor: 'green' | 'red' | 'none' = 'none';
    let currentCount = 0;
    for (let j = colors.length - 1; j >= 0; j--) {
      if (colors[j] === 'doji') break;
      if (currentColor === 'none') { currentColor = colors[j] as 'green' | 'red'; currentCount = 1; }
      else if (colors[j] === currentColor) currentCount++;
      else break;
    }

    // P(continue | currentCount consecutive currentColor)
    let continueCount = 0, reverseCount = 0;
    if (currentColor !== 'none') {
      for (let j = currentCount - 1; j < colors.length - 1; j++) {
        if (colors[j] !== currentColor || streakLen[j] < currentCount) continue;
        const next = colors[j + 1];
        if (next === currentColor) continueCount++;
        else if (next !== 'doji') reverseCount++;
      }
    }

    // Streak distribution (count distinct groups of each length)
    const greenMap = new Map<number, number>();
    const redMap   = new Map<number, number>();
    // Walk through and record each streak's total length when it ends
    for (let j = 0; j < colors.length; j++) {
      const isEnd = j === colors.length - 1 || colors[j + 1] !== colors[j];
      if (!isEnd || colors[j] === 'doji') continue;
      const map = colors[j] === 'green' ? greenMap : redMap;
      map.set(streakLen[j], (map.get(streakLen[j]) || 0) + 1);
    }

    const toArr = (m: Map<number, number>) => {
      const entries = Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
      const total = entries.reduce((s, [, c]) => s + c, 0);
      return entries.map(([length, count]) => ({ length, count, chance: total ? (count / total) * 100 : 0 }));
    };

    const total = continueCount + reverseCount;
    this.streakStats = {
      currentColor,
      currentCount,
      pContinue: total > 0 ? (continueCount / total) * 100 : 50,
      pReverse:  total > 0 ? (reverseCount  / total) * 100 : 50,
      samples: total,
      greenStreaks: toArr(greenMap),
      redStreaks:   toArr(redMap),
    };
    this.cdr.detectChanges();
  }

  domStats: {
    bidVolume: number; askVolume: number;
    bidPct: number;    askPct: number;
    biggestBid: DOMLevel; biggestAsk: DOMLevel;
    wallImbalance: number; // bid wall / ask wall ratio
    signal: 'bullish' | 'bearish' | 'neutral';
    signalStrength: number; // 0-100
    topBids: DOMLevel[]; topAsks: DOMLevel[];
  } | null = null;

  private processDOMData(data: DOMData): void {
    if (data.symbol !== this.activeSymbol) return;
    const bids = data.bids ?? [];
    const asks = data.asks ?? [];
    if (!bids.length && !asks.length) return;

    const bidVol = bids.reduce((s, l) => s + l.volume, 0);
    const askVol = asks.reduce((s, l) => s + l.volume, 0);
    const total  = bidVol + askVol || 1;
    const bidPct = (bidVol / total) * 100;
    const askPct = (askVol / total) * 100;

    const biggestBid = bids.reduce((m, l) => l.volume > m.volume ? l : m, bids[0] ?? { price: 0, volume: 0 });
    const biggestAsk = asks.reduce((m, l) => l.volume > m.volume ? l : m, asks[0] ?? { price: 0, volume: 0 });
    const wallImbalance = biggestAsk.volume > 0 ? biggestBid.volume / biggestAsk.volume : 0;

    // Sort bids descending by price (closest to mid first), asks ascending
    const topBids = [...bids].sort((a, b) => b.price - a.price).slice(0, 8);
    const topAsks = [...asks].sort((a, b) => a.price - b.price).slice(0, 8);

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let signalStrength = 50;
    if (bidPct > 58) { signal = 'bullish'; signalStrength = Math.min(100, bidPct); }
    else if (askPct > 58) { signal = 'bearish'; signalStrength = Math.min(100, askPct); }

    this.domStats = { bidVolume: bidVol, askVolume: askVol, bidPct, askPct,
      biggestBid, biggestAsk, wallImbalance, signal, signalStrength, topBids, topAsks };
    this.updateWallOverlay();
    this.cdr.detectChanges();
  }

  formatStat(val: number): string {
    if (!val) return '0';
    if (val >= 100)  return val.toFixed(1);
    if (val >= 1)    return val.toFixed(2);
    if (val >= 0.01) return val.toFixed(4);
    if (val >= 0.0001) return val.toFixed(5);
    return val.toFixed(6);
  }

  tickChartWidth = parseInt(localStorage.getItem('tick_chart_width') || '180', 10);
  tickChartResizing = false;
  private _resizeStartX = 0;
  private _resizeStartWidth = 0;

  onResizeHandleMouseDown(e: MouseEvent): void {
    this.tickChartResizing = true;
    this._resizeStartX = e.clientX;
    this._resizeStartWidth = this.tickChartWidth;
    e.preventDefault();
  }
  private priceLines: Map<string, any> = new Map();
  private countdownPriceLine: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private subs = new Subscription();

  private lastPositionsJson = '';
  private tradeCooldownInterval?: ReturnType<typeof setInterval>;
  private _syncingTimeAxis = false;
  private _syncingCrosshair = false;

  // ── Bar data (full OHLC — used by MA, RSI, MACD, AO) ────────────
  private barData: any[] = [];

  // ── Moving Average ───────────────────────────────────────────────
  maEnabled = false;
  maPeriod = 20;
  maType: 'SMA' | 'EMA' = 'SMA';
  private maSeries: ISeriesApi<'Line', any> | null = null;

  toggleMA(): void {
    this.maEnabled = !this.maEnabled;
    if (this.maEnabled) this.refreshMA();
    else this.maSeries?.setData([]);
  }

  onMAParamChange(): void {
    if (this.maEnabled) this.refreshMA();
  }

  private refreshMA(): void {
    if (!this.maEnabled || !this.maSeries || this.barData.length < this.maPeriod) return;
    this.maSeries.setData(this.computeMAData() as any);
  }

  private computeMAData(): { time: any; value: number }[] {
    const bars = this.barData;
    const period = this.maPeriod;
    const result: { time: any; value: number }[] = [];
    if (this.maType === 'SMA') {
      for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
        result.push({ time: bars[i].time, value: sum / period });
      }
    } else {
      const k = 2 / (period + 1);
      let ema = 0;
      for (let i = 0; i < period; i++) ema += bars[i].close;
      ema /= period;
      result.push({ time: bars[period - 1].time, value: ema });
      for (let i = period; i < bars.length; i++) {
        ema = bars[i].close * k + ema * (1 - k);
        result.push({ time: bars[i].time, value: ema });
      }
    }
    return result;
  }

  // ── Indicators (client-side) ─────────────────────────────────────
  rsiEnabled = false;
  rsiPeriod = 14;

  macdEnabled = false;
  macdFast = 12;
  macdSlow = 26;
  macdSignalPeriod = 9;

  aoEnabled = false;

  indicatorPanes: Map<string, {
    el: HTMLDivElement;
    chart: IChartApi;
    series: ISeriesApi<any>[];
    resizeObserver: ResizeObserver;
  }> = new Map();

  toggleRSI(): void {
    this.rsiEnabled = !this.rsiEnabled;
    if (this.rsiEnabled) this.addIndicator('RSI', `RSI (${this.rsiPeriod})`);
    else this.removeIndicator('RSI');
  }

  onRSIParamChange(): void {
    this.updateIndicatorLabel('RSI', `RSI (${this.rsiPeriod})`);
    if (this.rsiEnabled) this.refreshIndicator('RSI');
  }

  toggleMACD(): void {
    this.macdEnabled = !this.macdEnabled;
    if (this.macdEnabled) this.addIndicator('MACD', this.macdLabel);
    else this.removeIndicator('MACD');
  }

  onMACDParamChange(): void {
    this.updateIndicatorLabel('MACD', this.macdLabel);
    if (this.macdEnabled) this.refreshIndicator('MACD');
  }

  get macdLabel(): string { return `MACD (${this.macdFast},${this.macdSlow},${this.macdSignalPeriod})`; }

  toggleAO(): void {
    this.aoEnabled = !this.aoEnabled;
    if (this.aoEnabled) this.addIndicator('AO', 'Awesome Oscillator');
    else this.removeIndicator('AO');
  }

  private updateIndicatorLabel(name: string, label: string): void {
    const pane = this.indicatorPanes.get(name);
    if (!pane) return;
    const span = pane.el.querySelector('.ind-pane-label');
    if (span) span.textContent = label;
  }

  private refreshIndicator(name: string): void {
    const pane = this.indicatorPanes.get(name);
    if (!pane?.chart) return;
    if (name === 'RSI') {
      pane.series[0].setData(this.computeRSI(this.rsiPeriod) as any);
    } else if (name === 'MACD') {
      const { hist, main, sig } = this.computeMACD(this.macdFast, this.macdSlow, this.macdSignalPeriod);
      pane.series[0].setData(hist as any);
      pane.series[1].setData(main as any);
      pane.series[2].setData(sig as any);
    } else if (name === 'AO') {
      pane.series[0].setData(this.computeAO() as any);
    }
  }

  private refreshAllIndicators(): void {
    if (this.rsiEnabled)  this.refreshIndicator('RSI');
    if (this.macdEnabled) this.refreshIndicator('MACD');
    if (this.aoEnabled)   this.refreshIndicator('AO');
  }

  private computeEMAArray(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = new Array(period - 1).fill(NaN);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(ema);
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  private computeRSI(period: number): { time: any; value: number }[] {
    const bars = this.barData;
    if (bars.length <= period) return [];
    const result: { time: any; value: number }[] = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = bars[i].close - bars[i - 1].close;
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    result.push({ time: bars[period].time, value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
    for (let i = period + 1; i < bars.length; i++) {
      const d = bars[i].close - bars[i - 1].close;
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
      result.push({ time: bars[i].time, value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss) });
    }
    return result;
  }

  private computeMACD(fast: number, slow: number, signal: number): {
    hist: { time: any; value: number; color: string }[];
    main: { time: any; value: number }[];
    sig:  { time: any; value: number }[];
  } {
    const bars = this.barData;
    const closes = bars.map((b: any) => b.close as number);
    if (closes.length < slow + signal) return { hist: [], main: [], sig: [] };
    const emaFast = this.computeEMAArray(closes, fast);
    const emaSlow = this.computeEMAArray(closes, slow);
    const macdLine: number[] = [];
    const macdTimes: any[] = [];
    for (let i = slow - 1; i < closes.length; i++) {
      macdLine.push(emaFast[i] - emaSlow[i]);
      macdTimes.push(bars[i].time);
    }
    const sigLine = this.computeEMAArray(macdLine, signal);
    const main: { time: any; value: number }[] = [];
    const sig:  { time: any; value: number }[] = [];
    const hist: { time: any; value: number; color: string }[] = [];
    for (let i = signal - 1; i < macdLine.length; i++) {
      if (isNaN(sigLine[i])) continue;
      const t = macdTimes[i];
      const h = macdLine[i] - sigLine[i];
      main.push({ time: t, value: macdLine[i] });
      sig.push({ time: t, value: sigLine[i] });
      hist.push({ time: t, value: h, color: h >= 0 ? '#22c55e' : '#ef4444' });
    }
    return { main, sig, hist };
  }

  private computeAO(): { time: any; value: number; color: string }[] {
    const bars = this.barData;
    if (bars.length < 34) return [];
    const result: { time: any; value: number; color: string }[] = [];
    const mid = bars.map((b: any) => (b.high + b.low) / 2);
    let prev = 0;
    for (let i = 33; i < bars.length; i++) {
      let s5 = 0, s34 = 0;
      for (let j = i - 4; j <= i; j++) s5 += mid[j];
      for (let j = i - 33; j <= i; j++) s34 += mid[j];
      const val = s5 / 5 - s34 / 34;
      result.push({ time: bars[i].time, value: val, color: val >= prev ? '#22c55e' : '#ef4444' });
      prev = val;
    }
    return result;
  }

  tradingState: TradingState = { enabled: true, disabledReason: null, consecutiveLosses: 0, tradesToday: 0 };
  accountType: 'demo' | 'real' | null = null;

  get tradingBlocked(): boolean {
    return !this.tradingState.enabled && this.accountType === 'real';
  }

  constructor(
    private tradeService: TradeService,
    private ws: WebSocketService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    // Track account balance for invest cap
    this.subs.add(this.ws.account$.subscribe(a => {
      if (a.balance)     this.accountBalance = a.balance;
      if (a.freeMargin)  this.freeMargin     = a.freeMargin;
      if (a.accountType) this.accountType    = a.accountType;
    }));
    this.tradeService.getAccount().subscribe({
      next: a => {
        if (a.balance)    this.accountBalance = a.balance;
        if (a.freeMargin) this.freeMargin     = a.freeMargin;
      },
      error: () => {},
    });

    // Track NZDUSD rate for USD→NZD conversion
    this.subs.add(this.ws.price$.subscribe(p => {
      if (p.nzdusdBid && p.nzdusdBid > 0) this.nzdusd = p.nzdusdBid;
    }));

    // DOM data
    this.subs.add(this.ws.dom$.subscribe(data => this.processDOMData(data)));

    // Trading circuit breaker
    this.subs.add(this.ws.tradingState$.subscribe(s => {
      this.tradingState = s;
      this.cdr.detectChanges();
    }));

    // Auto-populate symbol from the live price stream + feed tick chart
    this.subs.add(this.ws.price$.subscribe(p => {
      if (!this.symbol) this.symbol = p.symbol;
      if (p.symbol === this.activeSymbol) {
        this.currentAsk = p.ask;
        this.checkLineTriggers(p.ask, p.bid);
        this.prevAsk = p.ask;
        this.prevBid = p.bid;
        this.ngZone.runOutsideAngular(() => this.addTickPoint(p.ask));
      }
      this.cdr.detectChanges();
    }));

    // Live bar updates — secsLeft driven purely by MT5
    this.subs.add(this.ws.barUpdate$.subscribe(data => {
      if (data.symbol !== this.activeSymbol) return;
      this.lastClose = data.bar.close;
      this.lastOpen  = data.bar.open;
      if (data.secsLeft !== null) this.secsLeft = data.secsLeft;
      // Update barData for all client-side indicators
      const barTime = (data.bar as any).time;
      const last = this.barData[this.barData.length - 1];
      if (last && last.time === barTime) Object.assign(last, data.bar);
      else { this.barData.push({ ...data.bar }); this.resetTickChart(); }
      this.ngZone.runOutsideAngular(() => {
        this.candleSeries?.update(data.bar as any);
        this.updateCountdownPriceLine(this.lastClose, this.secsLeft);
        this.refreshMA();
        this.refreshAllIndicators();
        this.updateWallOverlay();
      });
      this.cdr.detectChanges();
    }));

    // Live position updates — only re-render price lines when SL/TP changes; update profit in-place
    this.subs.add(this.ws.positions$.subscribe(positions => {
      const filtered = positions.filter(p => p.symbol === this.activeSymbol);

      // Always update profit in-place so display stays live without recreating DOM
      let profitChanged = false;
      filtered.forEach(newPos => {
        const existing = this.positions.find(p => p.ticket === newPos.ticket);
        if (existing && existing.profit !== newPos.profit) {
          existing.profit = newPos.profit;
          profitChanged = true;
        }
      });
      if (profitChanged) this.cdr.detectChanges();

      // Only re-render price lines + forms when SL/TP actually changes
      const slTpKey = filtered.map(p => `${p.ticket}:${p.sl}:${p.tp}`).join('|');
      if (slTpKey === this.lastPositionsJson) return;
      this.lastPositionsJson = slTpKey;
      this.positions = filtered;
      this.syncModifyForms();
      this.renderPriceLines();
      this.cdr.detectChanges();
    }));

    // Initial positions from HTTP
    this.tradeService.getPositions().subscribe({
      next: positions => {
        this.positions = positions.filter((p: Position) => p.symbol === this.activeSymbol);
        this.renderPriceLines();
      },
      error: () => {},
    });
  }

  ngAfterViewInit(): void {
    this.buildChart();
    this.buildWallOverlay();
    this.buildTickChart();
    this.restoreState();
  }

  private _pendingMA   = false;
  private _pendingRSI  = false;
  private _pendingMACD = false;
  private _pendingAO   = false;

  private saveState(): void {
    localStorage.setItem('chart_symbol', this.activeSymbol);
    localStorage.setItem('chart_ma',   JSON.stringify({ enabled: this.maEnabled,   period: this.maPeriod, type: this.maType }));
    localStorage.setItem('chart_rsi',  JSON.stringify({ enabled: this.rsiEnabled,  period: this.rsiPeriod }));
    localStorage.setItem('chart_macd', JSON.stringify({ enabled: this.macdEnabled, fast: this.macdFast, slow: this.macdSlow, signal: this.macdSignalPeriod }));
    localStorage.setItem('chart_ao',   JSON.stringify({ enabled: this.aoEnabled }));
    const range = this.chart?.timeScale().getVisibleRange();
    if (range) localStorage.setItem('chart_range', JSON.stringify(range));
  }

  private restoreState(): void {
    const savedSymbol = localStorage.getItem('chart_symbol');
    try {
      const ma   = JSON.parse(localStorage.getItem('chart_ma')   || '{}');
      const rsi  = JSON.parse(localStorage.getItem('chart_rsi')  || '{}');
      const macd = JSON.parse(localStorage.getItem('chart_macd') || '{}');
      const ao   = JSON.parse(localStorage.getItem('chart_ao')   || '{}');
      if (ma.period)   this.maPeriod           = ma.period;
      if (ma.type)     this.maType             = ma.type;
      if (rsi.period)  this.rsiPeriod          = rsi.period;
      if (macd.fast)   this.macdFast           = macd.fast;
      if (macd.slow)   this.macdSlow           = macd.slow;
      if (macd.signal) this.macdSignalPeriod   = macd.signal;
      this._pendingMA   = !!ma.enabled;
      this._pendingRSI  = !!rsi.enabled;
      this._pendingMACD = !!macd.enabled;
      this._pendingAO   = !!ao.enabled;
    } catch {}

    if (savedSymbol) {
      this.symbol = savedSymbol;
      this.loadBars();
    } else {
      this.tradeService.getPositions().subscribe({
        next: positions => {
          if (positions.length && !this.activeSymbol) {
            this.symbol = positions[0].symbol;
            this.loadBars();
          }
        },
        error: () => {},
      });
    }
  }

  private setupDragListeners(): void {
    const el = this.chartContainer.nativeElement as HTMLElement;
    const THRESHOLD = 6;

    const lineYOf = (price: number) =>
      this.candleSeries?.priceToCoordinate(price) ?? null;

    const findDraggable = (y: number) => {
      // Drawn lines
      for (const d of this.drawnLines) {
        const ly = lineYOf(d.price);
        if (ly != null && Math.abs(y - ly) <= THRESHOLD)
          return { kind: 'drawn' as const, id: d.id };
      }
      // SL / TP position lines
      for (const pos of this.positions) {
        if (pos.sl > 0) {
          const ly = lineYOf(pos.sl);
          if (ly != null && Math.abs(y - ly) <= THRESHOLD)
            return { kind: 'position' as const, ticket: pos.ticket, type: 'sl' as const };
        }
        if (pos.tp > 0) {
          const ly = lineYOf(pos.tp);
          if (ly != null && Math.abs(y - ly) <= THRESHOLD)
            return { kind: 'position' as const, ticket: pos.ticket, type: 'tp' as const };
        }
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!this.candleSeries) return;
      const y = e.clientY - el.getBoundingClientRect().top;
      const hit = findDraggable(y);
      if (hit) {
        this.dragging = hit;
        e.preventDefault();
        this.chart?.applyOptions({ handleScroll: { pressedMouseMove: false } });
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.candleSeries) return;
      const y = e.clientY - el.getBoundingClientRect().top;

      if (this.dragging) {
        this._wasDragging = true;
        const price = this.candleSeries.coordinateToPrice(y);
        if (price == null) return;

        if (this.dragging.kind === 'drawn') {
          const d = this.drawnLines.find(l => l.id === (this.dragging as any).id);
          if (!d) return;
          d.price = +price.toFixed(2);
          try { d.line.applyOptions({ price: d.price, title: `${d.label}  @ ${d.price}` }); } catch {}

        } else {
          const { ticket, type } = this.dragging as { kind: 'position'; ticket: number; type: 'sl' | 'tp' };
          const pos = this.positions.find(p => p.ticket === ticket);
          if (!pos) return;
          const lineKey = `${type}-${ticket}`;
          const line = this.priceLines.get(lineKey);
          if (!line) return;
          const rounded = +price.toFixed(pos.sl > 100 ? 2 : 5);
          try { line.applyOptions({ price: rounded }); } catch {}
          // Live-update the form NZD preview
          if (type === 'sl') {
            this.modifyForms[ticket].slNzd = this.priceToSlNzd(rounded, pos);
          } else {
            this.modifyForms[ticket].tpNzd = this.priceToTpNzd(rounded, pos);
          }
        }
        this.ngZone.run(() => this.cdr.detectChanges());
        return;
      }

      el.style.cursor = findDraggable(y) ? 'ns-resize' : '';
    };

    const onMouseUp = () => {
      if (!this.dragging) return;

      if (this.dragging.kind === 'drawn') {
        const d = this.drawnLines.find(l => l.id === (this.dragging as any).id);
        if (d) try { d.line.applyOptions({ title: d.label }); } catch {}
        this.saveDrawnLines();
      } else {
        const { ticket } = this.dragging as { kind: 'position'; ticket: number; type: 'sl' | 'tp' };
        this.modifyPosition(ticket);
      }

      this.dragging = null;
      el.style.cursor = '';
      this.chart?.applyOptions({ handleScroll: { pressedMouseMove: true } });
    };

    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mouseup', onMouseUp);

    this._chartCleanup.push(
      () => el.removeEventListener('mousedown', onMouseDown),
      () => el.removeEventListener('mousemove', onMouseMove),
      () => el.removeEventListener('mouseup', onMouseUp),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  private priceToSlNzd(newSlPrice: number, pos: Position): number {
    if (!pos.sl || !pos.slNzd || pos.sl === pos.price) return 0;
    const ratio = Math.abs(pos.slNzd) / Math.abs(pos.price - pos.sl);
    const magnitudeUsd = ratio * Math.abs(pos.price - newSlPrice);
    const magnitudeNzd = +(magnitudeUsd / this.nzdusd).toFixed(2);
    const inProfit = pos.type === 'buy' ? newSlPrice > pos.price : newSlPrice < pos.price;
    return inProfit ? magnitudeNzd : -magnitudeNzd;
  }

  private priceToTpNzd(newTpPrice: number, pos: Position): number {
    if (!pos.tp || !pos.tpNzd || pos.tp === pos.price) return 0;
    const ratio = pos.tpNzd / Math.abs(pos.tp - pos.price);
    return +(ratio * Math.abs(newTpPrice - pos.price) / this.nzdusd).toFixed(2);
  }

  toggleDrawMode(): void {
    this.drawMode = !this.drawMode;
    this.pendingDrawPrice = null;
  }

  confirmDraw(): void {
    if (this.pendingDrawPrice == null || !this.candleSeries) return;
    const label = this.drawLabel.trim() || `${this.pendingDrawPrice}`;
    const id = `draw-${Date.now()}`;
    const line = this.candleSeries.createPriceLine({
      price: this.pendingDrawPrice,
      color: this.drawColor,
      lineWidth: 1,
      lineStyle: 2, // dashed
      axisLabelVisible: true,
      axisLabelColor: this.drawColor,
      axisLabelTextColor: '#000000',
      title: label,
    });
    const entry = {
      id, label, price: this.pendingDrawPrice, color: this.drawColor, line,
      orderDirection: this.tradeDirection,
      orderRiskMode:  this.riskMode,
      orderRiskPct:   this.riskPct,
      orderRiskNzd:   this.riskFixed,
      orderSlMode:    this.tradeSlMode,
      orderSlPct:     this.tradeSl,
      orderSlFixed:   this.tradeSlFixed,
      orderAutoRR:    this.tradeAutoRR,
      orderRRMultiplier: this.tradeRRMultiplier,
      orderTpNzd:     this.tradeTpNzd,
      orderArmed: false,
      showOrder: false,
      orderStatus: 'idle' as const,
      marginNzd: null,
    };
    this.drawnLines.push(entry);
    this.saveDrawnLines();
    this.pendingDrawPrice = null;
    this.cdr.detectChanges();
  }

  cancelDraw(): void {
    this.pendingDrawPrice = null;
  }

  deleteDrawnLine(id: string): void {
    const idx = this.drawnLines.findIndex(d => d.id === id);
    if (idx === -1) return;
    try { this.candleSeries?.removePriceLine(this.drawnLines[idx].line); } catch {}
    this.drawnLines.splice(idx, 1);
    this.saveDrawnLines();
    this.cdr.detectChanges();
  }

  executeLineOrder(d: (typeof this.drawnLines)[0]): void {
    if (!this.activeSymbol || d.orderStatus === 'sending') return;
    d.orderStatus = 'sending';
    const payload: any = {
      symbol:    this.activeSymbol,
      direction: d.orderDirection,
      riskNzd:   this.lineRiskNzd(d),
      tpNzd:     this.lineEffectiveTp(d),
    };
    if (d.orderSlMode === 'pct') payload.slPct   = d.orderSlPct;
    else                          payload.slFixed = d.orderSlFixed;

    this.tradeService.placeCommand(payload).subscribe({
      next: () => {
        // Command queued — wait for MT5 to confirm via a new position appearing
        const knownTickets = new Set(this.positions.map(p => p.ticket));

        const timeout = setTimeout(() => {
          posSub.unsubscribe();
          d.orderStatus = 'error';
          this.cdr.detectChanges();
        }, 15000);

        const posSub = this.ws.positions$.subscribe(positions => {
          const placed = positions.find(
            p => p.symbol === this.activeSymbol && !knownTickets.has(p.ticket)
          );
          if (!placed) return;
          clearTimeout(timeout);
          posSub.unsubscribe();
          d.orderStatus = 'sent';
          this.cdr.detectChanges();
          setTimeout(() => this.deleteDrawnLine(d.id), 1500);
        });
      },
      error: () => { d.orderStatus = 'error'; this.cdr.detectChanges(); },
    });
  }

  saveDrawnLines(): void {
    const saved = this.drawnLines.map(({ id, label, price, color,
      orderDirection, orderRiskMode, orderRiskPct, orderRiskNzd,
      orderSlMode, orderSlPct, orderSlFixed,
      orderAutoRR, orderRRMultiplier, orderTpNzd, orderArmed }) =>
      ({ id, label, price, color,
         orderDirection, orderRiskMode, orderRiskPct, orderRiskNzd,
         orderSlMode, orderSlPct, orderSlFixed,
         orderAutoRR, orderRRMultiplier, orderTpNzd, orderArmed }));
    localStorage.setItem('chart_drawn_lines', JSON.stringify(saved));
  }

  private restoreDrawnLines(): void {
    if (!this.candleSeries) return;
    // Clear existing drawn lines before restoring (e.g. on symbol change)
    this.drawnLines.forEach(d => { try { this.candleSeries!.removePriceLine(d.line); } catch {} });
    this.drawnLines = [];
    try {
      const saved = JSON.parse(localStorage.getItem('chart_drawn_lines') || '[]');
      for (const d of saved) {
        const line = this.candleSeries.createPriceLine({
          price: d.price,
          color: d.color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          axisLabelColor: d.color,
          axisLabelTextColor: '#000000',
          title: d.label,
        });
        this.drawnLines.push({
          ...d, line,
          orderDirection:    d.orderDirection    ?? 'buy',
          orderRiskMode:     d.orderRiskMode     ?? 'pct',
          orderRiskPct:      d.orderRiskPct      ?? 2,
          orderRiskNzd:      d.orderRiskNzd      ?? 20,
          orderSlMode:       d.orderSlMode       ?? 'pct',
          orderSlPct:        d.orderSlPct        ?? 1,
          orderSlFixed:      d.orderSlFixed      ?? 0,
          orderAutoRR:       d.orderAutoRR       ?? true,
          orderRRMultiplier: d.orderRRMultiplier ?? 4,
          orderTpNzd:        d.orderTpNzd        ?? 80,
          orderArmed: d.orderArmed ?? false,
          showOrder: false,
          orderStatus: 'idle',
          marginNzd: null,
        });
      }
    } catch {}
  }

  private setupChartResizeListeners(): void {
    const onMouseMove = (e: MouseEvent) => {
      if (!this.tickChartResizing) return;
      const delta = e.clientX - this._resizeStartX;
      // Handle is on the left edge of the tick chart: drag left → bigger, drag right → smaller
      const newWidth = Math.max(60, Math.min(600, this._resizeStartWidth - delta));
      this.tickChartWidth = newWidth;
      this.cdr.detectChanges();
    };
    const onMouseUp = () => {
      if (!this.tickChartResizing) return;
      this.tickChartResizing = false;
      localStorage.setItem('tick_chart_width', String(this.tickChartWidth));
      this.cdr.detectChanges();
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    this._chartCleanup.push(
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  private buildWallOverlay(): void {
    const container = this.chartContainer.nativeElement as HTMLElement;
    const el = document.createElement('div');
    el.className = 'wall-zone-overlay';
    container.appendChild(el);
    this.domWallEl = el;
  }

  private updateWallOverlay(): void {
    const el = this.domWallEl;
    if (!el || !this.candleSeries || !this.domStats) {
      if (el) el.style.display = 'none';
      return;
    }
    const buyY  = this.candleSeries.priceToCoordinate(this.domStats.biggestBid.price);
    const sellY = this.candleSeries.priceToCoordinate(this.domStats.biggestAsk.price);
    if (buyY === null || sellY === null) { el.style.display = 'none'; return; }

    const top    = Math.min(buyY, sellY);
    const bottom = Math.max(buyY, sellY);
    const isAskAbove = sellY < buyY; // normal: sell wall above buy wall

    el.style.display = 'block';
    el.style.top     = top + 'px';
    el.style.height  = (bottom - top) + 'px';
    el.style.borderTopColor    = isAskAbove ? 'rgba(248,113,113,0.55)' : 'rgba(74,222,128,0.55)';
    el.style.borderBottomColor = isAskAbove ? 'rgba(74,222,128,0.55)' : 'rgba(248,113,113,0.55)';
  }

  private buildTickChart(): void {
    const el = this.tickChartContainer.nativeElement;
    this.tickChart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: '#161e2e' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#1e2d42' }, horzLines: { color: '#1e2d42' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a3347', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      width: el.clientWidth,
      height: el.clientHeight,
    } as any);

    this.tickSeries = this.tickChart.addSeries(LineSeries, {
      color: '#60a5fa',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
    });

    this.tickResizeObserver = new ResizeObserver(() => {
      this.tickChart?.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    this.tickResizeObserver.observe(el);
  }

  private addTickPoint(ask: number): void {
    if (!this.tickSeries) return;
    this.tickIndex++;
    try { this.tickSeries.update({ time: this.tickIndex as any, value: ask }); } catch {}
  }

  private resetTickChart(): void {
    this.tickIndex = 0;
    this.tickSeries?.setData([]);
    this.computeCandleStats();
    this.computeStreakStats();
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.clearCountdownPriceLine();
    this.resizeObserver?.disconnect();
    this.tickResizeObserver?.disconnect();
    this.tickChart?.remove();
    this.domWallEl?.remove();
    this.chart?.remove();
    clearInterval(this.tradeCooldownInterval);
    this.indicatorPanes.forEach(p => { p.resizeObserver.disconnect(); p.chart.remove(); });
    this.indicatorPanes.clear();
    this._chartCleanup.forEach(fn => fn());
  }

  private buildChart(): void {
    const el = this.chartContainer.nativeElement;
    this.chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#1e2535' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#2a3347' },
        horzLines: { color: '#2a3347' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a3347' },
      timeScale: {
        borderColor: '#2a3347',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: false,
        rightOffset: 10,
      },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    this.candleSeries = this.chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      lastValueVisible: false,
    });

    this.maSeries = this.chart.addSeries(LineSeries, {
      color: '#f59e0b',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    this.ngZone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver(() => {
        this.chart?.applyOptions({
          width: el.clientWidth,
          height: el.clientHeight,
        });
      });
      this.resizeObserver.observe(el);
    });

    // Draw mode: click to capture price at cursor (suppressed if a drag just finished)
    this.chart.subscribeClick((param) => {
      if (this._wasDragging) { this._wasDragging = false; return; }
      if (!this.drawMode || !param.point || !this.candleSeries) return;
      const price = this.candleSeries.coordinateToPrice(param.point.y);
      if (price == null) return;
      this.ngZone.run(() => {
        this.pendingDrawPrice = +price.toFixed(2);
        this.drawLabel = '';
        this.cdr.detectChanges();
      });
    });

    this.setupDragListeners();
    this.setupChartResizeListeners();

    // Keep wall overlay in sync whenever the chart is interacted with
    this.chart.subscribeCrosshairMove(() => { this.updateWallOverlay(); });
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => { this.updateWallOverlay(); });

    // Main → all indicators: sync bar spacing (zoom) + scroll position separately
    // Avoids setVisibleRange clamping past the last data point
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (this._syncingTimeAxis) return;
      this._syncingTimeAxis = true;
      const scrollPos  = this.chart!.timeScale().scrollPosition();
      const barSpacing = (this.chart!.timeScale() as any).options().barSpacing as number;
      this.indicatorPanes.forEach(pane => {
        if (!pane.chart) return;
        try { pane.chart.timeScale().applyOptions({ barSpacing }); } catch {}
        try { pane.chart.timeScale().scrollToPosition(scrollPos, false); } catch {}
      });
      this._syncingTimeAxis = false;
    });
  }

  loadBars(): void {
    const sym = this.symbol.trim().toUpperCase();
    if (!sym) return;
    this.loadError = '';
    this.activeSymbol = sym;
    this.marginNzd = null;
    this.domStats = null;
    this.clearCountdownPriceLine();
    this.resetTickChart();
    this.secsLeft = null;

    this.tradeService.getBars(sym).subscribe({
      next: data => {
        this.candleSeries?.setData(data.bars as any);
        this.barData = data.bars as any[];
        this.computeCandleStats();
        this.computeStreakStats();
        this.computePositionOdds();
        this.requestMarginCalc();
        this.refreshMA();
        this.refreshAllIndicators();
        this.timeframeLabel = this.formatTimeframe(data.timeframe);
        const bars = data.bars as any[];
        if (bars.length) {
          const last = bars[bars.length - 1] as any;
          this.lastClose = last.close;
          this.lastOpen  = last.open;
        }
        if (data.secsLeft != null) {
          this.secsLeft = Math.max(0, data.secsLeft);
          this.updateCountdownPriceLine(this.lastClose, this.secsLeft);
          this.cdr.detectChanges();
        }

        this.requestMarginCalc();

        // Restore saved range or fit content
        const savedRange = localStorage.getItem('chart_range');
        if (savedRange) {
          try { this.chart?.timeScale().setVisibleRange(JSON.parse(savedRange)); }
          catch { this.chart?.timeScale().fitContent(); }
        } else {
          this.chart?.timeScale().fitContent();
        }

        this.restoreDrawnLines();

        // Restore enabled indicators after layout settles
        setTimeout(() => {
          if (this._pendingMA   && !this.maEnabled)   { this.maEnabled   = true;  this.refreshMA(); }
          if (this._pendingRSI  && !this.rsiEnabled)  { this.rsiEnabled  = true;  this.addIndicator('RSI',  `RSI (${this.rsiPeriod})`); }
          if (this._pendingMACD && !this.macdEnabled) { this.macdEnabled = true;  this.addIndicator('MACD', this.macdLabel); }
          if (this._pendingAO   && !this.aoEnabled)   { this.aoEnabled   = true;  this.addIndicator('AO',   'Awesome Oscillator'); }
          this._pendingMA = this._pendingRSI = this._pendingMACD = this._pendingAO = false;
          this.cdr.detectChanges();
        }, 50);

        this.saveState();

        // Re-apply positions for this symbol
        this.tradeService.getPositions().subscribe({
          next: positions => {
            this.positions = positions.filter((p: Position) => p.symbol === sym);
            this.syncModifyForms();
            this.renderPriceLines();
            this.cdr.detectChanges();
          },
          error: () => {},
        });
      },
      error: () => {
        this.loadError = `No bar data for ${sym} — is the EA running on this chart?`;
        this.cdr.detectChanges();
      },
    });
  }

  private syncModifyForms(): void {
    this.positions.forEach(pos => {
      const existing = this.modifyForms[pos.ticket];
      if (!existing || (!existing.saving && !existing.saved)) {
        this.modifyForms[pos.ticket] = {
          slNzd: +((pos.slNzd ?? 0) / this.nzdusd).toFixed(2),
          tpNzd: +((pos.tpNzd  || 0) / this.nzdusd).toFixed(2),
          saving: false,
          saved: false,
        };
      }
    });
    this.computePositionOdds();
  }

  modifyPosition(ticket: number): void {
    const form = this.modifyForms[ticket];
    if (!form) return;
    form.saving = true;
    form.saved = false;
    this.tradeService.modifyPosition(ticket, form.slNzd * this.nzdusd, form.tpNzd * this.nzdusd).subscribe({
      next: () => {
        form.saving = false;
        form.saved = true;
        setTimeout(() => { form.saved = false; }, 3000);
        this.cdr.detectChanges();
      },
      error: () => {
        form.saving = false;
        this.cdr.detectChanges();
      },
    });
  }

  private renderPriceLines(): void {
    if (!this.candleSeries) return;

    // Remove existing lines
    this.priceLines.forEach(line => {
      try { this.candleSeries!.removePriceLine(line); } catch {}
    });
    this.priceLines.clear();

    this.positions.forEach(pos => {
      // Entry line
      const entry = this.candleSeries!.createPriceLine({
        price: pos.price,
        color: pos.type === 'buy' ? '#60a5fa' : '#f59e0b',
        lineWidth: 2,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        axisLabelColor: pos.type === 'buy' ? '#bfdbfe' : '#fde68a',
        axisLabelTextColor: '#000000',
        title: `Entry #${pos.ticket}`,
      });
      this.priceLines.set(`entry-${pos.ticket}`, entry);

      // SL line — label shows NZD loss
      if (pos.sl > 0) {
        const slNzd = pos.slNzd ? pos.slNzd / this.nzdusd : 0;
        const slLabel = slNzd ? ` ${slNzd > 0 ? '+' : '-'}$${Math.abs(slNzd).toFixed(2)}` : '';
        const sl = this.candleSeries!.createPriceLine({
          price: pos.sl,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: '#fecaca',
          axisLabelTextColor: '#000000',
          title: `SL${slLabel}`,
        });
        this.priceLines.set(`sl-${pos.ticket}`, sl);
      }

      // TP line — label shows NZD gain
      if (pos.tp > 0) {
        const tpNzd = pos.tpNzd ? pos.tpNzd / this.nzdusd : 0;
        const tpLabel = tpNzd ? ` +$${tpNzd.toFixed(2)}` : '';
        const tp = this.candleSeries!.createPriceLine({
          price: pos.tp,
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          axisLabelColor: '#bbf7d0',
          axisLabelTextColor: '#000000',
          title: `TP${tpLabel}`,
        });
        this.priceLines.set(`tp-${pos.ticket}`, tp);
      }
    });
  }

  private updateCountdownPriceLine(close: number, secsLeft: number | null): void {
    if (!this.candleSeries) return;
    this.clearCountdownPriceLine();
    if (secsLeft === null) return;
    const isUp = this.lastClose >= this.lastOpen;
    this.countdownPriceLine = this.candleSeries.createPriceLine({
      price: close,
      color: isUp ? '#22c55e' : '#ef4444',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      axisLabelColor: isUp ? '#bbf7d0' : '#fecaca',
      axisLabelTextColor: '#000000',
      title: this.formatSecsLeft(secsLeft),
    });
  }

  private clearCountdownPriceLine(): void {
    if (this.countdownPriceLine && this.candleSeries) {
      try { this.candleSeries.removePriceLine(this.countdownPriceLine); } catch {}
      this.countdownPriceLine = null;
    }
  }


  private formatTimeframe(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `M${seconds / 60}`;
    if (seconds < 86400) return `H${seconds / 3600}`;
    return `D${seconds / 86400}`;
  }

  get positionsForSymbol(): Position[] {
    return this.positions;
  }

  placeTrade(): void {
    if (this.tradePlacing || this.tradeCooldown > 0) return;
    if (!this.activeSymbol || !this.tradeRiskNzd || !this.tradeTpNzd) return;
    if (this.overLimit) { this.tradeError = `Max risk is $${this.maxRisk} (2% of balance)`; return; }
    this.tradePlacing = true;
    this.tradeError = '';
    const slFixed = this.autoSlFixed;
    const payload: any = {
      symbol:    this.activeSymbol,
      direction: this.tradeDirection,
      riskNzd:   this.tradeRiskNzd,
      tpNzd:     this.tradeEffectiveTp,
    };
    if (slFixed) payload.slFixed = slFixed;
    else         payload.slPct   = 1; // fallback 1% if no bar data
    this.tradeService.placeCommand(payload).subscribe({
      next: () => {
        this.tradePlacing = false;
        this.startTradeCooldown();
        this.cdr.detectChanges();
      },
      error: () => { this.tradeError = 'Failed to queue trade'; this.tradePlacing = false; this.cdr.detectChanges(); },
    });
  }

  private startTradeCooldown(): void {
    this.tradeDirection = 'buy';
    this.tradeCooldown = 5;
    clearInterval(this.tradeCooldownInterval);
    this.tradeCooldownInterval = setInterval(() => {
      this.tradeCooldown--;
      if (this.tradeCooldown <= 0) {
        this.tradeCooldown = 0;
        clearInterval(this.tradeCooldownInterval);
      }
      this.cdr.detectChanges();
    }, 1000);
  }

  // ── Indicator pane management ─────────────────────────────────────

  private addIndicator(name: string, label: string): void {
    if (this.indicatorPanes.has(name)) return;

    const el = document.createElement('div');
    el.className = 'indicator-pane';

    const header = document.createElement('div');
    header.className = 'ind-pane-header';
    header.innerHTML = `<span class="ind-pane-label">${label}</span>`;
    el.appendChild(header);

    const canvas = document.createElement('div');
    canvas.className = 'ind-pane-canvas';
    el.appendChild(canvas);

    this.indicatorPanesEl.nativeElement.appendChild(el);

    // Placeholder so removeIndicator works before chart is ready
    this.indicatorPanes.set(name, { el, chart: null as any, series: [], resizeObserver: null as any });
    this.cdr.detectChanges();

    // Defer chart creation until the canvas is laid out and has real dimensions
    requestAnimationFrame(() => {
      const w = canvas.offsetWidth  || 600;
      const h = canvas.offsetHeight || 120;

      const indChart = createChart(canvas, {
        layout: { background: { type: ColorType.Solid, color: '#151e2d' }, textColor: '#64748b' },
        grid: { vertLines: { color: '#1e2d42' }, horzLines: { color: '#1e2d42' } },
        rightPriceScale: { borderColor: '#2a3347', scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: {
          borderColor: '#2a3347',
          timeVisible: true,
          secondsVisible: false,
          visible: false,
          rightOffset: 10,
          fixRightEdge: false,
          fixLeftEdge: false,
        },
        crosshair: { mode: CrosshairMode.Normal },
        width: w,
        height: h,
      } as any);

      const series: ISeriesApi<any>[] = [];
      if (name === 'AO') {
        series.push(indChart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }));
      } else if (name === 'RSI') {
        series.push(indChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: true }));
      } else if (name === 'MACD') {
        series.push(indChart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }));
        series.push(indChart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }));
        series.push(indChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }));
      }

      // No reverse sync — main chart is the single source of truth for position/zoom

      // Align new indicator to the main chart's current bar spacing + scroll position
      const initScroll  = this.chart?.timeScale().scrollPosition();
      const initSpacing = (this.chart?.timeScale() as any)?.options()?.barSpacing as number | undefined;
      if (initSpacing) try { indChart.timeScale().applyOptions({ barSpacing: initSpacing }); } catch {}
      if (initScroll !== undefined) try { indChart.timeScale().scrollToPosition(initScroll, false); } catch {}

      // Crosshair sync: main → this indicator
      this.chart?.subscribeCrosshairMove(param => {
        if (this._syncingCrosshair || !series[0]) return;
        this._syncingCrosshair = true;
        if (param.time) indChart.setCrosshairPosition(NaN, param.time, series[0]);
        else            indChart.clearCrosshairPosition();
        this._syncingCrosshair = false;
      });

      // Crosshair sync: indicator → main + other indicators
      indChart.subscribeCrosshairMove(param => {
        if (this._syncingCrosshair) return;
        this._syncingCrosshair = true;
        if (param.time) {
          if (this.candleSeries) this.chart?.setCrosshairPosition(NaN, param.time, this.candleSeries);
          this.indicatorPanes.forEach((p, n) => {
            if (n !== name && p.chart && p.series[0])
              p.chart.setCrosshairPosition(NaN, param.time!, p.series[0]);
          });
        } else {
          this.chart?.clearCrosshairPosition();
          this.indicatorPanes.forEach((p, n) => {
            if (n !== name && p.chart) p.chart.clearCrosshairPosition();
          });
        }
        this._syncingCrosshair = false;
      });

      const ro = new ResizeObserver(() => {
        indChart.applyOptions({ width: canvas.offsetWidth, height: canvas.offsetHeight });
      });
      ro.observe(canvas);

      this.indicatorPanes.set(name, { el, chart: indChart, series, resizeObserver: ro });
      this.refreshIndicator(name);
    });
  }

  private removeIndicator(name: string): void {
    const pane = this.indicatorPanes.get(name);
    if (!pane) return;
    pane.resizeObserver?.disconnect();
    try { pane.chart?.remove(); } catch {}
    pane.el.remove();
    this.indicatorPanes.delete(name);
    this.saveState();
    this.cdr.detectChanges();
  }

  closePosition(ticket: number): void {
    this.closingTickets.add(ticket);
    this.tradeService.closePosition(ticket).subscribe({
      next: () => { this.closingTickets.delete(ticket); this.cdr.detectChanges(); },
      error: () => { this.closingTickets.delete(ticket); this.cdr.detectChanges(); },
    });
  }

  trackByTicket(_: number, pos: Position): number {
    return pos.ticket;
  }
}
