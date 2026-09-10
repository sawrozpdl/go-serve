/**
 * The new-ticket chime. Haptics are useless on a wall-mounted KDS — nobody is
 * touching it — so this is the alert that actually reaches a cook.
 */
import { createAudioPlayer } from 'expo-audio';
import { playNewTicketChime, releaseChime } from '../chime';

const mocked = createAudioPlayer as jest.Mock;
const player = () => mocked.mock.results[0]?.value;

beforeEach(() => {
  releaseChime();
  jest.clearAllMocks();
});

describe('playNewTicketChime', () => {
  it('rewinds before playing, so a second ticket is not silent', () => {
    // Without the seek, a ticket landing inside the sound's own length makes
    // no noise — precisely when you most need to hear it.
    playNewTicketChime();
    expect(player().seekTo).toHaveBeenCalledWith(0);
    expect(player().play).toHaveBeenCalledTimes(1);
  });

  it('builds the player once, not once per ticket', () => {
    // A player per order leaks one per ticket on a busy night.
    playNewTicketChime();
    playNewTicketChime();
    playNewTicketChime();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(player().play).toHaveBeenCalledTimes(3);
  });

  it('never throws when the audio session refuses', () => {
    // A silent chime is an annoyance; a crashed kitchen board mid-service is
    // not. The ticket is already on screen by the time this runs.
    mocked.mockImplementationOnce(() => {
      throw new Error('no audio route');
    });
    expect(() => playNewTicketChime()).not.toThrow();
  });

  it('never throws when playback itself fails', () => {
    mocked.mockImplementationOnce(() => ({
      seekTo: () => {
        throw new Error('detached');
      },
      play: jest.fn(),
      remove: jest.fn(),
    }));
    expect(() => playNewTicketChime()).not.toThrow();
  });
});

describe('releaseChime', () => {
  it('drops the player so a backgrounded screen holds no audio session', () => {
    playNewTicketChime();
    const p = player();
    releaseChime();
    expect(p.remove).toHaveBeenCalled();

    // And a later chime builds a fresh one rather than using the dead handle.
    playNewTicketChime();
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('is safe to call when nothing was ever played', () => {
    expect(() => releaseChime()).not.toThrow();
  });
});
