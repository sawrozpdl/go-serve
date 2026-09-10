/**
 * Settings → Workspace: how the cafe identifies itself.
 */
import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Card } from '@/components/ui/Card';
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { ImageField } from '@/components/ui/ImageField';
import { useTenantSettings, useUpdateTenantProfile } from '@/api/tenant';
import { useUploadLogo } from '@/api/uploads';
import { toast } from '@/lib/toast';

export default function Screen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const settings = useTenantSettings();
  const updateProfile = useUpdateTenantProfile();
  const uploadLogo = useUploadLogo();

  // Track only the user's edit (null = untouched) and fall back to the saved
  // value for display, so no effect is needed to seed state.
  const savedPhone = settings.data?.contact_phone ?? '';
  const [phoneEdit, setPhoneEdit] = useState<string | null>(null);
  const phone = phoneEdit ?? savedPhone;
  const phoneDirty = phoneEdit !== null && phoneEdit.trim() !== savedPhone;
  const savePhone = () =>
    updateProfile.mutate(
      { contact_phone: phone.trim() },
      {
        onSuccess: () => {
          setPhoneEdit(null);
          toast.success('Contact phone saved');
        },
        onError: (e) => toast.error('Could not save', (e as Error).message),
      },
    );

  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Workspace" />
      <ScrollView
        contentContainerStyle={{
          ...readableContent(layout),
          paddingTop: theme.spacing[4],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <Card>
                    <View style={{ gap: theme.spacing[3] }}>
                      <TextField
                        label="Contact phone"
                        value={phone}
                        onChangeText={setPhoneEdit}
                        placeholder="+977 …"
                        keyboardType="phone-pad"
                      />
                      <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                        The number your customers and the GoServe team reach you on.
                      </AppText>
                      <Button
                        title="Save phone"
                        onPress={savePhone}
                        loading={updateProfile.isPending}
                        disabled={!phoneDirty}
                      />
                      {/* The upload endpoint writes the branding block itself, so
                          there is nothing to save afterwards — just re-read. */}
                      <ImageField
                        label="Logo"
                        hint="Shown on the public menu and the dashboard."
                        value={settings.data?.branding?.logoUrl}
                        onChange={() => void settings.refetch()}
                        upload={uploadLogo.mutateAsync}
                        disabled={!can(me.data, 'tenant:upload_logo')}
                      />
                    </View>
                  </Card>
      </ScrollView>
    </View>
  );
}
