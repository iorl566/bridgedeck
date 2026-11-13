// src/emulate.js —— 设备/时区/语言/地理仿真（chrome.debugger Emulation 域）
import { bridgeError } from './errors.js';
import { acquire, release, send } from './debugger.js';
import { sleep } from './tabs.js';
import { execPage } from './inject.js';
import { log } from './log.js';

const emulated = new Map(); // tabId -> 仿真前的真实视口快照

function requireTabId(params) {
  if (!params || !Number.isInteger(params.tabId)) {
    throw bridgeError('E_BAD_ARG', '缺少 tabId（由 daemon 注入）');
  }
  return params.tabId;
}

async function trySend(tabId, method, params, errors) {
  try {
    return await send(tabId, method, params);
  } catch (error) {
    const message = String((error && error.message) || error);
    log('CDP ' + method + ' 不支持或失败：' + message);
    if (Array.isArray(errors)) errors.push(method + ': ' + message);
    return null;
  }
}

export async function emulate(params = {}) {
  const tabId = requireTabId(params);

  if (params.reset === true) {
    const errors = [];
    const before = await execPage(tabId, 'page-metrics', {}).catch(() => null);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await trySend(tabId, 'Emulation.clearDeviceMetricsOverride', {}, errors);
      await trySend(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
      }, errors);
      await trySend(tabId, 'Emulation.clearGeolocationOverride', {}, errors);
      await trySend(tabId, 'Network.setUserAgentOverride', { userAgent: '' }, errors);
      await trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }, errors);
      await trySend(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' }, errors);
      await trySend(tabId, 'Emulation.setLocaleOverride', { locale: '' }, errors);
      await sleep(150);
      const probe = await execPage(tabId, 'page-metrics', {}).catch(() => null);
      if (!before || !probe || probe.innerWidth !== before.innerWidth) break;
    }
    let after = await execPage(tabId, 'page-metrics', {}).catch(() => null);
    const snapshot = emulated.get(tabId);
    // Edge 实测：clearDeviceMetricsOverride 返回成功但渲染进程可能卡在仿真尺寸。
    // 这时用仿真前的真实视口再覆盖一次，保证页面回到原始布局。
    if (snapshot && after && before && after.innerWidth === before.innerWidth && after.innerWidth !== snapshot.innerWidth) {
      await trySend(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: snapshot.innerWidth,
        height: snapshot.innerHeight,
        deviceScaleFactor: snapshot.dpr || 1,
        mobile: false,
      }, errors);
      await sleep(150);
      after = await execPage(tabId, 'page-metrics', {}).catch(() => after);
    }
    emulated.delete(tabId);
    await release(tabId, 'emulate').catch(() => {});
    return {
      ok: true,
      reset: true,
      innerWidthBefore: before ? before.innerWidth : null,
      innerWidthAfter: after ? after.innerWidth : null,
      restoredTo: snapshot ? snapshot.innerWidth : null,
      errors,
    };
  }

  await acquire(tabId, 'emulate');
  if (!emulated.has(tabId)) {
    const snapshot = await execPage(tabId, 'page-metrics', {}).catch(() => null);
    if (snapshot) {
      emulated.set(tabId, {
        innerWidth: snapshot.innerWidth,
        innerHeight: snapshot.innerHeight,
        dpr: snapshot.dpr || 1,
      });
    }
  }
  const applied = {};

  if (params.viewport && typeof params.viewport === 'object') {
    const width = Number(params.viewport.width);
    const height = Number(params.viewport.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw bridgeError('E_BAD_ARG', 'viewport 需要正的 width/height');
    }
    const scale = Number(params.viewport.deviceScaleFactor);
    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 1,
      mobile: params.viewport.mobile === true,
    });
    applied.viewport = { width: Math.round(width), height: Math.round(height) };
  }

  if (typeof params.userAgent === 'string' && params.userAgent) {
    await trySend(tabId, 'Network.setUserAgentOverride', {
      userAgent: params.userAgent,
      acceptLanguage: typeof params.acceptLanguage === 'string' && params.acceptLanguage ? params.acceptLanguage : undefined,
      platform: typeof params.platform === 'string' && params.platform ? params.platform : undefined,
    });
    applied.userAgent = params.userAgent;
    if (params.acceptLanguage) applied.acceptLanguage = params.acceptLanguage;
  } else if (typeof params.acceptLanguage === 'string' && params.acceptLanguage) {
    await trySend(tabId, 'Network.setUserAgentOverride', { userAgent: '', acceptLanguage: params.acceptLanguage });
    applied.acceptLanguage = params.acceptLanguage;
  }

  if (params.touch === true) {
    await trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    applied.touch = true;
  } else if (params.touch === false) {
    await trySend(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    applied.touch = false;
  }

  if (typeof params.timezone === 'string' && params.timezone) {
    await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: params.timezone });
    applied.timezone = params.timezone;
  }

  if (typeof params.locale === 'string' && params.locale) {
    await trySend(tabId, 'Emulation.setLocaleOverride', { locale: params.locale });
    applied.locale = params.locale;
  }

  if (params.geolocation === null) {
    await trySend(tabId, 'Emulation.clearGeolocationOverride', {});
    applied.geolocation = null;
  } else if (params.geolocation && typeof params.geolocation === 'object') {
    const latitude = Number(params.geolocation.latitude);
    const longitude = Number(params.geolocation.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw bridgeError('E_BAD_ARG', 'geolocation 需要 latitude/longitude');
    }
    const accuracy = Number(params.geolocation.accuracy);
    await send(tabId, 'Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 1,
    });
    applied.geolocation = { latitude, longitude };
  }

  return { ok: true, applied };
}

export function forgetEmulateTab(tabId) {
  emulated.delete(tabId);
  release(tabId, 'emulate').catch(() => {});
}
