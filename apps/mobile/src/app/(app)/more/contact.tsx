/**
 * More → Contact us. The GoServe support team, each with quick Email / Call
 * actions. Mirrors the web account-menu contact modal.
 */
import { View, ScrollView, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Mail, Phone } from 'lucide-react-native';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/theme';
import { toast } from '@/lib/toast';
import { SUPPORT_CONTACTS, contactMailto, contactTel } from '@/lib/support';

export default function Contact() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const open = (url: string) => {
    void Linking.openURL(url).catch(() =>
      toast.error("Couldn't open", 'No app available for this action'),
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Contact us" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[5],
        }}
      >
        <Section title="We're happy to help">
          <View style={{ gap: theme.spacing[3] }}>
            {SUPPORT_CONTACTS.map((c) => (
              <Card key={c.name} style={{ gap: theme.spacing[3] }}>
                <View style={{ gap: 2 }}>
                  <AppText style={{ fontFamily: theme.fonts.bodySemi, fontSize: theme.text.lg }}>
                    {c.name}
                  </AppText>
                  <MonoText size="2xs" muted>
                    {c.email}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </MonoText>
                </View>
                <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Email"
                      variant="secondary"
                      icon={<Mail size={16} color={theme.colors.text} strokeWidth={1.8} />}
                      onPress={() => open(contactMailto(c.email))}
                    />
                  </View>
                  {c.phone ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Call"
                        variant="secondary"
                        icon={<Phone size={16} color={theme.colors.text} strokeWidth={1.8} />}
                        onPress={() => open(contactTel(c.phone!))}
                      />
                    </View>
                  ) : null}
                </View>
              </Card>
            ))}
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}
