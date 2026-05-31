import { AuthLoading } from './components/AuthLoading';
import { ConversationsShell } from './components/ConversationsShell';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TierProvider } from './contexts/TierContext';
import { UpgradeProvider } from './contexts/UpgradeContext';
import { UsageProvider } from './contexts/UsageContext';

function AuthGate() {
  const { status } = useAuth();
  if (status === 'hydrating') return <AuthLoading />;
  if (status === 'unauthenticated') return <LoginScreen />;
  // TierProvider fetches the tier (needs a session); UpgradeProvider
  // renders the plan-page modal and is opened by locked Pro features.
  return (
    <TierProvider>
      <UpgradeProvider>
        <UsageProvider>
          <ConversationsShell />
        </UsageProvider>
      </UpgradeProvider>
    </TierProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
