/**
 * Turning a picker asset into a multipart part. The gaps matter: some Android
 * providers hand back no filename, and the server infers the extension from
 * one.
 */
import { toPickedImage } from '../pickImage';

describe('toPickedImage', () => {
  it('passes through what the picker gave', () => {
    expect(
      toPickedImage({ uri: 'file:///a.png', fileName: 'a.png', mimeType: 'image/png' }),
    ).toEqual({ uri: 'file:///a.png', name: 'a.png', type: 'image/png' });
  });

  it('invents a filename from the mime type when the provider omits one', () => {
    expect(toPickedImage({ uri: 'content://x', fileName: null, mimeType: 'image/webp' })).toEqual({
      uri: 'content://x',
      name: 'upload.webp',
      type: 'image/webp',
    });
  });

  it('falls back to jpeg when the provider omits the type too', () => {
    expect(toPickedImage({ uri: 'content://x' })).toEqual({
      uri: 'content://x',
      name: 'upload.jpeg',
      type: 'image/jpeg',
    });
  });
});
