import { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, BarChart3, Check, CheckCircle2, ChevronDown, CircleHelp, Database, FileChartColumn, FileText, History, MoreHorizontal, ReceiptIndianRupee, RotateCcw, Settings, ShieldCheck, SlidersHorizontal, Star, Table2, Trash2, Upload, UserRound, Users, WalletCards, Zap } from 'lucide-react';
import { NavLink } from '../lib/router';
import { ImportedFile, Stage } from '../types';
import hlLogo from '../assets/hl-logo.png';

export function SectionHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="section-header"><div>{eyebrow && <div className="section-eyebrow">{eyebrow}</div>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}

export function PrimaryButton({ children, onClick, disabled = false, icon, compact = false, ariaLabel }: { children: ReactNode; onClick?: () => void; disabled?: boolean; icon?: ReactNode; compact?: boolean; ariaLabel?: string }) {
  const label = typeof children === 'string' ? children : undefined;
  const resolvedLabel = disabled && label === 'Run Import Pipeline' ? 'Running Import Pipeline...' : children;
  const accessibleLabel = ariaLabel ?? label;
  return (
    <button className={`btn primary${compact ? ' icon-only' : ''}`} onClick={onClick} disabled={disabled} aria-label={accessibleLabel}>
      {icon}
      {!compact && resolvedLabel}
    </button>
  );
}
export function SecondaryButton({ children, onClick, icon }: { children: ReactNode; onClick?: () => void; icon?: ReactNode }) { return <button className="btn secondary" onClick={onClick}>{icon}{children}</button>; }

const pipelineLinks = [
  ['Strategy Allocation', BarChart3, '/strategy-allocation'],
  ['Trade Book', ShieldCheck, '/trade-book'],
  ['Positions', CircleHelp, '/positions'],
] as const;

const hiddenPipelineLinks = [
  ['Raw Trade Import', FileText, '/raw-trade-import'],
] as const;

const sidebarGroups = [
  ['TRADING', [['Strategies', Activity, '/strategies']]],
  ['REPORTS', [['Profit and Loss Report', FileChartColumn], ['Strategy Report', BarChart3, '/strategy-report'], ['Matalia Reports', ReceiptIndianRupee, '/matalia-reports']]],
] as const;

export function PipelineSidebar({
  collapsed = false,
  onToggle,
}: {
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <aside className="alloc-sidebar">
      <div className="alloc-hl-brand" aria-label="H&L Software">
        <img className="alloc-hl-logo" src={hlLogo} alt="H&L Software" />
      </div>
      <div className="alloc-brand">
        <button className="alloc-brand-mark alloc-brand-toggle" type="button" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          M
        </button>
        <div className="alloc-brand-copy">
          <strong>Matalia SL</strong>
          <small>Trade Accounting OS</small>
        </div>
      </div>
      <div className="alloc-nav-section">
        <div className="alloc-nav-label">PIPELINE</div>
        {pipelineLinks.map(([label, Icon, to]) => (
          <NavLink key={label} to={to} end className={({ isActive }) => `alloc-nav-item ${isActive ? 'active' : ''}`}>
            <span className="alloc-nav-icon">
              <Icon size={16} />
            </span>
            <span className="alloc-nav-text">{label}</span>
          </NavLink>
        ))}
      </div>
      {sidebarGroups.map(([title, items]) => (
        <div className="alloc-nav-section" key={title}>
          <div className="alloc-nav-label">{title}</div>
          {items.map(([label, Icon, to]) => to ? (
            <NavLink key={label} to={to} end className={({ isActive }) => `alloc-nav-item ${isActive ? 'active' : ''}`}>
              <span className="alloc-nav-icon"><Icon size={16} /></span><span className="alloc-nav-text">{label}</span>
            </NavLink>
          ) : (
            <button key={label} className="alloc-nav-item" type="button">
              <span className="alloc-nav-icon">
                <Icon size={16} />
              </span>
              <span className="alloc-nav-text">{label}</span>
            </button>
          ))}
        </div>
      ))}
      <div className="alloc-nav-section">
        <div className="alloc-nav-label">HIDDEN</div>
        {hiddenPipelineLinks.map(([label, Icon, to]) => (
          <NavLink key={label} to={to} end className={({ isActive }) => `alloc-nav-item ${isActive ? 'active' : ''}`}>
            <span className="alloc-nav-icon"><Icon size={16} /></span>
            <span className="alloc-nav-text">{label}</span>
          </NavLink>
        ))}
      </div>
      <div className="alloc-status">
        <div className="status-dot">●</div>
        <strong>System Status</strong>
        <span>All systems operational</span>
        <span>Last sync: 09:45:31 AM</span>
        <hr />
        <button type="button">View Logs</button>
      </div>
    </aside>
  );
}

