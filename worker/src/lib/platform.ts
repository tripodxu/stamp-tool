/**
 * 运行环境判定。
 *
 * 导出路径要按环境分叉，但**不能只看 UA 里的 Mobile**：
 *  · 微信内置浏览器（iOS WKWebView / Android X5）基本不支持 Web Share 文件分享，
 *    而且会拦截普通下载；
 *  · iPadOS 13+ 的 UA 伪装成 Macintosh，必须结合 maxTouchPoints 判断。
 *
 * 拆成纯函数，方便单测；运行时再读 navigator。
 */

export interface PlatformInfo {
  mobile: boolean;
  wechat: boolean;
  ios: boolean;
  android: boolean;
}

export function platformFromUA(ua: string, maxTouchPoints = 0): PlatformInfo {
  const iphoneLike = /iPhone|iPad|iPod/i.test(ua);
  const ipadDesktopUA = /Macintosh/i.test(ua) && maxTouchPoints > 1;
  const ios = iphoneLike || ipadDesktopUA;
  const android = /Android/i.test(ua);
  const mobile = ios || android || /Mobile|Windows Phone|BlackBerry/i.test(ua);
  const wechat = /MicroMessenger/i.test(ua);
  return { mobile, wechat, ios, android };
}

export function getPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') {
    return { mobile: false, wechat: false, ios: false, android: false };
  }
  return platformFromUA(navigator.userAgent, navigator.maxTouchPoints || 0);
}

export const isMobileBrowser = (): boolean => getPlatform().mobile;
export const isWeChatBrowser = (): boolean => getPlatform().wechat;
