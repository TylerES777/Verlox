import { AuthLoading } from './components/AuthLoading';
import { ConversationScreen } from './components/ConversationScreen';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './contexts/AuthContext';

function AuthGate() {
  const { status } = useAuth();
  if (status === 'hydrating') return <AuthLoading />;
  if (status === 'unauthenticated') return <LoginScreen />;
  return <ConversationScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
