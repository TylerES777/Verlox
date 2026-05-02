import { useEffect } from 'react';

export default function App() {
  useEffect(() => {
    window.api
      .ping()
      .then((reply) => console.log('IPC ping →', reply))
      .catch((err) => console.error('IPC ping failed:', err));
  }, []);

  return (
    <main className="flex h-full w-full items-center justify-center bg-off-white">
      <h1
        className="font-soft text-gray-400"
        style={{
          fontSize: '32px',
          fontWeight: 200,
          letterSpacing: '0.15em',
        }}
      >
        Vorlox
      </h1>
    </main>
  );
}
