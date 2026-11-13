/**
 * Wire protocol for the popup port: the background pushes snapshot messages
 * and the popup sends preference updates.
 *
 * The popup connects with a port named {@link POPUP_PORT_NAME}. Only the
 * background sends snapshots; only the popup sends outbound preference
 * messages. The daemon port preference is persisted through storage rather
 * than this bridge, while the label and the connection switch travel here.
 *
 * @typedef {object} PopupSnapshotInfo
 * @property {'disconnected' | 'connecting' | 'connected' | 'version_skew'} state
 *   Connection state as computed by the controller.
 * @property {string} instanceId  Stable id of this browser instance.
 * @property {string} label  User-visible instance label.
 * @property {string} extensionVersion  Running extension version, for display.
 * @property {object | null} handshake  Negotiated protocol version, once connected.
 * @property {string | null} lastError  Last connection error, already user-safe.
 * @property {object | null} [daemonUpgradeRequired]  Set when the peer is too old.
 * @property {boolean} connectionEnabled  Whether the user allows connecting at all.
 * @property {object | null} [localAuth]  Pending local pairing challenge, if any.
 * @property {number} sessionCount  Live sessions; label changes are blocked while nonzero.
 *
 * @typedef {{ kind: 'set_label', value: string } | { kind: 'set_connection_enabled', value: boolean }} PopupOutbound
 * Preference updates sent by the popup. `set_label` carries the new display
 * label and is rejected while sessions are live; `set_connection_enabled`
 * carries the new on/off switch value.
 *
 * @typedef {object} PopupInbound
 * @property {'snapshot'} kind  Message discriminator.
 * @property {PopupSnapshotInfo} data  Full state; each message is self-contained.
 */
export const POPUP_PORT_NAME = 'popup';
