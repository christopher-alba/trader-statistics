import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { TradeService } from '../../services/trade.service';
import { WebSocketService } from '../../services/websocket.service';
import { OpenTrade, ClosedTrade, TradeData } from '../../models/trade.model';

type AnyTrade = (OpenTrade | ClosedTrade) & { isClosed?: boolean };

@Component({
  selector: 'app-journal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './journal.component.html',
  styleUrls: ['./journal.component.scss'],
})
export class JournalComponent implements OnInit, OnDestroy {
  allTrades: AnyTrade[] = [];
  searchText = '';
  outcomeFilter = 'all'; // all | win | loss | open
  sortBy = 'date-desc';   // date-desc | date-asc | pnl | risk

  private subs = new Subscription();

  constructor(
    private tradeService: TradeService,
    private wsService: WebSocketService
  ) {}

  ngOnInit(): void {
    this.tradeService.getTrades().subscribe((data) => this.setData(data));
    this.subs.add(
      this.wsService.messages$.subscribe((data: TradeData) => this.setData(data))
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  private setData(data: TradeData): void {
    const closed = data.closed.map(t => ({ ...t, isClosed: true })) as AnyTrade[];
    const open = data.open.map(t => ({ ...t, isClosed: false })) as AnyTrade[];
    this.allTrades = [...closed, ...open];
  }

  get filteredTrades(): AnyTrade[] {
    let result = this.allTrades.filter(t => {
      const search = this.searchText.toLowerCase();
      const matchesSearch =
        !search ||
        t.instrument.toLowerCase().includes(search) ||
        (t.notes || '').toLowerCase().includes(search);

      let matchesOutcome = true;
      if (this.outcomeFilter === 'open') matchesOutcome = !t.isClosed;
      else if (this.outcomeFilter === 'win') matchesOutcome = !!t.isClosed && (t as ClosedTrade).outcome === 'win';
      else if (this.outcomeFilter === 'loss') matchesOutcome = !!t.isClosed && (t as ClosedTrade).outcome === 'loss';

      return matchesSearch && matchesOutcome;
    });

    result.sort((a, b) => {
      switch (this.sortBy) {
        case 'date-asc':
          return new Date(a.openDate).getTime() - new Date(b.openDate).getTime();
        case 'date-desc':
          return new Date(b.openDate).getTime() - new Date(a.openDate).getTime();
        case 'pnl':
          const pa = a.isClosed ? ((a as ClosedTrade).outcome === 'win' ? (a as ClosedTrade).amount : -(a as ClosedTrade).amount) : 0;
          const pb = b.isClosed ? ((b as ClosedTrade).outcome === 'win' ? (b as ClosedTrade).amount : -(b as ClosedTrade).amount) : 0;
          return pb - pa;
        case 'risk':
          return b.riskPct - a.riskPct;
        default:
          return 0;
      }
    });

    return result;
  }

  cardClass(trade: AnyTrade): string {
    if (!trade.isClosed) return 'card--open';
    const ct = trade as ClosedTrade;
    return ct.outcome === 'win' ? 'card--win' : 'card--loss';
  }

  pnl(trade: AnyTrade): number {
    if (!trade.isClosed) return 0;
    const ct = trade as ClosedTrade;
    return ct.outcome === 'win' ? ct.amount : -ct.amount;
  }

  rr(trade: AnyTrade): string {
    if (!trade.isClosed) return 'N/A';
    const ct = trade as ClosedTrade;
    if (!ct.riskNzd || ct.riskNzd === 0) return 'N/A';
    return (ct.amount / ct.riskNzd).toFixed(2) + 'R';
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-NZ', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  formatCurrency(val: number): string {
    return val.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD', minimumFractionDigits: 2 });
  }

  asClosed(trade: AnyTrade): ClosedTrade {
    return trade as ClosedTrade;
  }
}
