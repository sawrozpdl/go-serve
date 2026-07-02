/**
 * Public-menu share sheet — a QR customers scan (encodes /menu/:slug on the web
 * app) plus the link with copy + native share. Mirrors web's share modal.
 */
import { View, Pressable, Share } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Sheet } from '../ui/Sheet';
import { AppText } from '../ui/Text';
import { Button } from '../ui/Button';
import { useTheme } from '../../theme';
import { publicMenuUrl } from '../../lib/publicUrl';

export function ShareMenuSheet({ slug, cafeName, onClose }: { slug: string; cafeName?: string; onClose: () => void }) {
  const theme = useTheme();
  const url = publicMenuUrl(slug);

  const share = () => Share.share({ message: `${cafeName ?? 'Our'} menu — ${url}`, url });

  return (
    <Sheet open onClose={onClose} title="Share menu">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2], alignItems: 'center' }}>
        <AppText variant="muted" style={{ textAlign: 'center' }}>
          Customers scan this to view your menu — print it for tables or share the link.
        </AppText>
        <View style={{ padding: theme.spacing[4], backgroundColor: '#fff', borderRadius: theme.radii.lg }}>
          <QRCode value={url} size={200} backgroundColor="#fff" color="#000" />
        </View>
        <Pressable onPress={share} accessibilityLabel="menu-link">
          <AppText style={{ color: theme.colors.primary, fontFamily: theme.fonts.bodySemi }} numberOfLines={1}>
            {url}
          </AppText>
        </Pressable>
        <View style={{ alignSelf: 'stretch' }}>
          <Button title="Share link" onPress={share} />
        </View>
      </View>
    </Sheet>
  );
}
