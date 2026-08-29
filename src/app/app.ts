import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { WebSocketService } from './services/websocket.service';
import { TradeService } from './services/trade.service';

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
  private subs = new Subscription();

  constructor(private wsService: WebSocketService, private tradeService: TradeService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
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
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.wsService.disconnect();
  }
}
