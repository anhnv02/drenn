import React from 'react';
import { createRoot } from 'react-dom/client';
import './monacoSetup';
import './theme.css';
import { App } from './App';
import { ConfirmProvider } from './shared/confirm';

const container = document.getElementById('root')!;
createRoot(container).render(
  <React.StrictMode>
    <ConfirmProvider>
      <App />
    </ConfirmProvider>
  </React.StrictMode>,
);
