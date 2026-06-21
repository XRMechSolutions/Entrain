// layer-scheduler-adapter.ts — the Phase-2 sibling of scheduler-adapter.ts. The UI
// injects a layer-scheduling factory into transport exactly as it injects the binaural
// `scheduler` (design §16.2, arch §2.2/§6, D-036/D-037), so transport stays decoupled
// from the `layer-scheduler` module (it never imports it directly).
//
// The engine's `scheduleLayers` free function already MATCHES the transport
// `LayerSchedulerFactory` shape verbatim (arch §6: `scheduleLayers(mixer, nodes, layers,
// { t0, startOffsetSec }): LayerSchedule`). The UI's only job is to be the ONE place that
// imports it and hands it to `createTransport({ layerScheduler })` — it NEVER calls
// scheduleLayers itself (transport/renderer do), holds no Mixer/LayerNode, and writes no
// AudioParam (the duck/lanes stay engine-owned, single-writer D-019 / no-click D-008).

import { scheduleLayers } from '../../engine/layer-scheduler';
import type { LayerSchedulerFactory } from '../../engine/transport';

/** Build the `LayerSchedulerFactory` transport injects (the layer analogue of
 *  `createSchedulerAdapter`). Returns the engine's `scheduleLayers`, typed to transport's
 *  injected-factory contract. A factory (not the bare export) so the composition root wires
 *  it through the same `create…()` seam as the binaural scheduler and tests can stub it. */
export function createLayerScheduler(): LayerSchedulerFactory {
  return scheduleLayers;
}
