export type TradeBookTab = 'All Trades' | 'Open Trades' | 'Closed Trades';
export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED';

export type TradeBookRecord = {
  id: string;
  date: string;
  time: string;
  tradeId: string;
  side: TradeSide;
  scrip: string;
  expiry: string;
  strike: string;
  optType: 'CE' | 'PE';
  qty: number;
  price: number;
  mtm: number;
  strategy: string;
  status: TradeStatus;
};

const defaultTradeDate = '01 Aug 2026';

export const tradeBookDummyData: TradeBookRecord[] = [
  { id: '1', date: defaultTradeDate, time: '12:01:15', tradeId: 'A00184-1', side: 'SELL', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23800', optType: 'PE', qty: 260, price: 209.19, mtm: -260, strategy: 'Nifty FING 500', status: 'OPEN' },
  { id: '2', date: defaultTradeDate, time: '13:02:45', tradeId: 'A00184-2', side: 'BUY', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23800', optType: 'PE', qty: 260, price: 199.55, mtm: 260, strategy: 'Unassigned', status: 'OPEN' },
  { id: '3', date: defaultTradeDate, time: '12:01:15', tradeId: 'A00184-3', side: 'SELL', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23900', optType: 'PE', qty: 520, price: 237.89, mtm: -520, strategy: 'Nifty FING 400', status: 'OPEN' },
  { id: '4', date: defaultTradeDate, time: '13:02:45', tradeId: 'A00184-4', side: 'BUY', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23900', optType: 'PE', qty: 520, price: 231.44, mtm: 520, strategy: 'Unassigned', status: 'OPEN' },
  { id: '5', date: defaultTradeDate, time: '14:16:33', tradeId: 'A00184-5', side: 'SELL', scrip: 'BANKNIFTY', expiry: '28-Jul-26', strike: '57500', optType: 'PE', qty: 120, price: 310.71, mtm: -120, strategy: 'Banknifty AVWAP 800', status: 'OPEN' },
  { id: '6', date: defaultTradeDate, time: '14:16:33', tradeId: 'A00184-6', side: 'SELL', scrip: 'BANKNIFTY', expiry: '28-Jul-26', strike: '57700', optType: 'PE', qty: 60, price: 371.77, mtm: -60, strategy: 'Banknifty AVWAP 600', status: 'OPEN' },
  { id: '7', date: defaultTradeDate, time: '14:05:21', tradeId: 'A00184-7', side: 'BUY', scrip: 'BANKNIFTY', expiry: '28-Jul-26', strike: '58300', optType: 'CE', qty: 60, price: 427.6, mtm: 60, strategy: 'Unassigned', status: 'OPEN' },
  { id: '8', date: defaultTradeDate, time: '14:07:11', tradeId: 'A00184-8', side: 'SELL', scrip: 'BANKNIFTY', expiry: '25-Aug-26', strike: '57200', optType: 'PE', qty: 120, price: 568.6, mtm: -120, strategy: 'Banknifty FING 800', status: 'OPEN' },
  { id: '9', date: defaultTradeDate, time: '14:07:11', tradeId: 'A00184-9', side: 'SELL', scrip: 'BANKNIFTY', expiry: '25-Aug-26', strike: '57400', optType: 'PE', qty: 60, price: 632, mtm: -60, strategy: 'Banknifty FING 600', status: 'OPEN' },
  { id: '10', date: defaultTradeDate, time: '14:08:26', tradeId: 'A00184-10', side: 'BUY', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23700', optType: 'CE', qty: 180, price: 184.25, mtm: 180, strategy: 'Unassigned', status: 'OPEN' },
  { id: '11', date: defaultTradeDate, time: '14:12:42', tradeId: 'A00184-11', side: 'SELL', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23600', optType: 'PE', qty: 140, price: 205.8, mtm: -140, strategy: 'Nifty FING 300', status: 'CLOSED' },
  { id: '12', date: defaultTradeDate, time: '11:54:03', tradeId: 'A00184-12', side: 'BUY', scrip: 'BANKNIFTY', expiry: '28-Jul-26', strike: '58000', optType: 'CE', qty: 60, price: 396.4, mtm: 340, strategy: 'Banknifty AVWAP 400', status: 'CLOSED' },
  { id: '13', date: defaultTradeDate, time: '10:42:18', tradeId: 'A00184-13', side: 'SELL', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23500', optType: 'PE', qty: 200, price: 172.5, mtm: -210, strategy: 'Nifty FING 200', status: 'CLOSED' },
  { id: '14', date: defaultTradeDate, time: '10:18:41', tradeId: 'A00184-14', side: 'BUY', scrip: 'BANKNIFTY', expiry: '28-Jul-26', strike: '57000', optType: 'CE', qty: 60, price: 318.71, mtm: 510, strategy: 'Iron Condor', status: 'CLOSED' },
  { id: '15', date: defaultTradeDate, time: '09:58:09', tradeId: 'A00184-15', side: 'SELL', scrip: 'NIFTY', expiry: '25-Aug-26', strike: '23400', optType: 'PE', qty: 120, price: 154.7, mtm: -85, strategy: 'Unassigned', status: 'CLOSED' },
];

export const tradeBookTabCounts: Record<TradeBookTab, number> = { 'All Trades': 156, 'Open Trades': 28, 'Closed Trades': 128 };
