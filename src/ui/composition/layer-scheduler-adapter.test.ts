// layer-scheduler-adapter test — the UI's Phase-2 cross-module wiring. createLayerScheduler
// must hand transport the engine's `scheduleLayers` factory VERBATIM (the UI never
// re-derives layer scheduling — arch §6, design §16.2). Asserts the returned value matches
// the LayerSchedulerFactory shape and IS the engine function (one home, injected like
// `scheduler`).

import { describe, expect, it } from 'vitest';
import { scheduleLayers } from '../../engine/layer-scheduler';
import { createLayerScheduler } from './layer-scheduler-adapter';

describe('createLayerScheduler (composition root, arch §6)', () => {
  it('returns the engine scheduleLayers factory (the UI only wires it, never re-implements)', () => {
    const factory = createLayerScheduler();
    expect(factory).toBe(scheduleLayers);
  });

  it('matches the LayerSchedulerFactory shape (a 4-arg function transport calls)', () => {
    const factory = createLayerScheduler();
    expect(typeof factory).toBe('function');
    expect(factory.length).toBe(4); // (mixer, nodes, layers, opts)
  });
});
