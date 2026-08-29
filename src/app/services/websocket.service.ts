import { Injectable, OnDestroy } from '@angular/core';
import { Observable, ReplaySubject, BehaviorSubject, Subject } from 'rxjs';
import { TradeData } from '../models/trade.model';

export interface AccountData {
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  currency: string | null;
  updatedAt: string | null;
}

export interface PriceData {
  symbol: string;
  bid: number;
  ask: number;
  updatedAt: string;
}

export interface BarData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BarUpdate {
  symbol: string;
  bar: BarData;
}

export interface IndicatorUpdate {
  symbol: string;
  time: number;
  indicators: Record<string, number>;
}

export interface Position {
  ticket: number;
  symbol: string;
  sl: number;
  tp: number;
  slNzd: number;
  tpNzd: number;
  price: number;
  profit: number;
  type: 'buy' | 'sell';
}

const WS_URL = 'ws://localhost:3000';
const RECONNECT_DELAY = 3000;

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private ws: WebSocket | null = null;
  private messageSubject = new ReplaySubject<TradeData>(1);
  private accountSubject = new ReplaySubject<AccountData>(1);
  private priceSubject = new Subject<PriceData>();
  private barUpdateSubject = new Subject<BarUpdate>();
  private positionsSubject = new ReplaySubject<Position[]>(1);
  private indicatorSubject = new Subject<IndicatorUpdate>();
  private connectedSubject = new BehaviorSubject<boolean>(false);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  messages$: Observable<TradeData> = this.messageSubject.asObservable();
  account$: Observable<AccountData> = this.accountSubject.asObservable();
  price$: Observable<PriceData> = this.priceSubject.asObservable();
  barUpdate$: Observable<BarUpdate> = this.barUpdateSubject.asObservable();
  positions$: Observable<Position[]> = this.positionsSubject.asObservable();
  indicatorUpdate$: Observable<IndicatorUpdate> = this.indicatorSubject.asObservable();
  connected$: Observable<boolean> = this.connectedSubject.asObservable();

  connect(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        console.log('[WS] Connected');
        this.connectedSubject.next(true);
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'update' && parsed.data) {
            this.messageSubject.next(parsed.data as TradeData);
          } else if (parsed.type === 'account' && parsed.data) {
            this.accountSubject.next(parsed.data as AccountData);
          } else if (parsed.type === 'price' && parsed.data) {
            this.priceSubject.next(parsed.data as PriceData);
          } else if (parsed.type === 'bar_update' && parsed.data) {
            this.barUpdateSubject.next(parsed.data as BarUpdate);
          } else if (parsed.type === 'positions' && parsed.data) {
            this.positionsSubject.next(parsed.data as Position[]);
          } else if (parsed.type === 'indicator_update' && parsed.data) {
            this.indicatorSubject.next(parsed.data as IndicatorUpdate);
          }
        } catch (e) {
          console.error('[WS] Failed to parse message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('[WS] Disconnected - reconnecting in 3s...');
        this.connectedSubject.next(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        console.error('[WS] Error', err);
        this.connectedSubject.next(false);
      };
    } catch (e) {
      console.error('[WS] Could not connect:', e);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY);
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
