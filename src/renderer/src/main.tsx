import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Mark dev builds in the window title (and therefore the OS taskbar) so
// a dev instance is never mistaken for the production one. Prod stays a
// plain "Verlox". import.meta.env.DEV is the same switch that picks the
// backend URL, so the label always matches the environment it talks to.
document.title = import.meta.env.DEV ? 'Verlox — Dev' : 'Verlox';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
