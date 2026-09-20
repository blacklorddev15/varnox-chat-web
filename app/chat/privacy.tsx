import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
// Type-only, so nothing from the server bundle reaches the client. `lib/trpc.ts` already imports a
// type from `@/server/routers` the same way.
import type { Visibility } from "@/server/db";

/**
 * Who may see what.
 *
 * The tiers are checked against the server's list with `satisfies`, so renaming one there becomes a
 * compile error here rather than a value the server rejects at runtime.
 */
const TIERS = ["everyone", "contacts", "nobody"] as const satisfies readonly Visibility[];

const TIER_LABELS: Record<(typeof TIERS)[number], string> = {
  everyone: "Everyone",
  contacts: "My contacts",
  nobody: "Nobody",
};

type AudienceField = "profilePhotoVisibility" | "aboutVisibility" | "statusVisibility" | "groupAddPolicy";

const FIELDS: Array<{ key: AudienceField; title: string; subtitle: string; icon: string }> = [
  { key: "profilePhotoVisibility", title: "Profile photo", subtitle: "Who can see your photo", icon: "account-circle" },
  { key: "aboutVisibility", title: "About", subtitle: "Who can see your about text", icon: "info-outline" },
  { key: "statusVisibility", title: "Status", subtitle: "Who can see the statuses you post", icon: "donut-large" },
  { key: "groupAddPolicy", title: "Groups", subtitle: "Who can add you to a group", icon: "group-add" },
];

export default function PrivacyScreen() {
  const colors = useColors();
  const router = useRouter();
  const settings = trpc.settings.get.useQuery();
  const setPrivacy = trpc.settings.setPrivacy.useMutation({ onSuccess: () => settings.refetch() });

  const current = settings.data as Record<string, unknown> | undefined;
  const silent = Boolean(current?.silenceUnknownCallers);

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Privacy</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* The word "contacts" means something narrower here than it does in the apps this follows,
            and saying so is better than letting the label imply a bigger audience than it has. */}
        <View style={[styles.note, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <MaterialIcons name="info-outline" size={16} color={colors.muted} />
          <Text style={[styles.noteText, { color: colors.muted }]}>
            Varnox has no address book, so “My contacts” means people you already have a one-to-one chat with. Choose
            Everyone if you want a wider audience.
          </Text>
        </View>

        {FIELDS.map((field) => {
          const value = (current?.[field.key] as string | undefined) ?? "everyone";
          return (
            <View key={field.key} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.cardHead}>
                <MaterialIcons name={field.icon as never} size={19} color={colors.primary} />
                <View style={styles.cardCopy}>
                  <Text style={[styles.cardTitle, { color: colors.foreground }]}>{field.title}</Text>
                  <Text style={[styles.cardSub, { color: colors.muted }]}>{field.subtitle}</Text>
                </View>
              </View>
              <View style={styles.tiers}>
                {TIERS.map((tier) => {
                  const selected = value === tier;
                  return (
                    <Pressable
                      key={tier}
                      disabled={setPrivacy.isPending}
                      onPress={() => setPrivacy.mutate({ [field.key]: tier } as Partial<Record<AudienceField, Visibility>>)}
                      style={[
                        styles.tier,
                        { borderColor: selected ? colors.primary : colors.border },
                        selected && { backgroundColor: colors.primary },
                      ]}
                    >
                      <Text style={[styles.tierText, { color: selected ? "#FFFFFF" : colors.foreground }]}>
                        {TIER_LABELS[tier]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.switchRow}>
            <View style={styles.cardCopy}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Silence unknown callers</Text>
              <Text style={[styles.cardSub, { color: colors.muted }]}>
                Calls from people you have no chat with will not ring. They still appear in your call list.
              </Text>
            </View>
            <Switch
              value={silent}
              disabled={setPrivacy.isPending}
              onValueChange={(next) => setPrivacy.mutate({ silenceUnknownCallers: next })}
              trackColor={{ false: colors.border, true: "#A7E8CD" }}
              thumbColor={silent ? colors.success : "#fff"}
            />
          </View>
        </View>

        {setPrivacy.isError ? (
          <Text style={[styles.error, { color: colors.error }]}>Could not save that. {setPrivacy.error.message}</Text>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  note: { flexDirection: "row", gap: 10, borderWidth: 1, borderRadius: 14, padding: 12 },
  noteText: { flex: 1, fontSize: 12, lineHeight: 17 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardCopy: { flex: 1 },
  cardTitle: { fontSize: 14.5, fontWeight: "800" },
  cardSub: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  tiers: { flexDirection: "row", gap: 8 },
  tier: { flex: 1, borderWidth: 1, borderRadius: 12, paddingVertical: 9, alignItems: "center" },
  tierText: { fontSize: 12.5, fontWeight: "700" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  error: { fontSize: 12.5, fontWeight: "700" },
});
