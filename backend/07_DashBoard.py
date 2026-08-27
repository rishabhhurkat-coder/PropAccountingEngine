"""Supabase-backed calculations for the Strategy Report dashboard."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from typing import Any


def _parse_time(value: Any) -> tuple[int, int]:
    text = str(value or '').strip().replace('.', ':')
    try:
        parsed = datetime.strptime(text[:5], '%H:%M')
        return parsed.hour, parsed.minute
    except ValueError:
        return 0, 0


def _money(value: float) -> float:
    return round(float(value or 0), 2)


def _pct(value: float) -> float:
    return round(float(value or 0), 4)


def _bucket(value: float, bounds: list[float], labels: list[str]) -> str:
    for index, bound in enumerate(bounds):
        if value < bound:
            return labels[index]
    return labels[-1]


def _drawdown(values: list[float]) -> float:
    running = 0.0
    peak = 0.0
    worst = 0.0
    for value in values:
        running += value
        peak = max(peak, running)
        worst = min(worst, running - peak)
    return _money(worst)


def _strategy_stats(rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
    pnl_values = [float(row.get('pnl_amount') or 0) for row in rows]
    wins = [value for value in pnl_values if value > 0]
    losses = [value for value in pnl_values if value < 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    return {
        'name': name,
        'pnl': _money(sum(pnl_values)),
        'trades': len(rows),
        'winRate': _pct(len(wins) / len(pnl_values) * 100 if pnl_values else 0),
        'profitFactor': _pct(gross_profit / gross_loss if gross_loss else (gross_profit if gross_profit else 0)),
        'avgWin': _money(sum(wins) / len(wins) if wins else 0),
        'avgLoss': _money(sum(losses) / len(losses) if losses else 0),
        'maxDrawdown': _drawdown([float(row.get('pnl_amount') or 0) for row in sorted(rows, key=lambda item: (item.get('exit_date') or date.min, str(item.get('exit_time') or '')))]),
    }
def build_dashboard(conn: Any, from_date: date | None = None, to_date: date | None = None, instrument: str = 'All Instruments', strategy: str = 'All Strategies') -> dict[str, Any]:
    filters = []
    params: list[Any] = []
    if from_date:
        filters.append('exit_date >= %s')
        params.append(from_date)
    if to_date:
        filters.append('exit_date <= %s')
        params.append(to_date)
    if instrument and instrument != 'All Instruments':
        filters.append('upper(scrip) = upper(%s)')
        params.append(instrument)
    if strategy and strategy != 'All Strategies':
        filters.append('strategy = %s')
        params.append(strategy)
    where = f"WHERE {' AND '.join(filters)}" if filters else ''
    cursor = conn.execute(
        f'''SELECT strategy, scrip, exit_date, exit_time, pnl_amount
            FROM matalia.strategy_closed {where}
            ORDER BY exit_date, exit_time''',
        params,
    )
    columns = [column.name for column in cursor.description]
    rows = [dict(zip(columns, values)) for values in cursor.fetchall()]

    if rows and from_date is None:
        from_date = min(row['exit_date'] for row in rows if row.get('exit_date'))
    if rows and to_date is None:
        to_date = max(row['exit_date'] for row in rows if row.get('exit_date'))

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get('strategy') or 'Unassigned')].append(row)
    stats = [_strategy_stats(group, name) for name, group in grouped.items()]
    stats.sort(key=lambda item: item['pnl'], reverse=True)
    total_pnl = _money(sum(item['pnl'] for item in stats))
    total_trades = len(rows)
    wins = sum(1 for row in rows if float(row.get('pnl_amount') or 0) > 0)
    losses = sum(1 for row in rows if float(row.get('pnl_amount') or 0) < 0)
    gross_profit = sum(float(row.get('pnl_amount') or 0) for row in rows if float(row.get('pnl_amount') or 0) > 0)
    gross_loss = abs(sum(float(row.get('pnl_amount') or 0) for row in rows if float(row.get('pnl_amount') or 0) < 0))

    daily: dict[str, float] = defaultdict(float)
    day_values: dict[str, float] = defaultdict(float)
    time_values: dict[str, float] = defaultdict(float)
    month_values: dict[int, dict[int, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        trade_date = row.get('exit_date')
        pnl = float(row.get('pnl_amount') or 0)
        if not trade_date:
            continue
        daily[trade_date.isoformat()] += pnl
        day_values[trade_date.strftime('%a')] += pnl
        hour, minute = _parse_time(row.get('exit_time'))
        time_values[f'{hour:02d}:{(minute // 30) * 30:02d}'] += pnl
        month_values[trade_date.year][trade_date.month] += pnl
    daily_points = [{'date': key, 'pnl': _money(value)} for key, value in sorted(daily.items())]
    running = 0.0
    for point in daily_points:
        running += point['pnl']
        point['cumulative'] = _money(running)

    contribution_total = sum(abs(item['pnl']) for item in stats) or 1
    contributions = [{**item, 'value': item['pnl'], 'pct': _pct(abs(item['pnl']) / contribution_total * 100)} for item in stats]
    buckets = [('< 0.5', 0, 0.5, '#ef4444'), ('0.5 - 1', 0.5, 1, '#ef4444'), ('1 - 1.5', 1, 1.5, '#f5a900'), ('1.5 - 2', 1.5, 2, '#2dbd83'), ('> 2', 2, float('inf'), '#2dbd83')]
    profit_factor_dist = [{'bucket': label, 'count': sum(1 for item in stats if lower <= item['profitFactor'] < upper), 'color': color} for label, lower, upper, color in buckets]
    years = sorted(month_values)
    heatmap = [{'year': year, 'values': [_money(month_values[year].get(month, 0)) for month in range(1, 13)], 'total': _money(sum(month_values[year].values()))} for year in years]
    day_order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    time_order = sorted(time_values)
    profitable_strategies = sum(1 for item in stats if item['pnl'] > 0)
    return {
        'filters': {'fromDate': from_date.isoformat() if from_date else None, 'toDate': to_date.isoformat() if to_date else None, 'instrument': instrument, 'strategy': strategy},
        'stats': {'totalPnl': total_pnl, 'totalTrades': total_trades, 'winRate': _pct(wins / total_trades * 100 if total_trades else 0), 'profitFactor': _pct(gross_profit / gross_loss if gross_loss else 0), 'avgWin': _money(gross_profit / wins if wins else 0), 'avgLoss': _money(-gross_loss / losses if losses else 0), 'maxDrawdown': _drawdown([point['pnl'] for point in daily_points])},
        'pnlTrend': daily_points,
        'contributions': contributions,
        'strategyRows': stats,
        'profitFactorDist': profit_factor_dist,
        'heatmap': heatmap,
        'dayOfWeek': [{'day': day, 'value': _money(day_values.get(day, 0))} for day in day_order],
        'timeOfDay': [{'time': key, 'value': _money(time_values[key])} for key in time_order],
        'winningLosing': {'profitablePct': _pct(profitable_strategies / len(stats) * 100 if stats else 0), 'profitableCount': profitable_strategies, 'profitableTotalPct': _pct(profitable_strategies / len(stats) * 100 if stats else 0), 'losingCount': len(stats) - profitable_strategies, 'losingTotalPct': _pct((len(stats) - profitable_strategies) / len(stats) * 100 if stats else 0)},
    }
