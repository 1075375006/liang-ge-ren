import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class AppBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="loading-screen">
        <h1>页面暂时没有打开</h1>
        <p>你的记录仍保存在空间里，请重新打开。</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          重新打开
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </React.StrictMode>,
);
