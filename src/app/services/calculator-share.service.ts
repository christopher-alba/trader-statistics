import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface CalcValues {
  instrument?: string;
  riskPct?: number;
  riskNzd?: number;
  investmentSize?: number;
}

@Injectable({ providedIn: 'root' })
export class CalculatorShareService {
  private transferSubject = new Subject<CalcValues>();
  transfer$ = this.transferSubject.asObservable();

  send(values: CalcValues): void {
    this.transferSubject.next(values);
  }
}
