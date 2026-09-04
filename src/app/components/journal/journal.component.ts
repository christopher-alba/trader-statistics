import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription, catchError, of } from 'rxjs';
import { TradeService } from '../../services/trade.service';
import { WebSocketService } from '../../services/websocket.service';
import { OpenTrade, ClosedTrade, TradeData, JournalEntry } from '../../models/trade.model';

type AnyTrade = (OpenTrade | ClosedTrade) & { isClosed?: boolean };

@Component({
  selector: 'app-journal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './journal.component.html',
  styleUrls: ['./journal.component.scss'],
})
export class JournalComponent implements OnInit, OnDestroy {
  activeTab: 'demo' | 'real' = 'demo';

  allTrades: AnyTrade[] = [];
  journalEntries: JournalEntry[] = [];

  // Trade column filters
  tradeSearch = '';
  outcomeFilter = 'all';
  tradeSortBy = 'date-desc';

  // Entry column filters
  entrySearch = '';
  entrySortBy = 'date-desc';

  // Clicked entry — filters trades column to that day
  selectedEntry: JournalEntry | null = null;

  // New entry form
  showNewEntryForm = false;
  newEntryTitle = '';
  newEntryBody = '';
  newEntryNotes = '';

  // Inline edit state — journal entries
  editingEntryId: number | null = null;
  editTitle = '';
  editBody = '';
  editNotes = '';

  // Inline edit state — trade notes
  editingTradeId: number | null = null;
  editTradeNotes = '';
  editTradeCloseNotes = '';

  private subs = new Subscription();

  constructor(
    private tradeService: TradeService,
    private wsService: WebSocketService
  ) {}

