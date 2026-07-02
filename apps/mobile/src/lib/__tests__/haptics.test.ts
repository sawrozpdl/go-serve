import * as Haptics from 'expo-haptics';
import { haptics } from '../haptics';
import { useHapticsPrefs } from '../../stores/hapticsPrefs';

describe('haptics gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useHapticsPrefs.setState({ enabled: false });
  });

  it('no-ops while the pref is off (the default)', () => {
    haptics.selection();
    haptics.notifySuccess();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it('fires the underlying haptics once enabled', () => {
    useHapticsPrefs.setState({ enabled: true });
    haptics.selection();
    haptics.notifySuccess();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });
});
