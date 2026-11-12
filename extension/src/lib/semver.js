// Protocol-version parsing and comparison used by version-skew detection.
//
// Wire format is MAJOR.MINOR, not full app semver, so this module deliberately
// avoids a general semantic-version dependency. Both peers must agree exactly on
// what counts as a parseable version; otherwise one side would accept a handshake
// the other rejects and the connection would fail only after the fact.

/**
 * Compare two protocol-version strings on major, then minor. Returns null when
 * either side is unparseable.
 *
 * A missing minor component is treated as zero (`"2"` equals `"2.0"`). The
 * result follows the usual comparator convention: negative when `a` is older,
 * zero when both versions are equal, positive when `a` is newer.
 *
 * @param {string} a  Protocol version from one peer.
 * @param {string} b  Protocol version from the other peer.
 * @returns {number | null} Comparator result, or null when either side is invalid.
 */
export function compareProtocol(a, b) {
  const pa = parseProtocolParts(a);
  const pb = parseProtocolParts(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

/**
 * Parse a protocol version into its numeric parts.
 *
 * Only the first two dot-separated fields are significant. A trailing dot or
 * empty minor field is rejected rather than treated as zero, because accepting
 * it would diverge from the peer's parser. Anything after the second field is
 * ignored.
 *
 * @param {string} value  Candidate protocol version.
 * @returns {{ major: number, minor: number } | null} Parsed parts, or null.
 */
function parseProtocolParts(value) {
  const major = parseProtocolMajor(value);
  if (major === null) return null;
  const rest = value.split('.')[1];
  if (rest === undefined || rest === '') return { major, minor: 0 };
  if (!/^\d+$/.test(rest)) return null;
  const minor = Number(rest);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return { major, minor };
}

/**
 * Extract the leading numeric major from a protocol-version string. The wire
 * format is MAJOR.MINOR; a missing or non-numeric field yields null.
 *
 * The accepted grammar is exactly one non-empty run of ASCII digits before the
 * first dot. Signs, whitespace, exponents, decimal points and trailing letters
 * are rejected on purpose: a lenient parse here would accept a version string
 * the peer rejects, producing a connect-then-drop instead of a clean version
 * mismatch. Values outside the safe-integer range are also rejected, so a
 * comparison can never silently lose precision.
 *
 * @param {string} value  Candidate protocol version.
 * @returns {number | null} Major component, or null when it is not a valid one.
 */
export function parseProtocolMajor(value) {
  const head = value.split('.')[0];
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}