  ngOnInit(): void {
    this.loadAll();
    this.subs.add(
      this.wsService.messages$.subscribe((data: TradeData) => this.setData(data))
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
  }

  switchTab(tab: 'demo' | 'real'): void {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    this.selectedEntry = null;
    this.editingEntryId = null;
    this.editingTradeId = null;
    this.showNewEntryForm = false;
    this.loadAll();
  }

  private loadAll(): void {
    this.tradeService.getTrades(this.activeTab).subscribe(data => this.setData(data));
    this.tradeService.getJournalEntries(this.activeTab).subscribe(entries => {
      this.journalEntries = entries;
    });
  }

  private setData(data: TradeData): void {
    const closed = data.closed.map(t => ({ ...t, isClosed: true })) as AnyTrade[];
    const open   = data.open.map(t => ({ ...t, isClosed: false })) as AnyTrade[];
    this.allTrades = [...closed, ...open];
  }

  private sameDay(a: string, b: string): boolean {
    if (!a || !b) return false;
    const NZT = 'Pacific/Auckland';
    const fmt = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: NZT }); // YYYY-MM-DD
    return fmt(this.parseDate(a)) === fmt(this.parseDate(b));
  }

  get filteredTrades(): AnyTrade[] {
    const search = this.tradeSearch.toLowerCase();
    return this.allTrades
      .filter(t => {
        if (this.selectedEntry) {
          const day = this.selectedEntry.date;
          const matchesDay = this.sameDay(t.openDate, day) ||
            (t.isClosed && this.sameDay((t as ClosedTrade).closeDate, day));
          if (!matchesDay) return false;
        }
        const matchesSearch = !search ||
          t.instrument.toLowerCase().includes(search) ||
          (t.notes || '').toLowerCase().includes(search);
        let matchesOutcome = true;
        if (this.outcomeFilter === 'open')  matchesOutcome = !t.isClosed;
        else if (this.outcomeFilter === 'win')  matchesOutcome = !!t.isClosed && (t as ClosedTrade).outcome === 'win';
        else if (this.outcomeFilter === 'loss') matchesOutcome = !!t.isClosed && (t as ClosedTrade).outcome === 'loss';
        return matchesSearch && matchesOutcome;
      })
      .sort((a, b) => {
        switch (this.tradeSortBy) {
          case 'date-asc':  return new Date(a.openDate).getTime() - new Date(b.openDate).getTime();
          case 'date-desc': return new Date(b.openDate).getTime() - new Date(a.openDate).getTime();
          case 'pnl': {
            const pa = a.isClosed ? ((a as ClosedTrade).outcome === 'win' ? (a as ClosedTrade).amount : -(a as ClosedTrade).amount) : 0;
            const pb = b.isClosed ? ((b as ClosedTrade).outcome === 'win' ? (b as ClosedTrade).amount : -(b as ClosedTrade).amount) : 0;
            return pb - pa;
          }
          case 'risk': return b.riskPct - a.riskPct;
          default: return 0;
        }
      });
  }

  get filteredEntries(): JournalEntry[] {
    const search = this.entrySearch.toLowerCase();
    return this.journalEntries
      .filter(e => !search ||
        e.title.toLowerCase().includes(search) ||
        e.body.toLowerCase().includes(search) ||
        (e.notes || '').toLowerCase().includes(search))
      .sort((a, b) => {
        switch (this.entrySortBy) {
          case 'date-asc':  return new Date(a.date).getTime() - new Date(b.date).getTime();
          case 'date-desc': return new Date(b.date).getTime() - new Date(a.date).getTime();
          default: return 0;
        }
      });
  }

  // --- Entry selection ---
  selectEntry(entry: JournalEntry): void {
    this.selectedEntry = this.selectedEntry?.id === entry.id ? null : entry;
  }

  clearSelection(): void {
    this.selectedEntry = null;
  }

  // --- New entry form ---
  openNewEntryForm(): void {
    this.showNewEntryForm = true;
    this.newEntryTitle = '';
    this.newEntryBody = '';
    this.newEntryNotes = '';
  }

  cancelNewEntry(): void {
    this.showNewEntryForm = false;
  }

  saveNewEntry(): void {
    if (!this.newEntryBody.trim()) return;
    this.tradeService.createJournalEntry(
      { title: this.newEntryTitle.trim(), body: this.newEntryBody.trim(), notes: this.newEntryNotes.trim() },
      this.activeTab,
    ).subscribe(entry => {
      this.journalEntries.unshift(entry);
      this.showNewEntryForm = false;
    });
  }

  // --- Inline edit entries ---
  startEdit(entry: JournalEntry, event: Event): void {
    event.stopPropagation();
    this.editingEntryId = entry.id;
    this.editTitle = entry.title;
    this.editBody  = entry.body;
    this.editNotes = entry.notes || '';
  }

  cancelEdit(): void {
    this.editingEntryId = null;
  }

  saveEdit(entry: JournalEntry): void {
    if (!this.editBody.trim()) return;
    this.tradeService.updateJournalEntry(
      entry.id,
      { title: this.editTitle.trim(), body: this.editBody.trim(), notes: this.editNotes.trim() },
      this.activeTab,
    ).subscribe(updated => {
      const idx = this.journalEntries.findIndex(e => e.id === updated.id);
      if (idx !== -1) this.journalEntries[idx] = updated;
      if (this.selectedEntry?.id === updated.id) this.selectedEntry = updated;
      this.editingEntryId = null;
    });
  }

  deleteEntry(entry: JournalEntry, event: Event): void {
    event.stopPropagation();
    this.tradeService.deleteJournalEntry(entry.id, this.activeTab).subscribe(() => {
      this.journalEntries = this.journalEntries.filter(e => e.id !== entry.id);
      if (this.selectedEntry?.id === entry.id) this.selectedEntry = null;
    });
  }

  // --- Trade note editing ---
  startEditTrade(trade: AnyTrade, event: Event): void {
    event.stopPropagation();
    this.editingTradeId = trade.id;
    this.editTradeNotes = trade.notes || '';
    this.editTradeCloseNotes = trade.isClosed ? ((trade as ClosedTrade).closeNotes || '') : '';
  }

  cancelEditTrade(): void {
    this.editingTradeId = null;
  }

  saveEditTrade(trade: AnyTrade): void {
    this.tradeService.updateTradeNotes(
      trade.id,
      this.editTradeNotes,
      trade.isClosed ? this.editTradeCloseNotes : undefined,
    ).subscribe(() => {
      this.editingTradeId = null;
    });
  }

  // --- Trade helpers ---
  cardClass(trade: AnyTrade): string {
    if (!trade.isClosed) return 'card--open';
    return (trade as ClosedTrade).outcome === 'win' ? 'card--win' : 'card--loss';
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

  private parseDate(str: string): Date {
    if (!str) return new Date(NaN);
    // MT5 format "2026.09.04 09:24:54" — broker runs UTC+2 (EET)
    if (/^\d{4}\./.test(str))
      return new Date(str.replace(/^(\d{4})\.(\d{2})\.(\d{2})\s/, '$1-$2-$3T') + '+03:00');
    return new Date(str);
  }

  formatDate(iso: string): string {
    if (!iso) return '';
    return this.parseDate(iso).toLocaleDateString('en-NZ', {
      year: 'numeric', month: 'short', day: 'numeric',
      timeZone: 'Pacific/Auckland',
    });
  }

  formatDateTime(iso: string): string {
    if (!iso) return '';
    return this.parseDate(iso).toLocaleString('en-NZ', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Pacific/Auckland',
    });
  }

  formatCurrency(val: number): string {
    return val.toLocaleString('en-NZ', { style: 'currency', currency: 'NZD', minimumFractionDigits: 2 });
  }

  asClosed(trade: AnyTrade): ClosedTrade { return trade as ClosedTrade; }

  tradeDuration(trade: AnyTrade): string {
    if (!trade.isClosed) return 'Open';
    const ct = trade as ClosedTrade;
    if (!ct.closeDate) return '';
    const ms = this.parseDate(ct.closeDate).getTime() - this.parseDate(ct.openDate).getTime();
    if (ms < 0) return '';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}
