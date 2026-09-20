import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { formatBytes } from "@/lib/format-bytes";

/**
 * What this account is keeping.
 *
 * The Settings row that leads here already existed and opened a page showing the same two privacy
 * toggles as everything else. This is the screen that row always claimed to be: the media this
 * account's chats account for, largest first, plus the two other things a person can put in the
 * database.
 *
 * The figures are estimates and the screen says so. Attachments live in a text column, so a real
 * byte count would mean decoding every row; the server derives a size from the stored length instead.
 * Presenting that as exact would be a small lie told in a large font.
 */
export default function StorageScreen() {
  const colors = useColors();
  const router = useRouter();
  const usage = trpc.storage.usage.useQuery();
  const data = usage.data;

  const total = (data?.mediaBytes ?? 0) + (data?.stickerBytes ?? 0) + (data?.avatarBytes ?? 0);
  // Bars are relative to the largest chat rather than to the total, so a single big chat does not
  // flatten every other row into an invisible sliver.
  const largest = data?.conversations[0]?.bytes ?? 0;

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Storage and data</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {usage.isLoading ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}

        {data ? (
          <>
            <View style={[styles.totalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.totalLabel, { color: colors.muted }]}>STORED IN THIS ACCOUNT</Text>
              <Text style={[styles.totalValue, { color: colors.foreground }]}>{formatBytes(total)}</Text>
              <Text style={[styles.totalNote, { color: colors.muted }]}>
                An estimate: attachments are stored as text, so sizes are derived from their stored length.
              </Text>
            </View>

            <View style={styles.breakdown}>
              <View style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <MaterialIcons name="perm-media" size={20} color={colors.primary} />
                <Text style={[styles.tileValue, { color: colors.foreground }]}>{formatBytes(data.mediaBytes)}</Text>
                <Text style={[styles.tileLabel, { color: colors.muted }]}>
                  {data.mediaCount} {data.mediaCount === 1 ? "attachment" : "attachments"}
                </Text>
              </View>
              <View style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <MaterialIcons name="emoji-emotions" size={20} color={colors.primary} />
                <Text style={[styles.tileValue, { color: colors.foreground }]}>{formatBytes(data.stickerBytes)}</Text>
                <Text style={[styles.tileLabel, { color: colors.muted }]}>
                  {data.stickerCount} {data.stickerCount === 1 ? "sticker" : "stickers"}
                </Text>
              </View>
              <View style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <MaterialIcons name="account-circle" size={20} color={colors.primary} />
                <Text style={[styles.tileValue, { color: colors.foreground }]}>{formatBytes(data.avatarBytes)}</Text>
                <Text style={[styles.tileLabel, { color: colors.muted }]}>Profile photo</Text>
              </View>
            </View>

            <Text style={[styles.sectionLabel, { color: colors.muted }]}>BY CHAT</Text>

            {data.conversations.map((row) => (
              <View key={row.conversationId} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.rowTop}>
                  {/* A direct chat has no stored title; the server leaves it blank rather than guessing. */}
                  <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>
                    {row.title || "Direct chat"}
                  </Text>
                  <Text style={[styles.rowBytes, { color: colors.foreground }]}>{formatBytes(row.bytes)}</Text>
                </View>
                <View style={[styles.bar, { backgroundColor: colors.background }]}>
                  <View
                    style={[
                      styles.barFill,
                      { backgroundColor: colors.primary, width: `${largest > 0 ? Math.max(4, Math.round((row.bytes / largest) * 100)) : 0}%` },
                    ]}
                  />
                </View>
                <Text style={[styles.rowMeta, { color: colors.muted }]}>
                  {row.count} {row.count === 1 ? "file" : "files"}
                </Text>
              </View>
            ))}

            {data.conversations.length === 0 ? (
              <Text style={[styles.note, { color: colors.muted }]}>
                No media stored yet. Photos, videos, voice notes and documents you send or receive will be counted here.
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  spinner: { marginTop: 20 },
  totalCard: { borderWidth: 1, borderRadius: 20, padding: 20 },
  totalLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  totalValue: { fontSize: 34, fontWeight: "800", marginTop: 8 },
  totalNote: { fontSize: 11.5, lineHeight: 17, marginTop: 8 },
  breakdown: { flexDirection: "row", gap: 10 },
  tile: { flex: 1, borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  tileValue: { fontSize: 16, fontWeight: "800" },
  tileLabel: { fontSize: 11, lineHeight: 15 },
  sectionLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginTop: 14 },
  row: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowName: { flex: 1, fontSize: 14, fontWeight: "700" },
  rowBytes: { fontSize: 13, fontWeight: "800" },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3 },
  rowMeta: { fontSize: 11 },
  note: { fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 20 },
});
