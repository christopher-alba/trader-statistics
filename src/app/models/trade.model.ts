export interface OpenTrade {
  id: number;
  instrument: string;
  investmentSize?: number;
  volume?: number;
  riskPct: number;
  riskNzd: number;
  slPrice?: number;
  openDate: string;
  notes?: string;
  source: 'manual' | 'mt5';
  mt5Ticket?: number;
  positionId?: number;
  price?: number;
  tp?: number;
  currency?: string;
}

export interface ClosedTrade extends OpenTrade {
  outcome: 'win' | 'loss';
  amount: number;
  closeDate: string;
  closeNotes?: string;
}

export interface TradeData {
  open: OpenTrade[];
  closed: ClosedTrade[];
}

export interface JournalEntry {
  id: number;
  title: string;
  body: string;
  notes: string;
  date: string;
}
