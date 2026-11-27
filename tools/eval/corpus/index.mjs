/**
 * tools/eval/corpus/index.mjs -- gate manifest.
 *
 * The five required areas are the invariant surfaces the rest of the system
 * depends on: VOM geometry/visibility, observation diffs, per-session command
 * queue, write-ahead intent ledger and the protocol/method state machine.
 * `eval-kernel` is the calibration corpus for the property-testing kernel
 * itself; it is reported but not required by coverage policy.
 *
 * Adding an area = adding one module here. `tools/eval/lib/corpus.mjs` validates
 * ids, `consumes` declarations and `file:line` resolution before any property
 * runs, so a stale manifest fails the gate with exit code 2.
 */

import evalKernel from './harness-self.mjs';
import vomGeometry from './vom-geometry.mjs';
import observeDiff from './observe-diff.mjs';
import sessionQueue from './session-queue.mjs';
import intentLedger from './intent-ledger.mjs';
import protocolState from './protocol-state.mjs';

export const AREAS = Object.freeze([
  { module: 'tools/eval/corpus/harness-self.mjs', loaded: evalKernel },
  { module: 'tools/eval/corpus/vom-geometry.mjs', loaded: vomGeometry },
  { module: 'tools/eval/corpus/observe-diff.mjs', loaded: observeDiff },
  { module: 'tools/eval/corpus/session-queue.mjs', loaded: sessionQueue },
  { module: 'tools/eval/corpus/intent-ledger.mjs', loaded: intentLedger },
  { module: 'tools/eval/corpus/protocol-state.mjs', loaded: protocolState },
]);

export default AREAS;
