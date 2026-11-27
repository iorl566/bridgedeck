import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('popup 缺少 #root 挂载点');
createRoot(container).render(<App />);
