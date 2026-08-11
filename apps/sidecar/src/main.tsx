import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TreeDiagramApp } from '@treediagram/ui-core';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TreeDiagramApp />
  </StrictMode>,
);
