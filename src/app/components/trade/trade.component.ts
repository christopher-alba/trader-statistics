import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { interval, Subscription } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { TradeService } from '../../services/trade.service';
import { WebSocketService } from '../../services/websocket.service';

interface TradeCommand {
  id: number;
  symbol: string;
  direction: 'buy' | 'sell';
  riskNzd: number;
  slPct: number;
  tpPct: number;
  status: string;
  createdAt: string;
}

@Component({
  selector: 'app-trade',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trade.component.html',
  styleUrl: './trade.component.scss',
})
export class TradeComponent implements OnInit, OnDestroy {
  // Form state
  symbol    = '';
  direction: 'buy' | 'sell' = 'buy';
  riskMode: 'pct' | 'fixed' = 'pct';
  riskPct   = 2;    // % of balance to risk if SL hit
  riskFixed = 20;   // fixed NZD risk
  slMode: 'pct' | 'fixed' = 'pct';
  slPct     = 1;    // SL distance as % of entry price
  slFixed   = 0;    // SL distance as fixed price units
  tpNzdInput = 80;  // desired TP profit in NZD
  autoRR    = true; // auto-set TP = risk × rrMultiplier
  rrMultiplier = 4;
  balance = 0;

  // Pending commands from backend
  pendingCommands: TradeCommand[] = [];
  placing = false;
  cooldown = 0;
  error   = '';
  balanceFromMt5 = false;

  private pollSub?: Subscription;
  private wsSub?: Subscription;
  private cooldownInterval?: ReturnType<typeof setInterval>;

  constructor(
    private http: HttpClient,
    private tradeService: TradeService,
    private ws: WebSocketService,
  ) {}

  ngOnInit() {
    const saved = localStorage.getItem('trader_calc_balance');
    if (saved) this.balance = parseFloat(saved);
    this.fetchAccount();
    this.pollPending();
    // Live balance updates from MT5 via WebSocket
    this.wsSub = this.ws.account$.subscribe(account => {
      if (account.balance !== null && account.balance !== undefined) {
        this.balance = account.balance;
        this.balanceFromMt5 = true;
      }
    });
    // Live ask price for investment calculation
    this.ws.price$.subscribe(p => {
      if (p.symbol === this.symbol.trim().toUpperCase()) this.currentAsk = p.ask;
    });
  }

  ngOnDestroy() {
    this.pollSub?.unsubscribe();
    this.wsSub?.unsubscribe();
    clearInterval(this.cooldownInterval);
  }

  private fetchAccount() {
    this.tradeService.getAccount().subscribe({
      next: account => {
        if (account.balance !== null) {
          this.balance = account.balance;
          this.balanceFromMt5 = true;
        }
      },
      error: () => {},
    });
  }

  private pollPending() {
    this.pollSub = interval(2000)
      .pipe(switchMap(() => this.http.get<TradeCommand[]>('/api/commands')))
      .subscribe({ next: cmds => this.pendingCommands = cmds, error: () => {} });
    // Immediate load
    this.http.get<TradeCommand[]>('/api/commands')
      .subscribe({ next: cmds => this.pendingCommands = cmds, error: () => {} });
  }

  get riskNzd(): number {
    return this.riskMode === 'pct'
      ? +(this.balance * this.riskPct / 100).toFixed(2)
      : this.riskFixed;
  }
  get effectiveTp(): number {
    return this.autoRR ? +(this.riskNzd * this.rrMultiplier).toFixed(2) : this.tpNzdInput;
  }
  get maxRisk(): number    { return +(this.balance * 0.1).toFixed(2); }
  get overLimit(): boolean { return this.balance > 0 && this.riskNzd > this.maxRisk; }
  get slNzd(): number      { return this.riskNzd; }

  currentAsk = 0;
  marginNzd: number | null = null;
  private marginDebounce?: ReturnType<typeof setTimeout>;

  requestMarginCalc(): void {
    const sym = this.symbol.trim().toUpperCase();
    if (!sym || !this.riskNzd) { this.marginNzd = null; return; }
    const slPct   = this.slMode === 'pct'   ? this.slPct   : 0;
    const slFixed = this.slMode === 'fixed' ? this.slFixed : 0;
    if (!slPct && !slFixed) { this.marginNzd = null; return; }
    clearTimeout(this.marginDebounce);
    this.marginDebounce = setTimeout(() => {
      this.tradeService.requestMarginCalc(sym, this.direction, this.riskNzd, slPct, slFixed)
        .subscribe({ next: () => this.pollMarginResult(), error: () => {} });
    }, 400);
  }

  private pollMarginResult(attempts = 0): void {
    if (attempts > 15) return;
    this.tradeService.getMarginCalcResult().subscribe({
      next: r => {
        if (r?.margin != null) { this.marginNzd = r.margin; }
        else setTimeout(() => this.pollMarginResult(attempts + 1), 200);
      },
      error: () => {},
    });
  }
  get tpNzd(): number      { return this.effectiveTp; }
  get rrRatio(): string | null {
    if (!this.riskNzd || !this.effectiveTp) return null;
    return (this.effectiveTp / this.riskNzd).toFixed(2);
  }

  saveBalance() {
    this.balanceFromMt5 = false;
    if (this.balance > 0) localStorage.setItem('trader_calc_balance', String(this.balance));
  }

  setDirection(d: 'buy' | 'sell') { this.direction = d; }

  placeTrade() {
    if (this.placing || this.cooldown > 0) return;
    const slValid = this.slMode === 'pct' ? !!this.slPct : !!this.slFixed;
    if (!this.symbol.trim() || !this.riskNzd || !slValid || !this.tpNzdInput) return;
    if (this.overLimit) { this.error = `Max risk is $${this.maxRisk} (10% of balance)`; return; }
    this.placing = true;
    this.error = '';

    const payload: any = {
      symbol:    this.symbol.trim().toUpperCase(),
      direction: this.direction,
      riskNzd:   this.riskNzd,
      tpNzd:     this.effectiveTp,
    };
    if (this.slMode === 'pct') payload.slPct   = this.slPct;
    else                       payload.slFixed = this.slFixed;

    this.http.post<TradeCommand>('/api/commands', payload).subscribe({
      next: cmd => {
        this.pendingCommands = [...this.pendingCommands, cmd];
        this.placing = false;
        this.startCooldown();
      },
      error: () => {
        this.error = 'Failed to queue trade. Is the server running?';
        this.placing = false;
      },
    });
  }

  private startCooldown() {
    this.cooldown = 5;
    this.symbol = '';
    clearInterval(this.cooldownInterval);
    this.cooldownInterval = setInterval(() => {
      this.cooldown--;
      if (this.cooldown <= 0) {
        this.cooldown = 0;
        clearInterval(this.cooldownInterval);
      }
    }, 1000);
  }

  cancelCommand(id: number) {
    this.http.delete(`/api/commands/${id}`).subscribe({
      next: () => this.pendingCommands = this.pendingCommands.filter(c => c.id !== id),
      error: () => {},
    });
  }

  cancelAll() {
    this.http.delete('/api/commands').subscribe({
      next: () => this.pendingCommands = [],
      error: () => {},
    });
  }

  ageLabel(iso: string): string {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }
}
