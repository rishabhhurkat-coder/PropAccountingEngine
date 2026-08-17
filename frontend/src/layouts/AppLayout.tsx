import { ReactNode, useState } from 'react';
import { PipelineSidebar } from '../components/PipelineUI';
import { usePathname } from '../lib/router';

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const shellClassName = `${pathname === '/trade-book' ? 'app-shell trade-book-page' : 'app-shell'} ${collapsed ? 'sidebar-collapsed' : ''}`;
  return (
    <div className={shellClassName.trim()}>
      <PipelineSidebar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} />
      <div className="app-page">{children}</div>
    </div>
  );
}
