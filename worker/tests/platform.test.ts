import { describe, expect, it } from 'vitest';
import { platformFromUA } from '../src/lib/platform';

const IPHONE_WECHAT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c2f) NetType/WIFI Language/zh_CN';
const ANDROID_WECHAT =
  'Mozilla/5.0 (Linux; Android 13; 2211133C Build/TKQ1.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.44.2460(0x28002C3D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

describe('platformFromUA', () => {
  it('识别 iPhone 微信：移动端 + 微信', () => {
    expect(platformFromUA(IPHONE_WECHAT)).toMatchObject({
      mobile: true,
      wechat: true,
      ios: true,
      android: false,
    });
  });

  it('识别 Android 微信：移动端 + 微信', () => {
    expect(platformFromUA(ANDROID_WECHAT)).toMatchObject({
      mobile: true,
      wechat: true,
      ios: false,
      android: true,
    });
  });

  it('桌面 Chrome 不走移动端导出分支', () => {
    expect(platformFromUA(DESKTOP_CHROME)).toMatchObject({
      mobile: false,
      wechat: false,
      ios: false,
      android: false,
    });
  });

  it('iPadOS 的 Macintosh UA 靠 maxTouchPoints 识别为移动端', () => {
    expect(platformFromUA(IPAD_DESKTOP_UA, 5)).toMatchObject({
      mobile: true,
      wechat: false,
      ios: true,
    });
    expect(platformFromUA(IPAD_DESKTOP_UA, 0).mobile).toBe(false);
  });
});
