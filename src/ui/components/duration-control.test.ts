import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import DurationControl from './DurationControl.svelte';

afterEach(cleanup);

describe('DurationControl — one-way mm:ss / seconds parsing', () => {
  it('renders the current duration as a clock string', () => {
    const { getByLabelText } = render(DurationControl, { value: 330, oncommit: vi.fn() });
    expect((getByLabelText('Session duration') as HTMLInputElement).value).toBe('5:30');
  });

  it('commits "mm:ss" as seconds', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(DurationControl, { value: 300, oncommit });
    await fireEvent.change(getByLabelText('Session duration'), { target: { value: '5:30' } });
    expect(oncommit).toHaveBeenCalledWith(330);
  });

  it('commits a plain seconds entry', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(DurationControl, { value: 300, oncommit });
    await fireEvent.change(getByLabelText('Session duration'), { target: { value: '90' } });
    expect(oncommit).toHaveBeenCalledWith(90);
  });

  it('commits "h:mm:ss" as seconds', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(DurationControl, { value: 300, oncommit });
    await fireEvent.change(getByLabelText('Session duration'), { target: { value: '1:01:01' } });
    expect(oncommit).toHaveBeenCalledWith(3661);
  });

  it('an unparseable entry reverts and is NOT committed', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(DurationControl, { value: 300, oncommit });
    const input = getByLabelText('Session duration') as HTMLInputElement;
    await fireEvent.change(input, { target: { value: 'soon' } });
    expect(oncommit).not.toHaveBeenCalled();
    expect(input.value).toBe('5:00'); // reverted to the last valid display
  });

  it('an empty entry reverts and is NOT committed', async () => {
    const oncommit = vi.fn();
    const { getByLabelText } = render(DurationControl, { value: 300, oncommit });
    const input = getByLabelText('Session duration') as HTMLInputElement;
    await fireEvent.change(input, { target: { value: '' } });
    expect(oncommit).not.toHaveBeenCalled();
    expect(input.value).toBe('5:00');
  });
});

describe('DurationControl — quick-pick minute chips', () => {
  it('a chip commits its length in seconds (10m → 600)', async () => {
    const oncommit = vi.fn();
    const { getByRole } = render(DurationControl, { value: 300, oncommit });
    await fireEvent.click(getByRole('button', { name: '10m' }));
    expect(oncommit).toHaveBeenCalledWith(600);
  });

  it('marks the chip matching the current value as active (pressed)', () => {
    const { getByRole } = render(DurationControl, { value: 600, oncommit: vi.fn() });
    expect(getByRole('button', { name: '10m' })).toHaveAttribute('aria-pressed', 'true');
    expect(getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reflects an external value change in the field at once (no wait for next play)', async () => {
    const { getByLabelText, rerender } = render(DurationControl, { value: 300, oncommit: vi.fn() });
    expect((getByLabelText('Session duration') as HTMLInputElement).value).toBe('5:00');
    await rerender({ value: 600, oncommit: vi.fn() });
    expect((getByLabelText('Session duration') as HTMLInputElement).value).toBe('10:00');
  });
});
