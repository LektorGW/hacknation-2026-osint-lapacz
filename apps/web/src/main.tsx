import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
// Warstwa wyglądu i podpowiedzi — po styles.css, aby nadpisywać wyłącznie wygląd.
import './ux.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
