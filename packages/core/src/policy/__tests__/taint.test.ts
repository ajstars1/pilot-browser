import { describe, expect, it } from 'vitest';
import { TaintTracker } from '../taint.js';

const MAIL = 'https://mail.example.com/inbox';
const FORM = 'https://jobs.example.org/apply';

describe('TaintTracker', () => {
  it('should flag text typed on one origin that was only read on another', () => {
    const taint = new TaintTracker();
    taint.record(MAIL, 'Your code is 493021-XQ. Alex Rivera, alex@example.com');
    expect(taint.sourcesOf('493021-XQ', FORM)).toEqual(['https://mail.example.com']);
  });

  it('should not flag text that also appears on the current origin', () => {
    const taint = new TaintTracker();
    taint.record(MAIL, 'reference ABCDEF123');
    taint.record(FORM, 'Use reference ABCDEF123 when applying');
    expect(taint.sourcesOf('ABCDEF123', FORM)).toEqual([]);
  });

  it("should never flag the user's declared identity values, or parts of them", () => {
    const taint = new TaintTracker({ exempt: ['Alex Rivera', 'alex@example.com', '+1 415 555 0134', 'https://www.linkedin.com/in/alex-rivera-example/'] });
    taint.record(MAIL, 'Alex Rivera alex@example.com +1 415 555 0134 https://www.linkedin.com/in/alex-rivera-example/ secret 493021-XQ');
    expect(taint.sourcesOf('Alex Rivera', FORM)).toEqual([]);
    expect(taint.sourcesOf('  alex rivera ', FORM)).toEqual([]);
    expect(taint.sourcesOf('Rivera', FORM)).toEqual([]);
    expect(taint.sourcesOf('alex@example.com', FORM)).toEqual([]);
    expect(taint.sourcesOf('415 555 0134', FORM)).toEqual([]);
    expect(taint.sourcesOf('4155550134', FORM)).toEqual([]);
    expect(taint.sourcesOf('https://www.linkedin.com/in/alex-rivera-example/', FORM)).toEqual([]);
    // Anything else read on the other origin is still tracked.
    expect(taint.sourcesOf('493021-XQ', FORM)).toEqual(['https://mail.example.com']);
    expect(taint.sourcesOf('Alex Rivera alex@example.com +1 415 555 0134 https://www.linkedin.com/in/alex-rivera-example/ secret', FORM)).toEqual([
      'https://mail.example.com',
    ]);
  });

  it('should not treat a short digit run as part of a declared phone number', () => {
    const taint = new TaintTracker({ exempt: ['+1 415 555 0134'] });
    taint.record(MAIL, 'otp 40934 and 840934');
    expect(taint.isExempt('840934')).toBe(false);
    expect(taint.sourcesOf('840934', FORM)).toEqual(['https://mail.example.com']);
  });
});
