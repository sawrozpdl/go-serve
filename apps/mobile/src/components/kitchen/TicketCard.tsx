/**
 * KDS ticket card — a sent order on the kitchen board. A normal themed card
 * that follows the app's scheme (dark card in dark mode, paper in light), with
 * a coloured urgency left-edge, the qty in brand amber, and a mark-ready CTA.
 */
import { View } from 'react-native';
import { Clock } from 'lucide-react-native';
import { formatQty, resolveTableLabel, type KitchenTicket } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/theme';
import { elapsedLabel, ticketUrgency, type Urgency } from '@/kitchen/board';

const URGENCY_TONE: Record<Urgency, 'textFaint' | 'warnFgTile' | 'dangerFg'> = {
  fresh: 'textFaint',
  warn: 'warnFgTile',
  urgent: 'dangerFg',
};

export function TicketCard({
  ticket,
  now,
  canAct,
  busy,
  onAction,
}: {
  ticket: KitchenTicket;
  now: number;
  canAct: boolean;
  busy: boolean;
  onAction: () => void;
}) {
  const theme = useTheme();
  const isReady = ticket.kitchen_status === 'ready';
  const ref = isReady ? ticket.ready_at : ticket.sent_to_kitchen_at;
  const edge = isReady ? theme.colors.successFg : theme.colors[URGENCY_TONE[ticketUrgency(now, ref)]];
  const mods = modifierLines(ticket.modifiers);

  return (
    <Card level={2} padded={false} style={{ flex: 1, maxWidth: 560, overflow: 'hidden' }}>
      {/* urgency left edge — inside the card so elevation stays clean */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: edge }}
      />
      <View style={{ padding: theme.spacing[4], gap: theme.spacing[3] }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[2] }}>
          <MonoText weight="bold" size="lg" style={{ flexShrink: 1 }}>
            {resolveTableLabel(ticket, 'Take-away')}
          </MonoText>
          {isReady ? <Stamp size="sm" tone="success" label="Ready" /> : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: theme.spacing[2],
              paddingVertical: 3,
              borderRadius: theme.radii.pill,
              backgroundColor: theme.colors.surfaces[1],
            }}
          >
            <Clock size={12} color={edge} />
            <MonoText weight="bold" size="xs" style={{ color: edge }}>
              {elapsedLabel(now, ticket.sent_to_kitchen_at, ticket.ready_at)}
            </MonoText>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
          <MonoText weight="bold" size="xl" style={{ color: theme.colors.stamp.brand.fg }}>
            {formatQty(ticket.qty)}×
          </MonoText>
          <AppText style={{ flex: 1, fontFamily: theme.fonts.bodySemi, fontSize: theme.typeStyles['2xl'].size }}>
            {ticket.menu_item_name}
          </AppText>
        </View>

        {mods.length > 0 ? (
          <View style={{ gap: 2 }}>
            {mods.map((m) => (
              <AppText key={m} variant="muted" style={{ fontSize: theme.text.sm }}>
                + {m}
              </AppText>
            ))}
          </View>
        ) : null}
        {ticket.notes ? (
          <AppText style={{ color: theme.colors.warnFgTile, fontSize: theme.text.sm }}>» {ticket.notes}</AppText>
        ) : null}

        {canAct ? (
          <Button
            title={isReady ? 'Mark served' : 'Mark ready'}
            variant={isReady ? 'secondary' : 'primary'}
            loading={busy}
            onPress={onAction}
          />
        ) : (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {isReady ? 'Ready for pickup' : 'Cooking'}
          </AppText>
        )}
      </View>
    </Card>
  );
}

/** Flatten a ticket's modifier object into `key: value` lines for display. */
function modifierLines(mods: unknown): string[] {
  if (!mods || typeof mods !== 'object') return [];
  return Object.entries(mods as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`);
}
