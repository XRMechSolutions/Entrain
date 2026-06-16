import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';
import type { TransportState } from '../../engine/transport';
import { CONTROL } from '../lib/controls';
import TransportButton from './TransportButton.svelte';
import ParamControl from './ParamControl.svelte';
import MasterVolume from './MasterVolume.svelte';
import Scrubber from './Scrubber.svelte';
import WaveformPicker from './WaveformPicker.svelte';

afterEach(cleanup);

describe('TransportButton — label/action by playback.state (design §5)', () => {
  const cases: Array<{ state: TransportState; label: string }> = [
    { state: 'idle', label: 'Play' },
    { state: 'playing', label: 'Pause' },
    { state: 'paused', label: 'Resume' },
    { state: 'interrupted', label: 'Resume' },
    { state: 'stopped', label: 'Play' },
  ];
  for (const c of cases) {
    it(`shows "${c.label}" when ${c.state}`, () => {
      const onprimary = vi.fn();
      const { getByRole } = render(TransportButton, { state: c.state, canPlay: true, onprimary });
      expect(getByRole('button', { name: c.label })).toBeInTheDocument();
    });
  }

  it('calls onprimary on click (the parent maps it to play/pause)', async () => {
    const onprimary = vi.fn();
    const { getByRole } = render(TransportButton, { state: 'idle', canPlay: true, onprimary });
    await fireEvent.click(getByRole('button'));
    expect(onprimary).toHaveBeenCalledTimes(1);
  });

  it('is disabled when canPlay is false (WEB_AUDIO_UNSUPPORTED, edge A4)', () => {
    const { getByRole } = render(TransportButton, { state: 'idle', canPlay: false, onprimary: vi.fn() });
    expect(getByRole('button')).toBeDisabled();
  });
});

describe('ParamControl — oninput display-only vs oncommit reschedule (design §6.2, the rule)', () => {
  it('oninput fires on a live drag sample but oncommit does NOT (display only)', async () => {
    const oninput = vi.fn();
    const oncommit = vi.fn();
    const { getByLabelText } = render(ParamControl, {
      label: 'Carrier',
      spec: CONTROL.carrier,
      value: 200,
      oninput,
      oncommit,
    });
    const slider = getByLabelText('Carrier');
    await fireEvent.input(slider, { target: { value: '300' } });
    expect(oninput).toHaveBeenCalledWith(300);
    expect(oncommit).not.toHaveBeenCalled();
  });

  it('oncommit fires on change and CLAMPS an out-of-range typed value (edge B2)', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(ParamControl, {
      label: 'Carrier',
      spec: CONTROL.carrier,
      value: 200,
      oninput: vi.fn(),
      oncommit,
    });
    const number = getByLabelText('Carrier value');
    await fireEvent.change(number, { target: { value: '5000' } }); // above max 1000
    expect(oncommit).toHaveBeenCalledWith(1000);
  });

  it('an empty/NaN typed value reverts and is NOT committed (never writes non-finite, B3)', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(ParamControl, {
      label: 'Beat',
      spec: CONTROL.beat,
      value: 8,
      oninput: vi.fn(),
      oncommit,
    });
    const number = getByLabelText('Beat value') as HTMLInputElement;
    await fireEvent.change(number, { target: { value: '' } });
    expect(oncommit).not.toHaveBeenCalled();
  });
});

describe('MasterVolume — the cheap live path streams (design §6.1)', () => {
  it('streams oninput on every input sample', async () => {
    const oninput = vi.fn();
    const { getByLabelText } = render(MasterVolume, { value: 0.8, oninput });
    const slider = getByLabelText('Master volume');
    await fireEvent.input(slider, { target: { value: '0.5' } });
    expect(oninput).toHaveBeenCalledWith(0.5);
  });
});

describe('Scrubber — drag suppresses tick until release (edge C1)', () => {
  it('scrubstart on pointerdown, drag shows dragged value, release seeks + scrubend', async () => {
    const onseek = vi.fn();
    const onscrubstart = vi.fn();
    const onscrubend = vi.fn();
    const { getByLabelText } = render(Scrubber, {
      positionSec: 10,
      durationSec: 300,
      onseek,
      onscrubstart,
      onscrubend,
    });
    const range = getByLabelText('Seek position');
    await fireEvent.pointerDown(range);
    expect(onscrubstart).toHaveBeenCalledTimes(1);
    await fireEvent.input(range, { target: { value: '120' } });
    expect(onseek).not.toHaveBeenCalled(); // no seek mid-drag
    await fireEvent.change(range, { target: { value: '120' } });
    expect(onseek).toHaveBeenCalledWith(120);
    expect(onscrubend).toHaveBeenCalledTimes(1);
  });
});

describe('WaveformPicker — committed enum choice', () => {
  it('calls onchange with the picked waveform', async () => {
    const onchange = vi.fn();
    const { getByRole } = render(WaveformPicker, { value: 'sine', onchange });
    await fireEvent.click(getByRole('button', { name: /square/i }));
    expect(onchange).toHaveBeenCalledWith('square');
  });
});
