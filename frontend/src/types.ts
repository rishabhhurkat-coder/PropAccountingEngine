export type Stage = 'files' | 'convert' | 'table' | 'ready';

export type ImportedFile = {
  id: string; name: string; tradeDate: string; broker: string; records: number; importedAt: string; status: 'ready' | 'processing' | 'issue';
};

export type RawTrade = {
  id: string; date: string; time: string; client: string; side: 'Buy' | 'Sell'; instrument: string; expiry: string; strike: string; option: 'CE' | 'PE'; quantity: number; price: string; order: string; source: string; mergeTradeId: string | number | null;
};

export type Validation = { id: string; label: string; count: number; tone: 'good' | 'warning'; details: string[] };
