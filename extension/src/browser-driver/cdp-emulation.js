// src/browser-driver/cdp-emulation.js —— Emulation 域覆盖（ChromiumCdp mixin）。

export class CdpEmulationMethods {
  /**
   * `Emulation.setDeviceMetricsOverride` — pin the tab's viewport metrics.
   * @param {number} tabId
   * @param {DeviceMetricsOverride} metrics
   * @returns {Promise<void>}
   */
  setDeviceMetricsOverride(tabId, metrics) {
    return this.send(tabId, 'Emulation.setDeviceMetricsOverride', { ...metrics });
  }
  /**
   * `Emulation.clearDeviceMetricsOverride` — restore native viewport metrics.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  clearDeviceMetricsOverride(tabId) {
    return this.send(tabId, 'Emulation.clearDeviceMetricsOverride', {});
  }
  /**
   * `Emulation.setUserAgentOverride` — an empty `userAgent` restores the real one.
   * @param {number} tabId
   * @param {UserAgentOverride} override
   * @returns {Promise<void>}
   */
  setUserAgentOverride(tabId, override) {
    return this.send(tabId, 'Emulation.setUserAgentOverride', { ...override });
  }
  /**
   * `Emulation.setTouchEmulationEnabled`.
   * @param {number} tabId
   * @param {boolean} enabled
   * @param {number} [maxTouchPoints]
   * @returns {Promise<void>}
   */
  setTouchEmulationEnabled(tabId, enabled, maxTouchPoints) {
    return this.send(tabId, 'Emulation.setTouchEmulationEnabled', {
      enabled,
      ...(maxTouchPoints !== undefined ? { maxTouchPoints } : {}),
    });
  }
}
