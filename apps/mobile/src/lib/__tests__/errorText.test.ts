import { errorText } from '../errorText';

describe('errorText', () => {
  it('uses the message from the ApiError object the fetch layer throws', () => {
    // A plain object, not an Error — String() on this yields "[object Object]".
    const apiError = { status: 0, code: 'network', message: 'You appear to be offline.' };
    expect(errorText(apiError)).toBe('You appear to be offline.');
    expect(errorText(apiError)).not.toBe(String(apiError));
  });

  it('uses an Error instance message', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('passes a plain string through', () => {
    expect(errorText('just text')).toBe('just text');
  });

  it('falls back for null, undefined and messageless objects', () => {
    expect(errorText(null)).toBe('Something went wrong.');
    expect(errorText(undefined)).toBe('Something went wrong.');
    expect(errorText({})).toBe('Something went wrong.');
    expect(errorText({ message: '   ' })).toBe('Something went wrong.');
    expect(errorText({ message: 42 })).toBe('Something went wrong.');
  });
});
