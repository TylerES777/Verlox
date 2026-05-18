import { AuthLoading } from './components/AuthLoading';
import { ConversationsShell } from './components/ConversationsShell';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './contexts/AuthContext';

function AuthGate() {
  const { status } = useAuth();
  if (status === 'hydrating') return <AuthLoading />;
  if (status === 'unauthenticated') return <LoginScreen />;
  return <ConversationsShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
