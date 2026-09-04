import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { WebSocketService } from './services/websocket.service';
import { TradeService } from './services/trade.service';
import { ClosedTrade } from './models/trade.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
})
export class App implements OnInit, OnDestroy {
  wsConnected = false;
  accountBalance: number | null = null;
  accountEquity: number | null = null;
  accountMargin: number | null = null;
  accountFreeMargin: number | null = null;
  accountMarginLevel: number | null = null;
  accountCurrency: string | null = null;
  goalTargetPct = 2;
  private closedTrades: ClosedTrade[] = [];
  private subs = new Subscription();

  private get todayDateStr(): string {
    return new Date().toLocaleDateString('en-CA');
  }

  private parseDate(str: string): Date {
    if (!str) return new Date(NaN);
    if (/^\d{4}\./.test(str))
      return new Date(str.replace(/^(\d{4})\.(\d{2})\.(\d{2})\s/, '$1-$2-$3T') + 'Z');
    return new Date(str);
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

  get todayGoalTarget(): number {
    if (!this.accountBalance) return 0;
    const startBal = Math.max(0, this.accountBalance - this.todayNetPnL);
    return startBal * (this.goalTargetPct / 100);
  }

  get todayGoalProgress(): number {
    if (!this.todayGoalTarget) return 0;
    return Math.min(100, Math.max(0, (this.todayNetPnL / this.todayGoalTarget) * 100));
  }

  get todayGoalMet(): boolean {
    return this.todayGoalTarget > 0 && this.todayNetPnL >= this.todayGoalTarget;
  }

  constructor(private wsService: WebSocketService, private tradeService: TradeService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    const saved = localStorage.getItem('trader_dailyGoalPct');
    if (saved) this.goalTargetPct = parseFloat(saved) || 2;

    this.wsService.connect();
    this.subs.add(
      this.wsService.connected$.subscribe(v => this.wsConnected = v)
    );
    this.subs.add(
      this.wsService.account$.subscribe(a => {
        if (a.balance !== null) {
          this.accountBalance    = a.balance;
          this.accountMargin     = a.margin      ?? null;
          this.accountFreeMargin = a.freeMargin  ?? null;
          this.accountMarginLevel = a.marginLevel ?? null;
          this.accountCurrency   = a.currency;
        }
      })
    );
    // Recompute equity on every positions tick (balance + floating P&L)
    this.subs.add(
      this.wsService.positions$.subscribe(positions => {
        if (this.accountBalance === null) return;
        const floatingPnL = positions.reduce((sum, p) => sum + (p.profit ?? 0), 0);
        this.accountEquity = +(this.accountBalance + floatingPnL).toFixed(2);
        this.cdr.detectChanges();
      })
    );
    this.subs.add(
      this.wsService.messages$.subscribe(data => {
        this.closedTrades = data.closed;
        this.cdr.detectChanges();
      })
    );
    this.tradeService.getAccount().subscribe({
      next: a => {
        if (a.balance !== null) {
          this.accountBalance     = a.balance;
          this.accountEquity      = a.equity      ?? null;
          this.accountMargin      = a.margin      ?? null;
          this.accountFreeMargin  = a.freeMargin  ?? null;
          this.accountMarginLevel = a.marginLevel ?? null;
          this.accountCurrency    = a.currency;
        }
      },
      error: () => {},
    });
    this.tradeService.getTrades().subscribe({
      next: data => { this.closedTrades = data.closed; this.cdr.detectChanges(); },
      error: () => {},
    });
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.wsService.disconnect();
  }
}