export function WorkflowTimeline({ stage, actions, onSelectFile }: { stage: Stage; actions?: ReactNode; onSelectFile?: () => void }) {
  const items = [{ label: 'Import Files', icon: Upload }, { label: 'Convert Database', icon: Database }, { label: 'Build Raw Trades', icon: Table2 }, { label: 'Validation', icon: ShieldCheck }, { label: 'Ready', icon: CheckCircle2 }];
  const currentIndex = stage === 'files' ? 0 : stage === 'convert' ? 1 : stage === 'table' ? 2 : stage === 'ready' ? items.length : 4;
  return <div className="workflow-hero reference-stepper"><div className="workflow-card-head">{actions}</div><div className="workflow-stepper">{items.map((item, index) => { const complete = index < currentIndex; const current = index === currentIndex; const Icon = item.icon; return <div className="stepper-segment" key={item.label}><div className={`stepper-step ${complete ? 'complete' : current ? 'current' : 'pending'} ${index === items.length - 1 ? 'final-step' : ''}`}><div className="stepper-top"><div className="stepper-icon">{index === 0 && onSelectFile ? <button type="button" className="stepper-file-picker" onClick={onSelectFile} aria-label="Select TXT file" title="Select TXT file"><Icon size={20} /></button> : <Icon size={20} />}</div><div className="stepper-text"><strong><span>{index + 1}</span> {item.label}</strong></div></div>{complete && <div className="stepper-check"><Check size={11} /></div>}{current && index < items.length - 1 && <div className="stepper-active-line" />}</div>{index < items.length - 1 && <div className={`stepper-connector ${complete ? 'complete' : ''}`} />}</div>; })}</div></div>;
}

export function MetricCard({ label, value, note, tone = 'neutral', icon }: { label: string; value: string | number; note?: string; tone?: 'neutral' | 'blue' | 'green' | 'rose' | 'violet'; icon?: ReactNode }) { return <motion.div className={`metric-card ${tone}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .35 }}><div className="metric-top"><span>{label}</span>{icon && <span className="metric-icon">{icon}</span>}</div><strong>{value}</strong>{note && <small>{note}</small>}</motion.div>; }

export function ImportFileCard({ file, selected, onSelect, onReload, onDelete }: { file: ImportedFile; selected: boolean; onSelect: () => void; onReload?: () => void; onDelete?: () => void }) { return <motion.div layout className={`import-file-card ${selected ? 'selected' : ''}`} onClick={onSelect}><div className="broker-logo">{file.broker.slice(0, 1)}</div><div className="import-file-main"><div className="import-file-title"><strong>{file.name}</strong><span className="status-badge"><Check size={11} /> Ready</span></div><div className="import-file-meta"><span>{file.tradeDate}</span><span>{file.records.toLocaleString('en-IN')} records</span></div><small>Imported {file.importedAt}</small></div><button className="more-button" aria-label="File actions" onClick={(event) => { event.stopPropagation(); onReload?.(); }}><MoreHorizontal size={16} /></button><div className="file-hover-actions"><button onClick={(event) => { event.stopPropagation(); onSelect(); }}>Open</button><button onClick={(event) => { event.stopPropagation(); onReload?.(); }}><RotateCcw size={12} /> Reload</button><button className="danger" onClick={(event) => { event.stopPropagation(); onDelete?.(); }}><Trash2 size={12} /> Delete</button></div></motion.div>; }

export function QualityCard({ quality, issues, expanded, onToggle }: { quality: number; issues: { label: string; count: number; tone: 'good' | 'warning' }[]; expanded: string | null; onToggle: (label: string) => void }) { return <div className="quality-card"><div className="quality-top"><div><div className="section-eyebrow">DATA QUALITY</div><h2>Import health</h2><p>Every record has been checked.</p></div><div className="quality-score"><strong>{quality}%</strong><span>Excellent</span></div></div><div className="quality-progress"><motion.span initial={{ width: 0 }} animate={{ width: `${quality}%` }} transition={{ duration: .9 }} /></div><div className="quality-list">{issues.map((issue) => <div className="quality-row" key={issue.label}><button onClick={() => onToggle(issue.label)}><span className={`quality-mark ${issue.tone}`}><Check size={12} /></span><span>{issue.label}</span><strong className={issue.tone}>{issue.count === 0 ? 'Clear' : issue.count}</strong><ChevronDown size={14} /></button><AnimatePresence>{expanded === issue.label && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="quality-detail">{issue.count === 0 ? 'No affected trades found.' : 'Affected trades will appear here for review.'}</motion.div>}</AnimatePresence></div>)}</div></div>; }

export function SummaryPanel({ title, items }: { title: string; items: { label: string; value: string | number; note?: string; tone?: 'neutral' | 'blue' | 'green' | 'rose' | 'violet' }[] }) { const referenceItems = title === "Today's Import" ? [...items, { label: 'Unique Instruments', value: 128, tone: 'blue' as const }, { label: 'Unique Clients', value: 24, tone: 'violet' as const }, { label: 'Earliest Trade', value: '09:12:01 AM', note: '03 Aug 2026', tone: 'blue' as const }, { label: 'Latest Trade', value: '03:29:45 PM', note: '03 Aug 2026', tone: 'blue' as const }, { label: 'Processing Speed', value: '2,842/min', tone: 'green' as const }] : items; return <div className="summary-block"><SectionHeader title={title === "Today's Import" ? 'Import Summary' : title} /><div className="summary-block-grid">{referenceItems.map((item) => <MetricCard key={item.label} label={item.label} value={item.value} note={item.note} tone={item.tone} />)}</div></div>; }

export function StickyActionBar({ status, ready, onReimport, onProceed }: { status: string; ready: boolean; onReimport: () => void; onProceed: () => void }) { return <footer className="action-bar"><div className="action-status"><span className={`action-status-dot ${ready ? 'ready' : ''}`} /><div><small>Pipeline Status</small><strong>{status}</strong></div></div><div className="action-right"><SecondaryButton onClick={onReimport} icon={<RotateCcw size={15} />}>Re-import</SecondaryButton><PrimaryButton onClick={onProceed} disabled={!ready} icon={<span>→</span>}>Proceed to Merge</PrimaryButton></div></footer>; }
