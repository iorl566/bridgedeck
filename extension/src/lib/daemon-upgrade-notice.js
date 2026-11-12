const NOTIFICATION_ID = 'bb-daemon-upgrade-required';
const NOTIFIED_KEY = 'daemonUpgradeNotifications';

/** Toolbar badge plus one upgrade notice per incompatible peer/session.
 * Platform surfaces are injected; all writes are serialized. */

/**
 * One owner for the shared toolbar badge, plus a notice once per browser
 * session.
 *
 * The badge is derived from the current snapshot on every render: an upgrade
 * issue wins over the recording marker. The notification is shown once per
 * issue key, where the key combines the endpoint identity, the extension
 * version and both protocol versions, so reconnecting to the same incompatible
 * peer does not repeat it while a genuinely different mismatch does.
 *
 * @param {UpgradeNoticeOptions} options  Controller, endpoint key and platform deps.
 * @returns {UpgradeNoticeHandle} Handle that re-renders on demand and detaches on dispose.
 */
export function attachDaemonUpgradeNotice(options) {
  const deps = options.deps;
  let snapshot = options.controller.snapshot();
  let disposed = false;
  /** Last badge signature actually committed to the toolbar. */
  let badge = '';
  /** Set when a previously shown notice should be cleared on the next render. */
  let notificationNeedsClear = false;
  /** Serialized render chain, so the newest state always renders last. */
  let pending = Promise.resolve();
  /** Issue keys already handled by this worker instance. */
  const notified = new Set();

  const currentIssue = () => (snapshot.connectionEnabled ? snapshot.daemonUpgradeRequired : null);
  /**
   * Identity of the current upgrade issue, or null when there is none. Only the
   * public endpoint identity and version numbers participate; never a credential.
   */
  const issueKey = () => {
    const issue = currentIssue();
    return issue ? JSON.stringify([options.connectionKey(), snapshot.extensionVersion, issue.daemonVersion, issue.daemonProtocolVersion, issue.requiredProtocolVersion]) : null;
  };

  /**
   * Render the badge, then the notice. Runs at most once per queued refresh and
   * re-checks disposal and issue identity after every await, because the state
   * can change while a platform call is in flight.
   */
  async function render() {
    if (disposed) return;
    const issue = currentIssue();
    const text = issue ? '!' : options.isRecording() ? 'REC' : '';
    const title = issue ? deps.copy('toolbarTitle') : 'BridgeDeck';
    const signature = JSON.stringify([text, title]);
    if (badge !== signature) {
      await deps.action.setBadgeBackgroundColor({ color: '#dc2626' });
      await deps.action.setBadgeText({ text });
      await deps.action.setTitle({ title });
      badge = signature;
    }
    const key = issueKey();
    if (!key) {
      // A fresh worker has no handshake yet, which is not evidence that the
      // previous upgrade problem is gone; only clear once the state says so.
      if (notificationNeedsClear) {
        await deps.notifications.clear(NOTIFICATION_ID);
        notificationNeedsClear = false;
      }
      return;
    }
    if (notified.has(key)) return;
    // Reserve before the async work so a reconnect cannot produce a notice storm.
    notified.add(key);
    let seen = [];
    try {
      const saved = (await deps.session.get(NOTIFIED_KEY))[NOTIFIED_KEY];
      if (Array.isArray(saved)) seen = saved.filter((value) => typeof value === 'string');
      if (seen.includes(key)) return;
      if (disposed || issueKey() !== key) {
        notified.delete(key);
        return;
      }
      // Keep the most recent 32 keys; anything older cannot recur usefully.
      await deps.session.set({ [NOTIFIED_KEY]: [...seen.slice(-31), key] });
    } catch { /* toolbar remains useful */ }
    if (disposed || issueKey() !== key) return;
    await deps.notifications.create(NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: deps.runtime.getURL('icon/logo.png'),
      title: deps.copy('title'),
      message: deps.copy('notificationMessage'),
      buttons: [{ title: deps.copy('notificationButton') }],
    });
    // The mismatch may have been resolved while the notice was being created.
    if (disposed || issueKey() !== key) await deps.notifications.clear(NOTIFICATION_ID);
  }

  /**
   * Queue a render and return the tail of the chain.
   *
   * @returns {Promise<void>} Resolves after this render settles; never rejects.
   */
  function refresh() {
    pending = pending.then(render).catch(() => {});
    return pending;
  }

  /** Open the popup, falling back to a tab, then close the notice. */
  const showInstructions = (id) => {
    if (id !== NOTIFICATION_ID) return;
    void (async () => {
      try {
        await deps.action.openPopup();
      } catch {
        await deps.tabs.create({ url: deps.runtime.getURL('popup.html') });
      }
      await deps.notifications.clear(NOTIFICATION_ID);
    })();
  };
  const onButtonClicked = (id, index) => {
    if (index === 0) showInstructions(id);
  };
  deps.notifications.onClicked.addListener(showInstructions);
  deps.notifications.onButtonClicked.addListener(onButtonClicked);
  const unsubscribe = options.controller.subscribe((next) => {
    const previouslyRequired = currentIssue();
    snapshot = next;
    // Queue a clear when the problem is gone or the connection settled, so a
    // stale notice cannot outlive the state that caused it.
    if ((previouslyRequired && !currentIssue()) || !snapshot.connectionEnabled || snapshot.state === 'connected' || snapshot.state === 'version_skew') notificationNeedsClear = true;
    refresh();
  });
  deps.i18n?.on?.('languageChanged', refresh);

  return {
    refresh,
    dispose() {
      disposed = true;
      unsubscribe();
      deps.i18n?.off?.('languageChanged', refresh);
      deps.notifications.onClicked.removeListener(showInstructions);
      deps.notifications.onButtonClicked.removeListener(onButtonClicked);
    },
  };
}
