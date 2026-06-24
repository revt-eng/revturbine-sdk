import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SdkLocalHarnessApp } from './SdkLocalHarnessApp';
import './harness.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('SDK harness root element not found');
}

createRoot(root).render(
  <StrictMode>
    <SdkLocalHarnessApp />
  </StrictMode>,
);
