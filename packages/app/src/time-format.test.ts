import { describe, expect, it } from 'vitest';
import { formatLocalTime } from './time-format';

/*
 * The scrubber's local time (L4 review): the day fixture starts at 00:00
 * UTC on Nov 9, which is still Nov 8 on the US west coast, so a bare
 * "16:00:00 PST" read as the wrong day. The local date shows whenever it is
 * not the UTC date.
 */

describe('formatLocalTime', () => {
  it('is the bare time when the local date is the UTC date', () => {
    expect(formatLocalTime(Date.parse('2026-11-09T23:27:00Z'), 'America/Los_Angeles')).toBe('15:27:00 PST');
    expect(formatLocalTime(Date.parse('2026-11-09T12:00:00Z'), 'UTC')).toBe('12:00:00 UTC');
  });

  it('puts the local date first when it differs from the UTC date (either way)', () => {
    expect(formatLocalTime(Date.parse('2026-11-09T00:00:00.020Z'), 'America/Los_Angeles')).toBe('Nov 8, 16:00:00 PST');
    expect(formatLocalTime(Date.parse('2026-11-09T23:30:00Z'), 'Asia/Tokyo')).toBe('Nov 10, 08:30:00 GMT+9');
  });
});
