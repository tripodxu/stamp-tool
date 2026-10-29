import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 拖放只该落在 .viewport 里（App.onDrop）。文件拖到工具栏、侧栏或弹层上时
// 若不拦掉默认行为，浏览器会直接打开该文件替换整个页面——盖了半天的章全丢。
// 这里只阻止默认，不处理数据：viewport 自己的 dragover/drop 照常生效。
for (const t of ['dragover', 'drop'] as const) {
  window.addEventListener(t, (e) => e.preventDefault())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
