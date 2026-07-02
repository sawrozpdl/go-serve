/**
 * KDS ticket card — the ONE deliberate inversion in the app: the kitchen board
 * is forced carbon (dark), but a ticket is a PAPER docket pinned to it. The
 * surrounding primitives read the carbon-scoped theme, so this card can't use
 * them; it builds a light theme once and styles raw Text/View from it. This is
 * the documented exception to the "theme only" rule.
 */
import { View, Text, Pressable } from 'react-native';
import { Clock } from 'lucide-react-native';
import { resolveTableLabel, type KitchenTicket } from '@cafe-mgmt/api-types';
import { buildTheme } from '@/theme';
import { elapsedLabel, ticketUrgency, type Urgency } from '@/kitchen/board';

/** Paper theme for the ticket surface (branding is null on mobile). */
const paper = buildTheme(null, 'light');

const URGENCY_COLOR: Record<Urgency, string> = {
  fresh: paper.colors.textFaint,
  warn: paper.colors.warnFgTile,
  urgent: paper.colors.dangerFg,
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
  const isReady = ticket.kitchen_status === 'ready';
  const ref = isReady ? ticket.ready_at : ticket.sent_to_kitchen_at;
  const edge = isReady ? paper.colors.successFg : URGENCY_COLOR[ticketUrgency(now, ref)];
  const mods = modifierLines(ticket.modifiers);

  return (
    <View
      style={{
        flex: 1,
        maxWidth: 560,
        backgroundColor: paper.colors.card,
        borderRadius: paper.radii.lg,
        borderLeftWidth: 4,
        borderLeftColor: edge,
        padding: paper.spacing[4],
        gap: paper.spacing[3],
        ...paper.elevation.card,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: paper.spacing[2] }}>
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            color: paper.colors.text,
            fontFamily: paper.fonts.monoBold,
            fontSize: paper.typeStyles.lg.size,
            fontVariant: ['tabular-nums'],
          }}
        >
          {resolveTableLabel(ticket, 'Take-away')}
        </Text>
        {isReady ? <PaperStamp label="Ready" color={paper.colors.successFg} /> : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: paper.spacing[2],
            paddingVertical: 3,
            borderRadius: paper.radii.pill,
            backgroundColor: paper.colors.surfaces[1],
          }}
        >
          <Clock size={12} color={edge} />
          <Text style={{ color: edge, fontFamily: paper.fonts.monoBold, fontSize: paper.text.xs, fontVariant: ['tabular-nums'] }}>
            {elapsedLabel(now, ticket.sent_to_kitchen_at, ticket.ready_at)}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: paper.spacing[2] }}>
        <Text style={{ color: paper.colors.stamp.brand.fg, fontFamily: paper.fonts.monoBold, fontSize: paper.typeStyles['2xl'].size, fontVariant: ['tabular-nums'] }}>
          {ticket.qty}×
        </Text>
        <Text style={{ flex: 1, color: paper.colors.text, fontFamily: paper.fonts.bodySemi, fontSize: paper.typeStyles['2xl'].size }}>
          {ticket.menu_item_name}
        </Text>
      </View>

      {mods.length > 0 ? (
        <View style={{ gap: 2 }}>
          {mods.map((m) => (
            <Text key={m} style={{ color: paper.colors.textMuted, fontFamily: paper.fonts.body, fontSize: paper.text.sm }}>
              + {m}
            </Text>
          ))}
        </View>
      ) : null}
      {ticket.notes ? (
        <Text style={{ color: paper.colors.warnFgTile, fontFamily: paper.fonts.bodyMedium, fontSize: paper.text.sm }}>
          » {ticket.notes}
        </Text>
      ) : null}

      {canAct ? (
        <Pressable
          onPress={onAction}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          style={{
            backgroundColor: paper.colors.text,
            borderRadius: paper.radii.md,
            paddingVertical: paper.spacing[3],
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: paper.touch.min,
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Text style={{ color: paper.colors.card, fontFamily: paper.fonts.bodySemi, fontSize: paper.typeStyles.lg.size }}>
            {isReady ? 'Mark served' : 'Mark ready'}
          </Text>
        </Pressable>
      ) : (
        <Text style={{ color: paper.colors.textFaint, fontFamily: paper.fonts.body, fontSize: paper.text.sm }}>
          {isReady ? 'Ready for pickup' : 'Cooking'}
        </Text>
      )}
    </View>
  );
}

/** Local stamp (the ui/Stamp reads the carbon-scoped theme, so it can't sit on
 * the paper ticket). */
function PaperStamp({ label, color }: { label: string; color: string }) {
  return (
    <View
      style={{
        borderColor: color,
        borderWidth: 1.5,
        borderRadius: paper.radii.xs + 1,
        paddingVertical: 2,
        paddingHorizontal: paper.spacing[1] + 2,
      }}
    >
      <Text style={{ color, fontFamily: paper.fonts.monoBold, fontSize: paper.text['2xs'], letterSpacing: 1, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  );
}

/** Flatten a ticket's modifier object into `key: value` lines for display. */
function modifierLines(mods: unknown): string[] {
  if (!mods || typeof mods !== 'object') return [];
  return Object.entries(mods as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`);
}
