export type Stage = 'idle' | 'files' | 'convert' | 'table' | 'validate' | 'ready' | 'error';

export type ImportedFile = {
  id: string; name: string; tradeDate: string; broker: string; records: number; importedAt: string; status: 'ready' | 'processing' | 'issue';
};

export type RawTrade = {
  id: string; date: string; time: string; client: string; side: 'Buy' | 'Sell'; instrument: string; expiry: string; strike: string; option: 'CE' | 'PE'; quantity: number; price: string; order: string; source: string; mergeTradeId: string | number | null;
};

export type Validation = { id: string; label: string; count: number; tone: 'good' | 'warning'; details: string[] };

export type PropSessionUser = { id: number; user_name: string; user_type: string; user_class?: string };

export type PropUser = { id: number; user_name: string; user_class: string; user_type: string; is_active: boolean };

export type PropUserInput = { user_name: string; password?: string; user_class: 'Admin' | 'Staff'; is_active: boolean };
