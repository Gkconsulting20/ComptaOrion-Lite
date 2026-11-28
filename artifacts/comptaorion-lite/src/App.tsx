import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
// The imported JavaScript UI is bundled by Vite and remains the source of truth.
// @ts-expect-error Legacy JSX source has no standalone TypeScript declaration.
import LiteApp from '@/LiteApp.jsx';
// @ts-expect-error Legacy JSX source has no standalone TypeScript declaration.
import { ResetPassword } from '@/pages/ResetPassword.jsx';
// @ts-expect-error Legacy JSX source has no standalone TypeScript declaration.
import CommercialPortal from '@/CommercialPortal.jsx';
import UserGuide from '@/UserGuide.jsx';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/guide" component={UserGuide} />
        <Route path="/reset-password" component={ResetPassword} />
        <Route path="/" component={LiteApp} />
        <Route path="/lite" component={LiteApp} />
        <Route path="/commercial" component={CommercialPortal} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
