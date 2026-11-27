// cli/commands/emulate.mjs —— `bridge emulate`（设备/视口/UA/时区/定位）与设备预设。
const DEVICE_PRESETS = {
  'iphone-14': { width: 390, height: 844, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-14-pro-max': { width: 430, height: 932, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-se': { width: 375, height: 667, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1' },
  'pixel-7': { width: 412, height: 915, dpr: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'galaxy-s23': { width: 360, height: 780, dpr: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'ipad-mini': { width: 768, height: 1024, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'galaxy-tab-s8': { width: 800, height: 1280, dpr: 2, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
};

export { DEVICE_PRESETS };

export function createEmulateCommand({
  withControl,
  callRpc,
  timeoutOf,
  renderPageBody,
  print,
  intFlag,
  ArgError,
}) {
  return async function cmdEmulate(flags) {
    const params = {};
    const preset = flags.device !== undefined ? DEVICE_PRESETS[String(flags.device)] : null;
    if (flags.device !== undefined && !preset) throw new ArgError('未知 --device：' + flags.device);
    const width = intFlag(flags, 'width', { min: 1 }) !== undefined ? intFlag(flags, 'width', { min: 1 }) : (preset ? preset.width : undefined);
    const height = intFlag(flags, 'height', { min: 1 }) !== undefined ? intFlag(flags, 'height', { min: 1 }) : (preset ? preset.height : undefined);
    if (width !== undefined || height !== undefined) {
      if (width === undefined || height === undefined) throw new ArgError('--width 与 --height 需要同时给');
      params.viewport = { width, height };
      const dprValue = flags.dpr !== undefined ? Number(flags.dpr) : (preset ? preset.dpr : NaN);
      if (Number.isFinite(dprValue) && dprValue > 0) params.viewport.deviceScaleFactor = dprValue;
      if (flags.mobile === true || (preset && preset.mobile)) params.viewport.mobile = true;
    }
    const ua = flags.ua !== undefined ? String(flags.ua) : (preset ? preset.ua : '');
    if (ua) params.userAgent = ua;
    if (flags['accept-language'] !== undefined) params.acceptLanguage = String(flags['accept-language']);
    if (flags.touch === true) params.touch = true;
    if (flags['no-touch'] === true) params.touch = false;
    if (flags.timezone !== undefined) params.timezone = String(flags.timezone);
    if (flags.locale !== undefined) params.locale = String(flags.locale);
    if (flags.geolocation !== undefined) {
      const parts = String(flags.geolocation).split(',').map((item) => Number(item.trim()));
      if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new ArgError('--geolocation 需要 "<lat>,<lon>"');
      }
      params.geolocation = { latitude: parts[0], longitude: parts[1] };
    }
    if (flags.reset === true) params.reset = true;
    if (!Object.keys(params).length) throw new ArgError('emulate 至少给一个参数（--width/--timezone/--geolocation/--reset 等）');
    const body = await callRpc('emulate', withControl(flags, params), timeoutOf(flags));
    return renderPageBody(body, () => print('ok'));
  };
}
