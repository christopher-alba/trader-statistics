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
  @ViewChild('forecastChart') forecastChartRef!: ElementRef<HTMLCanvasElement>;

  activeTab: 'demo' | 'real' | 'compare' = 'demo';

  openTrades: OpenTrade[] = [];
  closedTrades: ClosedTrade[] = [];

  // Compare tab data
  demoTrades:  ClosedTrade[] = [];
  realTrades:  ClosedTrade[] = [];

  switchTab(tab: 'demo' | 'real' | 'compare'): void {
    this.activeTab = tab;
    this.accountBalance = 0; // reset so stored goal balance takes effect
    this.loadGoals();
    if (tab === 'compare') {
      this.tradeService.getTrades('demo').subscribe(d => { this.demoTrades = d.closed; this.cdr.detectChanges(); });
      this.tradeService.getTrades('real').subscribe(d => { this.realTrades = d.closed; this.cdr.detectChanges(); });
    } else {
      this.tradeService.getTrades(tab).subscribe(data => {
        this.openTrades  = data.open;
        this.closedTrades = data.closed;
        this.page = 1;
        this.updateCharts();
        this.cdr.detectChanges();
      });
    }
  }

  private closedStats(trades: ClosedTrade[]): {
    winRate: string; netPnL: number; avgWin: number; avgLoss: number; total: number;
  } {
    const wins   = trades.filter(t => t.outcome === 'win');
    const losses = trades.filter(t => t.outcome === 'loss');
    const netPnL = trades.reduce((s, t) => s + (t.outcome === 'win' ? t.amount : -t.amount), 0);
    return {
      total:   trades.length,
      winRate: trades.length ? Math.round(wins.length / trades.length * 100) + '%' : '0%',
      netPnL,
      avgWin:  wins.length   ? wins.reduce((s, t)   => s + t.amount, 0) / wins.length   : 0,
      avgLoss: losses.length ? losses.reduce((s, t) => s + t.amount, 0) / losses.length : 0,
    };
  }

  get demoStats()  { return this.closedStats(this.demoTrades); }
  get realStats()  { return this.closedStats(this.realTrades); }

  // Daily goal
  accountBalance = 0;
  goalTargetPct = 2;
  private liveAccountType: 'demo' | 'real' | null = null;
  showGoalSettings = false;
  goalSettingInput = 2;

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
  private forecastChart: Chart | null = null;
  private subs = new Subscription();
  private clockInterval: ReturnType<typeof setInterval> | null = null;
  private chartsInitialized = false;

  constructor(
    private tradeService: TradeService,
    private wsService: WebSocketService,
    private calcShare: CalculatorShareService,
    private cdr: ChangeDetectorRef
  ) {}

  private activeGoalType(): 'demo' | 'real' {
    return this.activeTab === 'real' ? 'real' : 'demo';
  }

  private loadGoals(): void {
    this.tradeService.getGoals().subscribe({
      next: goals => {
        const entry        = goals[this.activeGoalType()];
        this.goalTargetPct    = entry?.goalPct ?? 2;
        this.goalSettingInput = this.goalTargetPct;
        // Always use the stored balance for this tab unless the live account matches
        if (entry?.balance && this.liveAccountType !== this.activeGoalType()) {
          this.accountBalance = entry.balance;
        } else if (entry?.balance && !this.accountBalance) {
          this.accountBalance = entry.balance;
        }
        this.updateForecastChart();
        this.cdr.detectChanges();
      },
      error: () => {},
    });
  }

  ngOnInit(): void {

    this.updateOpenDate();
    this.clockInterval = setInterval(() => this.updateOpenDate(), 60000);

    // Live updates — only apply to the matching active tab
    this.subs.add(
      this.wsService.messages$.subscribe((data: TradeData) => {
        if (this.activeTab === 'compare') return;
        this.openTrades  = data.open;
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

    // Initial load for the default tab
    this.switchTab(this.activeTab);
    this.loadGoals();

    this.tradeService.getAccount().subscribe((acc) => {
      if (acc.accountType) this.liveAccountType = acc.accountType as 'demo' | 'real';
      if (acc.balance && (!acc.accountType || acc.accountType === this.activeGoalType())) {
        this.accountBalance = acc.balance;
        this.updateForecastChart();
        this.cdr.detectChanges();
      }
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

  // --- Daily goal ---
  get todayDateStr(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  get todayNetPnL(): number {
    const today = this.todayDateStr;
    return this.closedTrades
      .filter(t => {
        const d = this.parseDate(t.closeDate);
        return !isNaN(d.getTime()) && d.toLocaleDateString('en-CA') === today;
      })
      .reduce((s, t) => s + (t.outcome === 'win' ? t.amount : -t.amount), 0);
  }

  get todayStartBalance(): number {
    return Math.max(0, this.accountBalance - this.todayNetPnL);
  }

  get todayGoalTarget(): number {
    return this.todayStartBalance * (this.goalTargetPct / 100);
  }

  get todayGoalProgress(): number {
    if (!this.todayGoalTarget) return 0;
    return Math.min(100, Math.max(0, (this.todayNetPnL / this.todayGoalTarget) * 100));
  }

  get todayGoalMet(): boolean {
    return this.todayGoalTarget > 0 && this.todayNetPnL >= this.todayGoalTarget;
  }

  private getDailyStats(): { date: string; netPnL: number; startBalance: number; goalMet: boolean }[] {
    if (!this.accountBalance || !this.closedTrades.length) return [];

    const allTimeNet = this.closedTrades.reduce(
      (s, t) => s + (t.outcome === 'win' ? t.amount : -t.amount), 0);
    let running = this.accountBalance - allTimeNet;

    const sorted = [...this.closedTrades].sort((a, b) => {
      const ta = this.parseDate(a.closeDate).getTime();
      const tb = this.parseDate(b.closeDate).getTime();
      return (isNaN(ta) ? Infinity : ta) - (isNaN(tb) ? Infinity : tb);
    });

    const byDay = new Map<string, ClosedTrade[]>();
    for (const t of sorted) {
      const d = this.parseDate(t.closeDate);
      if (isNaN(d.getTime())) continue;
      const day = d.toLocaleDateString('en-CA');
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(t);
    }

    const result: { date: string; netPnL: number; startBalance: number; goalMet: boolean }[] = [];
    for (const [date, trades] of byDay) {
      const startBalance = running;
      const dayNet = trades.reduce((s, t) => s + (t.outcome === 'win' ? t.amount : -t.amount), 0);
      const target = startBalance * (this.goalTargetPct / 100);
      result.push({ date, netPnL: dayNet, startBalance, goalMet: startBalance > 0 && dayNet >= target });
      running += dayNet;
    }
    return result;
  }

  get goalMetCount(): number {
    return this.getDailyStats().filter(d => d.goalMet).length;
  }

  get totalTradingDays(): number {
    return this.getDailyStats().length;
  }

  get goalHitRate(): string {
    const total = this.totalTradingDays;
    if (!total) return '0%';
    return Math.round((this.goalMetCount / total) * 100) + '%';
  }

  saveGoalSettings(): void {
    this.goalTargetPct = this.goalSettingInput || 2;
    this.tradeService.saveGoal(this.activeGoalType(), this.goalTargetPct).subscribe({ error: () => {} });
    this.showGoalSettings = false;
    this.updateCharts();
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
    this.createForecastChart();
  }

  private destroyCharts(): void {
    this.pnlChart?.destroy();      this.pnlChart = null;
    this.donutChart?.destroy();    this.donutChart = null;
    this.riskChart?.destroy();     this.riskChart = null;
    this.forecastChart?.destroy(); this.forecastChart = null;
  }

  private updateCharts(): void {
    if (!this.chartsInitialized) return;
    this.updatePnLChart();
    this.updateDonutChart();
    this.updateRiskChart();
    this.updateForecastChart();
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

  private buildForecastData(): { labels: string[]; currentPace: number[]; goalPace: number[]; avgDailyPct: number } {
    const currentBalance = this.accountBalance;
    if (!currentBalance) return { labels: [], currentPace: [], goalPace: [], avgDailyPct: 0 };

    const stats = this.getDailyStats();

    // Average daily % gain (compounding basis)
    const avgDailyPct = stats.length
      ? stats.reduce((s, d) => s + (d.startBalance > 0 ? (d.netPnL / d.startBalance) * 100 : 0), 0) / stats.length
      : 0;

    let tradingDaysPerMonth = 20;
    if (stats.length >= 2) {
      const firstDate = new Date(stats[0].date);
      const lastDate  = new Date(stats[stats.length - 1].date);
      const calMonths = Math.max(1,
        (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
      tradingDaysPerMonth = Math.max(1, Math.round(stats.length / calMonths));
    }

    const labels = ['Now'];
    const currentPace = [+currentBalance.toFixed(2)];
    const goalPace    = [+currentBalance.toFixed(2)];
    let balCurrent = currentBalance;
    let balGoal    = currentBalance;
    const today = new Date();

    for (let m = 1; m <= 12; m++) {
      const d = new Date(today.getFullYear(), today.getMonth() + m, 1);
      labels.push(d.toLocaleString('en-NZ', { month: 'short', year: '2-digit' }));
      for (let day = 0; day < tradingDaysPerMonth; day++) {
        balCurrent *= 1 + avgDailyPct / 100;
        balGoal    *= 1 + this.goalTargetPct / 100;
      }
      currentPace.push(+balCurrent.toFixed(2));
      goalPace.push(+balGoal.toFixed(2));
    }

    return { labels, currentPace, goalPace, avgDailyPct };
  }

  private createForecastChart(): void {
    if (!this.forecastChartRef) return;
    const { labels, currentPace, goalPace, avgDailyPct } = this.buildForecastData();
    const goalLabel    = `At daily goal (${this.goalTargetPct}%/day)`;
    const currentLabel = `At current pace (${avgDailyPct >= 0 ? '+' : ''}${avgDailyPct.toFixed(2)}%/day compounded)`;
    this.forecastChart = new Chart(this.forecastChartRef.nativeElement, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: currentLabel,
            data: currentPace,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
          },
          {
            label: goalLabel,
            data: goalPace,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.06)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            borderDash: [6, 3],
          } as any,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#94a3b8' } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${this.formatCurrency(ctx.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: '#64748b' }, grid: { color: '#2a3347' } },
          y: {
            ticks: {
              color: '#64748b',
              callback: (v) => 'NZD ' + Number(v).toFixed(0),
            },
            grid: { color: '#2a3347' },
          },
        },
      },
    });
  }

  private updateForecastChart(): void {
    if (!this.forecastChart) return;
    const { labels, currentPace, goalPace, avgDailyPct } = this.buildForecastData();
    this.forecastChart.data.labels = labels;
    this.forecastChart.data.datasets[0].data  = currentPace;
    this.forecastChart.data.datasets[0].label = `At current pace (${avgDailyPct >= 0 ? '+' : ''}${avgDailyPct.toFixed(2)}%/day compounded)`;
    this.forecastChart.data.datasets[1].data  = goalPace;
    this.forecastChart.data.datasets[1].label = `At daily goal (${this.goalTargetPct}%/day)`;
    this.forecastChart.update();
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
