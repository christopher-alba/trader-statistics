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
  CandlestickSeries,
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

  symbol = '';
  activeSymbol = '';
  positions: Position[] = [];
  loadError = '';
  timeframeLabel = '';
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

  tradeTpNzd = 80;  // desired TP profit in NZD

  get tradeRiskNzd(): number {
    return this.riskMode === 'pct'
      ? +(this.accountBalance * this.riskPct / 100).toFixed(2)
      : this.riskFixed;
  }
  get tradeRR(): string { return this.tradeRiskNzd ? (this.tradeTpNzd / this.tradeRiskNzd).toFixed(2) : '—'; }
  get maxRisk(): number    { return +(this.accountBalance * 0.1).toFixed(2); }
  get overLimit(): boolean { return this.accountBalance > 0 && this.tradeRiskNzd > this.maxRisk; }

  // Close state per ticket
  closingTickets = new Set<number>();

  private chart: IChartApi | null = null;
  private candleSeries: ISeriesApi<'Candlestick', any> | null = null;
  private priceLines: Map<string, any> = new Map();
  private resizeObserver: ResizeObserver | null = null;
  private subs = new Subscription();

  private lastPositionsJson = '';
  private tradeCooldownInterval?: ReturnType<typeof setInterval>;

  constructor(
    private tradeService: TradeService,
    private ws: WebSocketService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    // Track account balance for invest cap
    this.subs.add(this.ws.account$.subscribe(a => {
      if (a.balance) this.accountBalance = a.balance;
    }));
    this.tradeService.getAccount().subscribe({
      next: a => { if (a.balance) this.accountBalance = a.balance; },
      error: () => {},
    });

    // Auto-populate symbol from the live price stream
    this.subs.add(this.ws.price$.subscribe(p => {
      if (!this.symbol) {
        this.symbol = p.symbol;
        this.cdr.detectChanges();
      }
    }));

    // Live bar updates — run outside Angular so canvas updates never trigger change detection
    this.ngZone.runOutsideAngular(() => {
      this.subs.add(this.ws.barUpdate$.subscribe(data => {
        if (data.symbol === this.activeSymbol) {
          this.candleSeries?.update(data.bar as any);
        }
      }));
    });

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

    // Auto-load bars if the EA already pushed a symbol
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

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.resizeObserver?.disconnect();
    this.chart?.remove();
    clearInterval(this.tradeCooldownInterval);
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
  }

  loadBars(): void {
    const sym = this.symbol.trim().toUpperCase();
    if (!sym) return;
    this.loadError = '';
    this.activeSymbol = sym;

    this.tradeService.getBars(sym).subscribe({
      next: data => {
        this.candleSeries?.setData(data.bars as any);
        this.chart?.timeScale().fitContent();
        this.timeframeLabel = this.formatTimeframe(data.timeframe);

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
          slNzd: pos.slNzd ? Math.abs(pos.slNzd) : 0,
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
        title: `Entry #${pos.ticket}`,
      });
      this.priceLines.set(`entry-${pos.ticket}`, entry);

      // SL line — label shows NZD loss
      if (pos.sl > 0) {
        const slLabel = pos.slNzd ? ` -$${Math.abs(pos.slNzd).toFixed(2)}` : '';
        const sl = this.candleSeries!.createPriceLine({
          price: pos.sl,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `SL${slLabel}`,
        });
        this.priceLines.set(`sl-${pos.ticket}`, sl);
      }

      // TP line — label shows NZD gain
      if (pos.tp > 0) {
        const tpLabel = pos.tpNzd ? ` +$${pos.tpNzd.toFixed(2)}` : '';
        const tp = this.candleSeries!.createPriceLine({
          price: pos.tp,
          color: '#22c55e',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `TP${tpLabel}`,
        });
        this.priceLines.set(`tp-${pos.ticket}`, tp);
      }
    });
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
      tpNzd:     this.tradeTpNzd,
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
