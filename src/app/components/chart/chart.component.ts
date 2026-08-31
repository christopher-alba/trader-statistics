import {
  Component, OnInit, OnDestroy, AfterViewInit,
  ViewChild, ElementRef, ChangeDetectorRef, NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import {
  createChart, IChartApi, ISeriesApi,
  CrosshairMode, LineStyle, ColorType,
  CandlestickSeries, LineSeries, HistogramSeries,
} from 'lightweight-charts';
import { TradeService } from '../../services/trade.service';
import { WebSocketService, Position } from '../../services/websocket.service';

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

  symbol = '';
  activeSymbol = '';
  positions: Position[] = [];
  loadError = '';
  timeframeLabel = '';
  secsLeft: number | null = null;
  private nzdusd = 0.6;

  get secsLeftLabel(): string {
    if (this.secsLeft === null) return '';
    return `${this.secsLeft}s`;
  }

  private lastClose = 0;
  private lastOpen = 0;
  modifyForms: Record<number, { slNzd: number; tpNzd: number; saving: boolean; saved: boolean }> = {};

  // Open trade form
  tradeDirection: 'buy' | 'sell' = 'buy';
  riskMode: 'pct' | 'fixed' = 'pct';
  riskPct   = 2;    // % of balance to risk if SL hit
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
  get maxRisk(): number    { return +(this.accountBalance * 0.1).toFixed(2); }
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

  requestMarginCalc(): void {
    if (!this.activeSymbol || !this.tradeRiskNzd) { this.marginNzd = null; return; }
    const slPct   = this.tradeSlMode === 'pct'   ? this.tradeSl      : 0;
    const slFixed = this.tradeSlMode === 'fixed' ? this.tradeSlFixed : 0;
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
  private priceLines: Map<string, any> = new Map();
  private countdownPriceLine: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private subs = new Subscription();

  private lastPositionsJson = '';
  private tradeCooldownInterval?: ReturnType<typeof setInterval>;
  private _syncingTimeAxis = false;
  private _syncingCrosshair = false;

  // ── Indicators ───────────────────────────────────────────────────
  readonly AVAILABLE_INDICATORS = [
    { name: 'AO',   label: 'Awesome Oscillator' },
    { name: 'RSI',  label: 'RSI (14)' },
    { name: 'MACD', label: 'MACD (12,26,9)' },
  ];
  showIndicatorPicker = false;
  indicatorPanes: Map<string, {
    el: HTMLDivElement;
    chart: IChartApi;
    series: ISeriesApi<any>[];
    resizeObserver: ResizeObserver;
  }> = new Map();

  get availableToAdd() {
    return this.AVAILABLE_INDICATORS.filter(i => !this.indicatorPanes.has(i.name));
  }

  constructor(
    private tradeService: TradeService,
    private ws: WebSocketService,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    // Track account balance for invest cap
    this.subs.add(this.ws.account$.subscribe(a => {
      if (a.balance)     this.accountBalance = a.balance;
      if (a.freeMargin)  this.freeMargin     = a.freeMargin;
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

    // Auto-populate symbol from the live price stream
    this.subs.add(this.ws.price$.subscribe(p => {
      if (!this.symbol) this.symbol = p.symbol;
      if (p.symbol === this.activeSymbol) {
        this.currentAsk = p.ask;
        this.checkLineTriggers(p.ask, p.bid);
        this.prevAsk = p.ask;
        this.prevBid = p.bid;
      }
      this.cdr.detectChanges();
    }));

    // Live bar updates — secsLeft driven purely by MT5
    this.subs.add(this.ws.barUpdate$.subscribe(data => {
      if (data.symbol !== this.activeSymbol) return;
      this.lastClose = data.bar.close;
      this.lastOpen  = data.bar.open;
      if (data.secsLeft !== null) this.secsLeft = data.secsLeft;
      this.ngZone.runOutsideAngular(() => {
        this.candleSeries?.update(data.bar as any);
        this.updateCountdownPriceLine(this.lastClose, this.secsLeft);
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

    // Live indicator updates
    this.subs.add(this.ws.indicatorUpdate$.subscribe(update => {
      if (update.symbol !== this.activeSymbol) return;
      this.applyIndicatorUpdate(update.time, update.indicators);
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
    this.restoreState();
  }

  private _pendingIndicators: string[] = [];

  private saveState(): void {
    localStorage.setItem('chart_symbol', this.activeSymbol);
    localStorage.setItem('chart_indicators', JSON.stringify(Array.from(this.indicatorPanes.keys())));
    const range = this.chart?.timeScale().getVisibleRange();
    if (range) localStorage.setItem('chart_range', JSON.stringify(range));
  }

  private restoreState(): void {
    const savedSymbol = localStorage.getItem('chart_symbol');
    this._pendingIndicators = JSON.parse(localStorage.getItem('chart_indicators') || '[]');

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
    const magnitude = +(ratio * Math.abs(pos.price - newSlPrice)).toFixed(2);
    const inProfit = pos.type === 'buy' ? newSlPrice > pos.price : newSlPrice < pos.price;
    return inProfit ? magnitude : -magnitude;
  }

  private priceToTpNzd(newTpPrice: number, pos: Position): number {
    if (!pos.tp || !pos.tpNzd || pos.tp === pos.price) return 0;
    const ratio = pos.tpNzd / Math.abs(pos.tp - pos.price);
    return +(ratio * Math.abs(newTpPrice - pos.price)).toFixed(2);
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

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.clearCountdownPriceLine();
    this.resizeObserver?.disconnect();
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
    this.clearCountdownPriceLine();
    this.secsLeft = null;

    this.tradeService.getBars(sym).subscribe({
      next: data => {
        this.candleSeries?.setData(data.bars as any);
        this.timeframeLabel = this.formatTimeframe(data.timeframe);
        const bars = data.bars as any[];
        if (bars.length) {
          const last = bars[bars.length - 1] as any;
          this.lastClose = last.close;
          this.lastOpen  = last.open;
        }
        if (data.secsLeft != null) {
          this.secsLeft = Math.min(60, Math.max(0, data.secsLeft));
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
        this.loadIndicatorHistory(sym);

        // Restore indicators after bars + range are set so they sync correctly
        if (this._pendingIndicators.length) {
          const toRestore = [...this._pendingIndicators];
          this._pendingIndicators = [];
          setTimeout(() => toRestore.forEach(name => this.addIndicator(name)), 50);
        }

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
          slNzd: pos.slNzd ?? 0,
          tpNzd: pos.tpNzd || 0,
          saving: false,
          saved: false,
        };
      }
    });
  }

  modifyPosition(ticket: number): void {
    const form = this.modifyForms[ticket];
    if (!form) return;
    form.saving = true;
    form.saved = false;
    this.tradeService.modifyPosition(ticket, form.slNzd, form.tpNzd).subscribe({
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
        const slNzdConverted = pos.slNzd ? pos.slNzd / this.nzdusd : 0;
        const slLabel = slNzdConverted ? ` ${slNzdConverted > 0 ? '+' : '-'}$${Math.abs(slNzdConverted).toFixed(2)}` : '';
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
      title: `${secsLeft}s`,
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
    const slValid = this.tradeSlMode === 'pct' ? !!this.tradeSl : !!this.tradeSlFixed;
    if (!this.activeSymbol || !this.tradeRiskNzd || !slValid || !this.tradeTpNzd) return;
    if (this.overLimit) { this.tradeError = `Max risk is $${this.maxRisk} (10% of balance)`; return; }
    this.tradePlacing = true;
    this.tradeError = '';
    const payload: any = {
      symbol:    this.activeSymbol,
      direction: this.tradeDirection,
      riskNzd:   this.tradeRiskNzd,
      tpNzd:     this.tradeEffectiveTp,
    };
    if (this.tradeSlMode === 'pct') payload.slPct   = this.tradeSl;
    else                            payload.slFixed = this.tradeSlFixed;
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

  addIndicator(name: string): void {
    if (this.indicatorPanes.has(name)) return;
    this.showIndicatorPicker = false;

    const el = document.createElement('div');
    el.className = 'indicator-pane';

    const header = document.createElement('div');
    header.className = 'ind-pane-header';
    const def = this.AVAILABLE_INDICATORS.find(i => i.name === name)!;
    header.innerHTML = `<span class="ind-pane-label">${def.label}</span>`;
    el.appendChild(header);

    const canvas = document.createElement('div');
    canvas.className = 'ind-pane-canvas';
    el.appendChild(canvas);

    this.indicatorPanesEl.nativeElement.appendChild(el);

    // Placeholder so removeIndicator works before chart is ready
    this.indicatorPanes.set(name, { el, chart: null as any, series: [], resizeObserver: null as any });
    this.saveState();
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

      // Load existing history
      if (this.activeSymbol) this.loadIndicatorHistory(this.activeSymbol);
    });
  }

  removeIndicator(name: string): void {
    const pane = this.indicatorPanes.get(name);
    if (!pane) return;
    pane.resizeObserver.disconnect();
    pane.chart.remove();
    pane.el.remove();
    this.indicatorPanes.delete(name);
    this.saveState();
    this.cdr.detectChanges();
  }

  private loadIndicatorHistory(symbol: string): void {
    if (!this.indicatorPanes.size) return;
    this.http.get<Record<string, { time: number; value: number }[]>>(`http://localhost:3000/api/indicators/${symbol}`)
      .subscribe({ next: data => this.applyIndicatorHistory(data), error: () => {} });
  }

  private dedup(points: { time: number; value: number }[]): { time: number; value: number }[] {
    const seen = new Map<number, number>();
    points.forEach(p => seen.set(p.time, p.value));
    return Array.from(seen.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
  }

  private applyIndicatorHistory(data: Record<string, { time: number; value: number }[]>): void {
    this.indicatorPanes.forEach((pane, name) => {
      if (!pane.chart) return;
      if (name === 'AO' && data['AO']) {
        pane.series[0].setData(this.dedup(data['AO']).map(p => ({
          time: p.time as any, value: p.value, color: p.value >= 0 ? '#22c55e' : '#ef4444',
        })));
      } else if (name === 'RSI' && data['RSI']) {
        pane.series[0].setData(this.dedup(data['RSI']).map(p => ({ time: p.time as any, value: p.value })));
      } else if (name === 'MACD' && data['MACD_hist']) {
        pane.series[0].setData(this.dedup(data['MACD_hist']   || []).map(p => ({ time: p.time as any, value: p.value, color: p.value >= 0 ? '#22c55e' : '#ef4444' })));
        pane.series[1].setData(this.dedup(data['MACD_main']   || []).map(p => ({ time: p.time as any, value: p.value })));
        pane.series[2].setData(this.dedup(data['MACD_signal'] || []).map(p => ({ time: p.time as any, value: p.value })));
      }
    });
  }

  private applyIndicatorUpdate(time: number, indicators: Record<string, number>): void {
    this.indicatorPanes.forEach((pane, name) => {
      if (!pane.chart) return;
      const t = time as any;
      if (name === 'AO' && indicators['AO'] !== undefined) {
        const v = indicators['AO'];
        pane.series[0].update({ time: t, value: v, color: v >= 0 ? '#22c55e' : '#ef4444' });
      } else if (name === 'RSI' && indicators['RSI'] !== undefined) {
        pane.series[0].update({ time: t, value: indicators['RSI'] });
      } else if (name === 'MACD' && indicators['MACD_hist'] !== undefined) {
        const h = indicators['MACD_hist'];
        pane.series[0].update({ time: t, value: h, color: h >= 0 ? '#22c55e' : '#ef4444' });
        pane.series[1].update({ time: t, value: indicators['MACD_main'] });
        pane.series[2].update({ time: t, value: indicators['MACD_signal'] });
      }
    });
  }

  indicatorPanesList(): { name: string; label: string }[] {
    return Array.from(this.indicatorPanes.keys())
      .map(name => ({ name, label: this.AVAILABLE_INDICATORS.find(i => i.name === name)!.label }));
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
