import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  ElementRef,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Chart, registerables } from 'chart.js';
import { TradeService } from '../../services/trade.service';
import { WebSocketService } from '../../services/websocket.service';
import { CalculatorShareService } from '../../services/calculator-share.service';
import { OpenTrade, ClosedTrade, TradeData } from '../../models/trade.model';

Chart.register(...registerables);

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
})
export class DashboardComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('pnlChart') pnlChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('donutChart') donutChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('riskChart') riskChartRef!: ElementRef<HTMLCanvasElement>;

  openTrades: OpenTrade[] = [];
  closedTrades: ClosedTrade[] = [];

  // Form model
  form = {
    instrument: '',
    investmentSize: null as number | null,
    riskPct: null as number | null,
    riskNzd: null as number | null,
    notes: '',
    openDate: '',
  };

  // Close modal
  showCloseModal = false;
  closingTrade: OpenTrade | null = null;
  closeForm = {
    outcome: 'win' as 'win' | 'loss',
    amount: null as number | null,
    closeDate: '',
    closeNotes: '',
  };

  page = 1;
  pageSize = 20;

  get totalPages(): number { return Math.ceil(this.closedTrades.length / this.pageSize); }
  get pagedTrades() { return this.closedTrades.slice((this.page - 1) * this.pageSize, this.page * this.pageSize); }
  get pageNumbers(): number[] { return Array.from({ length: this.totalPages }, (_, i) => i + 1); }
  setPage(p: number) { if (p >= 1 && p <= this.totalPages) this.page = p; }

  private pnlChart: Chart | null = null;
  private donutChart: Chart | null = null;
  private riskChart: Chart | null = null;
  private subs = new Subscription();
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private chartsInitialized = false;

  constructor(
    private tradeService: TradeService,
    private wsService: WebSocketService,
    private calcShare: CalculatorShareService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.updateOpenDate();
    this.clockInterval = setInterval(() => this.updateOpenDate(), 60000);

    // Live updates
    this.subs.add(
      this.wsService.messages$.subscribe((data: TradeData) => {
        this.openTrades = data.open;
        this.closedTrades = data.closed;
        this.page = 1;
        this.updateCharts();
        this.cdr.detectChanges();
      })
    );

    // Calculator transfer
    this.subs.add(
      this.calcShare.transfer$.subscribe((vals) => {
        if (vals.instrument) this.form.instrument = vals.instrument;
        if (vals.riskPct != null) this.form.riskPct = vals.riskPct;
        if (vals.riskNzd != null) this.form.riskNzd = vals.riskNzd;
        if (vals.investmentSize != null) this.form.investmentSize = vals.investmentSize;
        this.cdr.detectChanges();
      })
    );
  }

  ngAfterViewInit(): void {
    this.initCharts();
    this.chartsInitialized = true;

    // Always fetch from disk — don't rely solely on WebSocket events
    this.tradeService.getTrades().subscribe((data) => {
      this.openTrades = data.open;
      this.closedTrades = data.closed;
      this.updateCharts();
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.clockInterval) clearInterval(this.clockInterval);
    this.destroyCharts();
  }

  private updateOpenDate(): void {
    const now = new Date();
    this.form.openDate = now.toLocaleString('en-NZ', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // --- Stats ---
  get winRate(): string {
    const wins = this.closedTrades.filter(t => t.outcome === 'win').length;
    if (!this.closedTrades.length) return '0%';
    return Math.round((wins / this.closedTrades.length) * 100) + '%';
  }

  get netPnL(): number {
    return this.closedTrades.reduce((sum, t) => {
      return sum + (t.outcome === 'win' ? t.amount : -t.amount);
    }, 0);
  }

  get avgWin(): number {
    const wins = this.closedTrades.filter(t => t.outcome === 'win');
    if (!wins.length) return 0;
    return wins.reduce((s, t) => s + t.amount, 0) / wins.length;
  }

  get avgLoss(): number {
    const losses = this.closedTrades.filter(t => t.outcome === 'loss');
    if (!losses.length) return 0;
    return losses.reduce((s, t) => s + t.amount, 0) / losses.length;
  }

  get avgRiskPct(): number {
    const all = [...this.openTrades, ...this.closedTrades];
    if (!all.length) return 0;
    return all.reduce((s, t) => s + (t.riskPct || 0), 0) / all.length;
  }

  // --- Form submit ---
  submitOpenTrade(): void {
    if (!this.form.instrument || !this.form.riskPct) return;

    const trade: Partial<OpenTrade> = {
      instrument: this.form.instrument.toUpperCase(),
      investmentSize: this.form.investmentSize || 0,
      riskPct: this.form.riskPct,
      riskNzd: this.form.riskNzd || 0,
      openDate: new Date().toISOString(),
      notes: this.form.notes,
      source: 'manual',
    };

    this.tradeService.openTrade(trade).subscribe(() => {
      this.form = {
        instrument: '',
        investmentSize: null,
        riskPct: null,
        riskNzd: null,
        notes: '',
        openDate: this.form.openDate,
      };
    });
  }

  // --- Close modal ---
  openCloseModal(trade: OpenTrade): void {
    this.closingTrade = trade;
    this.closeForm = {
      outcome: 'win',
      amount: null,
      closeDate: new Date().toLocaleString('en-NZ', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }),
      closeNotes: '',
    };
    this.showCloseModal = true;
  }

  cancelClose(): void {
    this.showCloseModal = false;
    this.closingTrade = null;
  }

  submitClose(): void {
    if (!this.closingTrade || !this.closeForm.amount) return;

    this.tradeService.closeTrade({
      id: this.closingTrade.id,
      outcome: this.closeForm.outcome,
      amount: this.closeForm.amount,
      closeDate: new Date().toISOString(),
      closeNotes: this.closeForm.closeNotes,
    }).subscribe(() => {
      this.showCloseModal = false;
      this.closingTrade = null;
    });
  }

  deleteTrade(id: number): void {
    if (!confirm('Delete this trade?')) return;
    this.tradeService.deleteTrade(id).subscribe();
  }

  // --- Charts ---
  private initCharts(): void {
    this.createPnLChart();
    this.createDonutChart();
    this.createRiskChart();
  }

  private destroyCharts(): void {
    this.pnlChart?.destroy();   this.pnlChart = null;
    this.donutChart?.destroy(); this.donutChart = null;
    this.riskChart?.destroy();  this.riskChart = null;
  }

  private updateCharts(): void {
    if (!this.chartsInitialized) return;
    this.updatePnLChart();
    this.updateDonutChart();
    this.updateRiskChart();
  }

  private parseDate(str: string): Date {
    if (!str) return new Date(NaN);
    // MT5 format "2026.08.30 00:10:29" — append Z so it's treated as UTC,
    // matching ISO dates that already carry a Z suffix
    if (/^\d{4}\./.test(str))
      return new Date(str.replace(/^(\d{4})\.(\d{2})\.(\d{2})\s/, '$1-$2-$3T') + 'Z');
    return new Date(str);
  }

  private buildPnLData(): { labels: string[]; data: number[] } {
    const sorted = [...this.closedTrades].sort((a, b) => {
      const ta = this.parseDate(a.closeDate).getTime();
      const tb = this.parseDate(b.closeDate).getTime();
      if (isNaN(ta) && isNaN(tb)) return 0;
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return ta !== tb ? ta - tb : a.id - b.id;
    });
    let cumulative = 0;
    const labels: string[] = [];
    const data: number[] = [];
    sorted.forEach((t, i) => {
      cumulative += t.outcome === 'win' ? t.amount : -t.amount;
      labels.push(`#${i + 1}`);
      data.push(+cumulative.toFixed(2));
    });
    return { labels, data };
  }

  private createPnLChart(): void {
    if (!this.pnlChartRef) return;
    const { labels, data } = this.buildPnLData();
    this.pnlChart = new Chart(this.pnlChartRef.nativeElement, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Cumulative P&L (NZD)',
          data,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: { ticks: { color: '#64748b' }, grid: { color: '#2a3347' } },
          y: { ticks: { color: '#64748b' }, grid: { color: '#2a3347' } },
        },
      },
    });
  }

  private updatePnLChart(): void {
    if (!this.pnlChart) return;
    const { labels, data } = this.buildPnLData();
    this.pnlChart.data.labels = labels;
    this.pnlChart.data.datasets[0].data = data;
    this.pnlChart.update();
  }

  private createDonutChart(): void {
    if (!this.donutChartRef) return;
    const wins = this.closedTrades.filter(t => t.outcome === 'win').length;
    const losses = this.closedTrades.filter(t => t.outcome === 'loss').length;
    this.donutChart = new Chart(this.donutChartRef.nativeElement, {
      type: 'doughnut',
      data: {
        labels: ['Wins', 'Losses'],
        datasets: [{
          data: [wins, losses],
          backgroundColor: ['#22c55e', '#ef4444'],
          borderColor: '#1e2535',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
      },
    });
  }

  private updateDonutChart(): void {
    if (!this.donutChart) return;
    this.donutChart.data.datasets[0].data = [
      this.closedTrades.filter(t => t.outcome === 'win').length,
      this.closedTrades.filter(t => t.outcome === 'loss').length,
    ];
    this.donutChart.update();
  }

  private createRiskChart(): void {
    if (!this.riskChartRef) return;
    this.riskChart = new Chart(this.riskChartRef.nativeElement, {
      type: 'bar',
      data: {
        labels: this.closedTrades.map(t => t.instrument),
        datasets: [{
          label: 'Risk %',
          data: this.closedTrades.map(t => t.riskPct),
          backgroundColor: 'rgba(59,130,246,0.6)',
          borderColor: '#3b82f6',
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
          x: { ticks: { color: '#64748b' }, grid: { color: '#2a3347' } },
          y: { ticks: { color: '#64748b' }, grid: { color: '#2a3347' } },
        },
      },
    });
  }

  private updateRiskChart(): void {
    if (!this.riskChart) return;
    this.riskChart.data.labels = this.closedTrades.map(t => t.instrument);
    this.riskChart.data.datasets[0].data = this.closedTrades.map(t => t.riskPct);
    this.riskChart.update();
  }

  formatCurrency(val: number): string {
    return val.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD', minimumFractionDigits: 2 });
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    return this.parseDate(iso).toLocaleString('en-NZ', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }
}
