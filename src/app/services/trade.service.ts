import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { TradeData, OpenTrade, ClosedTrade } from '../models/trade.model';

const BASE = 'http://localhost:3000/api';

@Injectable({ providedIn: 'root' })
export class TradeService {
  constructor(private http: HttpClient) {}

  getTrades(type?: 'demo' | 'real'): Observable<TradeData> {
    const url = type ? `${BASE}/trades/${type}` : `${BASE}/trades`;
    return this.http.get<TradeData>(url);
  }

  openTrade(trade: Partial<OpenTrade>): Observable<OpenTrade> {
    return this.http.post<OpenTrade>(`${BASE}/trade/open`, trade);
  }

  closeTrade(payload: {
    id?: number;
    ticket?: number;
    outcome: 'win' | 'loss';
    amount: number;
    closeDate?: string;
    closeNotes?: string;
  }): Observable<ClosedTrade> {
    return this.http.post<ClosedTrade>(`${BASE}/trade/close`, payload);
  }

  deleteTrade(id: number): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${BASE}/trade/${id}`);
  }

  clearAllTrades(): Observable<{ cleared: boolean }> {
    return this.http.delete<{ cleared: boolean }>(`${BASE}/trades`);
  }

  getAccount(): Observable<{ balance: number | null; equity: number | null; margin: number | null; freeMargin: number | null; marginLevel: number | null; currency: string | null; accountType: 'demo' | 'real' | null; updatedAt: string | null }> {
    return this.http.get<any>(`${BASE}/account`);
  }

  getPrice(symbol: string): Observable<{ bid: number; ask: number; updatedAt: string }> {
    return this.http.get<any>(`${BASE}/price/${encodeURIComponent(symbol.toUpperCase())}`);
  }

  getBars(symbol: string): Observable<{ timeframe: number; bars: any[]; secsLeft: number | null }> {
    return this.http.get<any>(`${BASE}/bars/${encodeURIComponent(symbol.toUpperCase())}`);
  }

  getPositions(): Observable<any[]> {
    return this.http.get<any[]>(`${BASE}/positions`);
  }

  modifyPosition(ticket: number, slNzd: number, tpNzd: number): Observable<any> {
    return this.http.post(`${BASE}/modify`, { ticket, slNzd, tpNzd });
  }

  closePosition(ticket: number): Observable<any> {
    return this.http.post(`${BASE}/close`, { ticket });
  }

  placeCommand(payload: { symbol: string; direction: string; riskNzd: number; slPct: number; tpNzd?: number; tpPct?: number }): Observable<any> {
    return this.http.post(`${BASE}/commands`, payload);
  }

  requestMarginCalc(symbol: string, direction: string, riskNzd: number, slPct: number, slFixed: number): Observable<void> {
    return this.http.post<void>(`${BASE}/calc-margin/request`, { symbol, direction, riskNzd, slPct, slFixed });
  }

  getMarginCalcResult(): Observable<{ margin: number } | null> {
    return this.http.get<{ margin: number } | null>(`${BASE}/calc-margin/result`);
  }

  getGoals(): Observable<{ demo: { goalPct: number; balance: number | null }; real: { goalPct: number; balance: number | null } }> {
    return this.http.get<any>(`${BASE}/goals`);
  }

  saveGoal(type: 'demo' | 'real', value: number): Observable<any> {
    return this.http.post<any>(`${BASE}/goals`, { type, value });
  }
}
