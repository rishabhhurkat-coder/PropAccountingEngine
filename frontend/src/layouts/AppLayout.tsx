import { ReactNode, useEffect, useState } from 'react';
import { PipelineSidebar } from '../components/PipelineUI';
import { usePathname } from '../lib/router';
import { API_RECOVERY_ATTEMPT_KEY, API_RECOVERY_EVENT, API_RECOVERY_FAILED_EVENT, preloadWorkspaceData } from '../lib/api';
import { isAdminUser } from '../lib/auth';

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useEffect(() => {
    // Warm shared workspace data once per authenticated app mount so sidebar
    // navigation reuses an in-memory snapshot instead of waiting on a new API
    // calculation for every tab.
    preloadWorkspaceData();
  }, []);
  useEffect(() => {
    let refreshTimer: number | undefined;

    const scheduleRecoveryRefresh = () => {
      if (refreshTimer !== undefined) return;
      let lastAttemptAt = 0;
      try {
        lastAttemptAt = Number(window.sessionStorage.getItem(API_RECOVERY_ATTEMPT_KEY) || 0);
      } catch {
        // Storage can be unavailable in private or restricted browser contexts.
      }
      if (Date.now() - lastAttemptAt < 60_000) return;
      try {
        window.sessionStorage.setItem(API_RECOVERY_ATTEMPT_KEY, String(Date.now()));
      } catch {
        // Storage can be unavailable in private or restricted browser contexts.
      }
      refreshTimer = window.setTimeout(() => window.location.reload(), 5_000);
    };

    const cancelRecoveryRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = undefined;
    };

    window.addEventListener(API_RECOVERY_FAILED_EVENT, scheduleRecoveryRefresh);
    window.addEventListener(API_RECOVERY_EVENT, cancelRecoveryRefresh);
    return () => {
      cancelRecoveryRefresh();
      window.removeEventListener(API_RECOVERY_FAILED_EVENT, scheduleRecoveryRefresh);
      window.removeEventListener(API_RECOVERY_EVENT, cancelRecoveryRefresh);
    };
  }, []);
  // Start compact so the workspace has more room for tables and reports.
  // Users can expand the rail at any time from the H&L logo.
  const [collapsed, setCollapsed] = useState(true);
  const shellClassName = `${pathname === '/trade-book' ? 'app-shell trade-book-page' : 'app-shell'} ${collapsed ? 'sidebar-collapsed' : ''}`;
  return (
    <div className={shellClassName.trim()}>
      <PipelineSidebar collapsed={collapsed} onToggle={() => setCollapsed((current) => !current)} canManageUsers={isAdminUser()} />
      <div className="app-page">{children}</div>
    </div>
  );
}
