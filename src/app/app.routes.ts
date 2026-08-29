import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./components/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'journal',
    loadComponent: () =>
      import('./components/journal/journal.component').then(m => m.JournalComponent),
  },
  {
    path: 'calculator',
    loadComponent: () =>
      import('./components/calculator/calculator.component').then(m => m.CalculatorComponent),
  },
  {
    path: 'trade',
    loadComponent: () =>
      import('./components/trade/trade.component').then(m => m.TradeComponent),
  },
  {
    path: 'chart',
    loadComponent: () =>
      import('./components/chart/chart.component').then(m => m.ChartComponent),
  },
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: '**', redirectTo: 'dashboard' },
];
