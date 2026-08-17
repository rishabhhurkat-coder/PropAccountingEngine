export type TradeBookTab = 'All Trades' | 'Open Trades' | 'Closed Trades';
export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = string;

export type TradeBookRecord = {
  id: string;
  date: string;
  time: string;
  tradeId: string;
  side: TradeSide;
  scrip: string;
  expiry: string;
  strike: string;
  optType: 'CE' | 'PE' | string;
  qty: number;
  price: number;
  cmp: number | null;
  mtm: number;
  strategy: string;
  status: TradeStatus;
};

export const tradeBookTabs: TradeBookTab[] = ['All Trades', 'Open Trades', 'Closed Trades'];

export const tradeBookTabViewMap: Record<TradeBookTab, 'all' | 'open' | 'closed'> = {
  'All Trades': 'all',
  'Open Trades': 'open',
  'Closed Trades': 'closed',
};
