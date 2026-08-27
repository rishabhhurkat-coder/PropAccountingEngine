import { useState } from 'react'
import { ArrowRight, BarChart3, Code2, FileText, Mail, Menu, Smartphone, X } from 'lucide-react'
import brandLogo from '../assets/hnl-brand-lockup-hd.png'

const navItems = [
  ['Home', 'https://hnlsoftware.in/'],
  ['Products', 'https://hnlsoftware.in/products'],
  ['Connections', 'https://hnlsoftware.in/connections'],
  ['Pricing', 'https://hnlsoftware.in/pricing'],
  ['About Us', 'https://hnlsoftware.in/about'],
  ['Contact', 'https://hnlsoftware.in/contact'],
] as const

const productItems = [
  ['Email Automation', 'Verification workflows', Mail, 'https://hnlsoftware.in/email-automation/'],
  ['Prop Trading Engine', 'Trade accounting workspace', BarChart3, 'https://hnlsoftware.in/prop-trading-engine/'],
  ['Billing Software', 'Invoices and payments', FileText, 'https://hnlsoftware.in/contact'],
  ['Mobile App', 'Operations on the go', Smartphone, 'https://hnlsoftware.in/contact'],
  ['Custom Software', 'Built around your workflow', Code2, 'https://hnlsoftware.in/contact'],
] as const

export function LoginSiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [productMenuOpen, setProductMenuOpen] = useState(false)
  const closeMenus = () => { setMenuOpen(false); setProductMenuOpen(false) }

  return <header className="login-page-header">
    <div className="login-header-container">
      <a className="login-header-brand" href="https://hnlsoftware.in/" aria-label="H&L Software home" onClick={closeMenus}>
        <img src={brandLogo} alt="H&L Software" />
      </a>
      <nav className={`login-header-nav${menuOpen ? ' open' : ''}`} aria-label="Primary navigation">
        <a className="is-active" href={navItems[0][1]} onClick={closeMenus}>{navItems[0][0]}</a>
        <div className={`login-header-product-wrap${productMenuOpen ? ' open' : ''}`} onMouseEnter={() => setProductMenuOpen(true)} onMouseLeave={() => setProductMenuOpen(false)} onFocus={() => setProductMenuOpen(true)}>
          <a href={navItems[1][1]} aria-haspopup="true" aria-expanded={productMenuOpen} onClick={(event) => {
            if (window.matchMedia('(max-width: 920px)').matches) {
              event.preventDefault()
              setProductMenuOpen((current) => !current)
            } else {
              closeMenus()
            }
          }}>{navItems[1][0]}</a>
          <div className="login-header-product-menu" role="menu" aria-label="Products">
            {productItems.map(([label, description, Icon, href]) => <a key={label} href={href} role="menuitem" onClick={closeMenus}>
              <span className="login-header-product-icon"><Icon size={16} aria-hidden="true" /></span>
              <span><strong>{label}</strong><small>{description}</small></span>
              <ArrowRight className="login-header-product-arrow" size={15} aria-hidden="true" />
            </a>)}
          </div>
        </div>
        {navItems.slice(2).map(([label, href]) => <a key={label} href={href} onClick={closeMenus}>{label}</a>)}
      </nav>
      <div className="login-header-actions">
        <a className="login-header-cta" href="https://hnlsoftware.in/contact" onClick={closeMenus}>Get Started <ArrowRight size={19} /></a>
        <button className="login-header-menu-toggle" type="button" onClick={() => setMenuOpen((current) => !current)} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen}>
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
    </div>
  </header>
}
