// Control specs for the Phase-1 live parameter controls. Bounds are derived from
// session-model RANGES so the UI can never author an out-of-range (invalid) preset
// (design §6, edge-cases B2). Steps match the audible resolution of each param (§14).

import { RANGES } from '../../engine/session-model';

/** Slider / number-input bounds + display unit for one control. */
export interface ControlSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

/** The Phase-1 controls, keyed by the field each edits. Carrier/beat/volume/spatial edit
 *  nodes[0]; masterGain is preset.masterGain + the transport live trim. Spatial is the
 *  stereo pan position −1 (left) .. +1 (right) (D-021). voiceGain is the per-voice mix
 *  trim for extra voices (v6). */
export const CONTROL: Readonly<Record<'carrier' | 'beat' | 'volume' | 'spatial' | 'masterGain' | 'voiceGain', ControlSpec>> = {
  carrier: { min: RANGES.carrier.min, max: RANGES.carrier.max, step: 1, unit: 'Hz' },
  beat: { min: RANGES.beat.min, max: RANGES.beat.max, step: 0.1, unit: 'Hz' },
  volume: { min: RANGES.volume.min, max: RANGES.volume.max, step: 0.01, unit: '%' },
  spatial: { min: RANGES.spatial.min, max: RANGES.spatial.max, step: 0.01, unit: 'pan' },
  masterGain: { min: RANGES.masterGain.min, max: RANGES.masterGain.max, step: 0.01, unit: '%' },
  voiceGain: { min: RANGES.voiceGain.min, max: RANGES.voiceGain.max, step: 0.01, unit: '%' },
};
