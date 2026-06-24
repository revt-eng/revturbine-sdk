import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrismApp } from './PrismApp';
import './styles/playground.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Prism playground root element not found');
}

createRoot(root).render(
  <StrictMode>
    <PrismApp />
  </StrictMode>,
);
