import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CalculatorShareService } from '../../services/calculator-share.service';
import { TradeService } from '../../services/trade.service';
import { WebSocketService } from '../../services/websocket.service';

const LS_PREFIX = 'trader_calc_';

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './calculator.component.html',
  styleUrls: ['./calculator.component.scss'],
})
export class CalculatorComponent implements OnInit, OnDestroy {
  balance = 10000;
  riskPct = 1;
  currentPrice = 1.0;
  leverage = 500;
  nzdusd = 0.6;
  instrument = '';
  balanceFromMt5 = false;
  priceFromMt5 = false;
  priceFetchError = '';

  private subs = new Subscription();

  constructor(
    private router: Router,
    private calcShare: CalculatorShareService,
    private tradeService: TradeService,
    private ws: WebSocketService,
  ) {}

  ngOnInit(): void {
    this.loadFromStorage();

    this.tradeService.getAccount().subscribe({
      next: account => {
        if (account.balance !== null) {
          this.balance = account.balance;
          this.balanceFromMt5 = true;
        }
      },
      error: () => {},
    });

    this.subs.add(this.ws.account$.subscribe(account => {
      if (account.balance !== null && account.balance !== undefined) {
        this.balance = account.balance;
        this.balanceFromMt5 = true;
      }
    }));

    // Live price updates from MT5 for the entered instrument
    this.subs.add(this.ws.price$.subscribe(p => {
      if (p.symbol.toUpperCase() === this.instrument.toUpperCase() && this.instrument) {
        this.currentPrice = p.ask;
        this.priceFromMt5 = true;
        this.priceFetchError = '';
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private loadFromStorage(): void {
    const b = localStorage.getItem(LS_PREFIX + 'balance');
    if (b) this.balance = parseFloat(b);
    const l = localStorage.getItem(LS_PREFIX + 'leverage');
    if (l) this.leverage = parseFloat(l);
    const r = localStorage.getItem(LS_PREFIX + 'riskPct');
    if (r) this.riskPct = parseFloat(r);
    const n = localStorage.getItem(LS_PREFIX + 'nzdusd');
    if (n) this.nzdusd = parseFloat(n);
    const p = localStorage.getItem(LS_PREFIX + 'price');
    if (p) this.currentPrice = parseFloat(p);
    const i = localStorage.getItem(LS_PREFIX + 'instrument');
    if (i) this.instrument = i;
  }

  onInstrumentChange(): void {
    localStorage.setItem(LS_PREFIX + 'instrument', this.instrument);
    this.priceFromMt5 = false;
    this.priceFetchError = '';
    if (this.instrument) this.fetchPrice();
  }

  fetchPrice(): void {
    if (!this.instrument) return;
    this.priceFetchError = '';
    this.tradeService.getPrice(this.instrument).subscribe({
      next: p => {
        this.currentPrice = p.ask;
        this.priceFromMt5 = true;
        this.priceFetchError = '';
      },
      error: () => {
        this.priceFetchError = 'No price data — is the EA running on this symbol?';
        this.priceFromMt5 = false;
      },
    });
  }

  onBalanceChange(): void {
    this.balanceFromMt5 = false;
    localStorage.setItem(LS_PREFIX + 'balance', String(this.balance));
  }

  onLeverageChange(): void {
    localStorage.setItem(LS_PREFIX + 'leverage', String(this.leverage));
  }

  onRiskChange(): void {
    localStorage.setItem(LS_PREFIX + 'riskPct', String(this.riskPct));
  }

  onNzdusdChange(): void {
    localStorage.setItem(LS_PREFIX + 'nzdusd', String(this.nzdusd));
  }

  onPriceChange(): void {
    localStorage.setItem(LS_PREFIX + 'price', String(this.currentPrice));
  }

  // units = (balance × risk% × leverage) / (price / nzdusd)
  get units(): number {
    if (!this.currentPrice || !this.nzdusd || !this.leverage) return 0;
    const priceInNzd = this.currentPrice / this.nzdusd;
    return (this.balance * (this.riskPct / 100) * this.leverage) / priceInNzd;
  }

  get formattedUnits(): string {
    const u = this.units;
    if (u > 1000) return u.toFixed(0);
    if (u > 1) return u.toFixed(2);
    if (u > 0.01) return u.toFixed(4);
    return u.toFixed(6);
  }

  // Risk in NZD
  get riskNzd(): number {
    return this.balance * (this.riskPct / 100);
  }

  // Price per unit in NZD
  get pricePerUnitNzd(): number {
    if (!this.nzdusd) return 0;
    return this.currentPrice / this.nzdusd;
  }

  // Notional position value in NZD
  get positionValueNzd(): number {
    return this.units * this.pricePerUnitNzd;
  }

  copyToOpenTrade(): void {
    this.calcShare.send({
      instrument: this.instrument,
      riskPct: this.riskPct,
      riskNzd: this.riskNzd,
      investmentSize: Math.round(this.positionValueNzd),
    });
    this.router.navigate(['/dashboard']);
  }
}
