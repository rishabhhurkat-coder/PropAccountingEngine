import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Database, FileInput, GitBranch, LineChart, LockKeyhole, ShieldCheck, Workflow, Zap } from 'lucide-react'
import brandLogo from './assets/hnl-brand-lockup-hd.png'
import './product-guide.css'

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
const loginHref = `${basePath}/`

const flowSteps = [
  { number: '01', label: 'Import', detail: 'Upload broker TXT or report files and review validation results.', code: '01_Txt_DB.py', icon: FileInput },
  { number: '02', label: 'Normalise', detail: 'Convert source executions into a consistent accounting shape.', code: '00_Txtconverter.py', icon: Workflow },
  { number: '03', label: 'Merge & split', detail: 'Build logical trades and split quantities when ownership changes.', code: '03_MergeTrades.py', icon: GitBranch },
  { number: '04', label: 'Allocate', detail: 'Assign strategy ownership with an auditable allocation workflow.', code: '05_Strategy_Allocation.py', icon: Database },
  { number: '05', label: 'Reconcile', detail: 'Refresh prices, positions, charges and market context.', code: '10_LivePositions.py', icon: Zap },
  { number: '06', label: 'Report', detail: 'Turn the ledger into trade books, P&L and decision-ready reports.', code: '08_Matalia_Reports.py', icon: LineChart },
] as const

const productAreas = [
  ['Raw Trade Import', 'Upload source files, monitor the pipeline and review validation results.'],
  ['Instrument Allocation', 'Merge executions, split quantities and confirm strategy ownership.'],
  ['Strategy Master', 'Maintain reusable strategy, account and expiry configuration.'],
  ['Trade Book', 'Browse open and closed trades with filters, pagination and CMP updates.'],
  ['Positions', 'Review open positions and refresh current market prices through Zerodha.'],
  ['Strategy Report', 'Inspect P&L, contribution, win/loss, timing and distribution analytics.'],
] as const

const usageSteps = [
  'Sign in with your H&L Software workspace credentials.',
  'Import the latest broker trade file from Raw Trade Import.',
  'Review normalisation results and resolve any validation issues.',
  'Allocate trades to the correct strategy and account ownership.',
  'Use Trade Book and Positions to inspect the live workspace.',
  'Finish with Strategy Report and Matalia Charges for review.',
]

export function ProductGuide() {
  return <main className="product-guide-page">
    <header className="product-guide-header">
      <a className="product-guide-brand" href="https://hnlsoftware.in/" aria-label="H&L Software home"><img src={brandLogo} alt="H&L Software" /></a>
      <a className="product-guide-back" href={loginHref}><ArrowLeft size={16} /> Back to sign in</a>
    </header>

    <section className="product-guide-hero">
      <div className="product-guide-orb product-guide-orb-blue" />
      <div className="product-guide-orb product-guide-orb-purple" />
      <div className="product-guide-hero-inner">
        <p className="product-guide-pill"><span /> PROP TRADING ENGINE</p>
        <h1>From raw execution to <em>decision-ready</em> reporting.</h1>
        <p className="product-guide-lead">A shared workspace for trade accounting, positions, allocations and live market context — designed to keep every decision traceable.</p>
        <div className="product-guide-hero-actions">
          <a className="product-guide-primary" href={loginHref}>Open the workspace <ArrowRight size={17} /></a>
          <a className="product-guide-secondary" href="#workflow">See the workflow <ArrowRight size={16} /></a>
        </div>
      </div>
    </section>

    <section className="product-guide-section product-guide-flow" id="workflow">
      <div className="product-guide-section-heading">
        <p className="product-guide-kicker"><span /> HOW IT WORKS</p>
        <h2>One connected flow from file to insight.</h2>
        <p>The engine keeps execution detail, position lineage, strategy ownership and reporting connected across every stage.</p>
      </div>
      <div className="product-guide-flow-grid">
        {flowSteps.map((step) => { const Icon = step.icon; return <article className="product-guide-flow-card" key={step.number}>
          <div className="product-guide-flow-top"><span>{step.number}</span><Icon size={20} /></div>
          <h3>{step.label}</h3>
          <p>{step.detail}</p>
          <code>{step.code}</code>
        </article> })}
      </div>
    </section>

    <section className="product-guide-section product-guide-areas">
      <div className="product-guide-section-heading">
        <p className="product-guide-kicker"><span /> PRODUCT AREAS</p>
        <h2>Everything your trading workspace needs.</h2>
      </div>
      <div className="product-guide-areas-grid">
        {productAreas.map(([title, description]) => <article className="product-guide-area-card" key={title}><CheckCircle2 size={18} /><div><h3>{title}</h3><p>{description}</p></div></article>)}
      </div>
    </section>

    <section className="product-guide-section product-guide-usage">
      <div className="product-guide-usage-panel">
        <div className="product-guide-usage-copy">
          <p className="product-guide-kicker"><span /> QUICK START</p>
          <h2>A practical rhythm for every trading day.</h2>
          <p>Use the workspace in this order to keep imports clean, ownership clear and reports ready for review.</p>
        </div>
        <ol className="product-guide-usage-list">
          {usageSteps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span>{step}</li>)}
        </ol>
      </div>
    </section>

    <section className="product-guide-section product-guide-foundation">
      <div className="product-guide-section-heading">
        <p className="product-guide-kicker"><span /> BUILT FOR CONTROL</p>
        <h2>Private, auditable and connected.</h2>
        <p>The frontend talks to the secure H&amp;L service while data and integrations stay behind the application boundary.</p>
      </div>
      <div className="product-guide-foundation-grid">
        <article><ShieldCheck size={21} /><h3>Secure access</h3><p>Short-lived workspace sessions protect the operational console.</p></article>
        <article><LockKeyhole size={21} /><h3>Credentials stay private</h3><p>Broker, database and storage settings remain in the backend environment.</p></article>
        <article><BookOpen size={21} /><h3>Clear ownership</h3><p>Every stage is visible so teams can understand how a number was produced.</p></article>
      </div>
    </section>

    <footer className="product-guide-footer">
      <div><strong>Ready to work with the data?</strong><span>Open the Prop Trading Engine workspace.</span></div>
      <a className="product-guide-primary" href={loginHref}>Sign in <ArrowRight size={17} /></a>
    </footer>
  </main>
}
