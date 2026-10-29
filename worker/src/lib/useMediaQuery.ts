import { useEffect, useState } from 'react';

/**
 * 响应式断点（SSR 安全无关紧要，本应用恒在浏览器里跑）。
 *
 * 只服务一个用途：App 用它决定渲染桌面布局还是手机布局。
 * 刻意用 JS 分叉而不是纯 CSS 媒体查询——手机布局是「顶栏+底部栏+抽屉」
 * 的结构变化，不是同一棵 DOM 换个摆法；纯 CSS 做不了跨容器搬运。
 */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange(); // 挂载时同步一次，防初始 state 与当前环境不符
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}
