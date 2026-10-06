import { describe, expect, it } from 'vitest';
import { assessAction, describeAction, type TargetFacts } from '../risk.js';
import { TaintTracker } from '../taint.js';

const facts = (over: Partial<TargetFacts>): TargetFacts => ({
  tag: 'BUTTON',
  type: null,
  role: null,
  text: '',
  href: null,
  inForm: false,
  formMethod: null,
  formAction: null,
  ...over,
});
const url = 'https://shop.example.com/cart';
const click = { type: 'click', target: { ref: '@e1' } } as const;

describe('assessAction', () => {
  it('should flag a submit button in a POST form, with the form action as destination', () => {
    const a = assessAction(click, { url, target: facts({ inForm: true, formMethod: 'post', formAction: 'https://shop.example.com/order' }) });
    expect(a).toEqual({ consequential: true, reasons: ['submits a form'], destination: 'https://shop.example.com/order' });
  });

  it('should not flag a GET search form, but still report where it goes', () => {
    const a = assessAction(click, { url, target: facts({ text: 'Search', inForm: true, formMethod: 'get', formAction: 'https://shop.example.com/search' }) });
    expect(a).toEqual({ consequential: false, reasons: [], destination: 'https://shop.example.com/search' });
  });

  it('should treat type="button" inside a form as not submitting', () => {
    expect(assessAction(click, { url, target: facts({ type: 'button', inForm: true, formMethod: 'post' }) }).consequential).toBe(false);
  });

  it('should flag risky wording from the ref name or the DOM text', () => {
    expect(assessAction(click, { url, target: null, refName: 'Place order' }).consequential).toBe(true);
    expect(assessAction(click, { url, target: facts({ tag: 'DIV', text: 'Delete repository' }) }).reasons).toEqual(['the control says “Delete repository”']);
  });

  it('should not flag everyday controls that would make approvals noise', () => {
    for (const name of ['Accept cookies', 'OK', 'Next', 'Continue', 'Save draft', 'Search', 'Menu', 'Sending options']) {
      expect(assessAction(click, { url, target: null, refName: name }).consequential, name).toBe(false);
    }
  });

  it('should report a link destination but ignore same-page anchors and javascript: links', () => {
    expect(assessAction(click, { url, target: facts({ tag: 'A', href: 'https://evil.example/x' }) }).destination).toBe('https://evil.example/x');
    expect(assessAction(click, { url, target: facts({ tag: 'A', href: `${url}#top` }) }).destination).toBeNull();
    expect(assessAction(click, { url, target: facts({ tag: 'A', href: 'javascript:void(0)' }) }).destination).toBeNull();
  });

  it('should flag Enter in a POST form field and every upload', () => {
    const enter = assessAction({ type: 'key', keys: 'Enter' }, { url, target: facts({ tag: 'INPUT', type: 'email', inForm: true, formMethod: 'post' }) });
    expect(enter.consequential).toBe(true);
    expect(assessAction({ type: 'key', keys: 'Tab' }, { url, target: facts({ tag: 'INPUT', inForm: true, formMethod: 'post' }) }).consequential).toBe(false);
    expect(assessAction({ type: 'upload', ref: '@e2', files: ['/x/resume.pdf'] }, { url, target: null }).consequential).toBe(true);
  });

  it('should flag accepting a confirm dialog but not dismissing it', () => {
    const target = facts({ tag: 'DIALOG', dialogType: 'confirm', text: 'Really delete?' });
    expect(assessAction({ type: 'dialog', accept: true }, { url, target }).reasons).toEqual(['accepts a confirm dialog: “Really delete?”']);
    expect(assessAction({ type: 'dialog', accept: false }, { url, target }).consequential).toBe(false);
  });
});

describe('describeAction', () => {
  it('should produce a short prompt the user can judge', () => {
    expect(describeAction(click, { url, target: null, refName: 'Place order' })).toBe('Click “Place order” on shop.example.com');
    expect(describeAction({ type: 'upload', ref: '@e2', files: ['/home/a/resume.pdf'] }, { url, target: null })).toBe('Upload resume.pdf to shop.example.com');
  });
});

describe('TaintTracker', () => {
  it('should flag text read on another origin', () => {
    const t = new TaintTracker();
    t.record('https://mail.example.com/inbox', 'Your verification code is 482913');
    expect(t.sourcesOf('482913', 'https://attacker.example/form')).toEqual(['https://mail.example.com']);
  });

  it('should allow copying within the same site and ignore short strings', () => {
    const t = new TaintTracker();
    t.record('https://mail.example.com/inbox', 'Order ABC12345 shipped');
    t.record('https://shop.example.com/orders', 'Track ABC12345');
    expect(t.sourcesOf('ABC12345', 'https://shop.example.com/track')).toEqual([]);
    expect(t.sourcesOf('ABC', 'https://other.example/')).toEqual([]);
  });

  it('should match case- and whitespace-insensitively', () => {
    const t = new TaintTracker();
    t.record('https://a.example/', 'Secret   Token XYZ');
    expect(t.sourcesOf('secret token xyz', 'https://b.example/')).toEqual(['https://a.example']);
  });
});
