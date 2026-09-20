import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";

export type LiveShare = {
  id: string;
  userId: number;
  lat: number;
  lng: number;
  label: string | null;
  updatedAt: string | Date;
  expiresAt: string | Date;
  userName: string;
};

/** Minutes left, rounded up, so a share that has 30 seconds on it still reads as a minute. */
function minutesLeft(expiresAt: string | Date): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60_000));
}

/**
 * The live locations currently running in a conversation.
 *
 * Presentational on purpose: starting and stopping a share is owned by the chat screen, which is
 * where the position is read from and where the interval that keeps it moving lives. Keeping that
 * here would mean a second place that knows how to start one.
 */
export function LiveLocationBar({
  shares,
  myUserId,
  onStop,
}: {
  shares: LiveShare[];
  myUserId: number | null;
  onStop: (id: string) => void;
}) {
  const colors = useColors();
  if (shares.length === 0) return null;

  const openInMaps = (share: LiveShare) => {
    // A geo: URI lets the device pick its own maps app; on the web it falls back to a maps page.
    const url = `https://www.openstreetmap.org/?mlat=${share.lat}&mlon=${share.lng}#map=16/${share.lat}/${share.lng}`;
    void Linking.openURL(url).catch(() => undefined);
  };

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      {shares.map((share) => {
        const mine = share.userId === myUserId;
        return (
          <View key={share.id} style={styles.row}>
            <MaterialIcons name="my-location" size={16} color={colors.primary} />
            <Pressable style={styles.copy} onPress={() => openInMaps(share)}>
              <Text style={[styles.name, { color: colors.primary }]} numberOfLines={1}>
                {mine ? "You are sharing your location" : `${share.userName} is sharing a location`}
              </Text>
              <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>
                {share.label ? `${share.label} · ` : ""}
                {/* Both numbers, because a live location is often read aloud to somebody. */}
                {share.lat.toFixed(4)}, {share.lng.toFixed(4)} · {minutesLeft(share.expiresAt)} min left
              </Text>
            </Pressable>
            <Pressable onPress={() => openInMaps(share)} hitSlop={8} style={styles.iconButton}>
              <MaterialIcons name="map" size={16} color={colors.muted} />
            </Pressable>
            {mine ? (
              <Pressable onPress={() => onStop(share.id)} hitSlop={8} style={styles.iconButton}>
                <MaterialIcons name="close" size={16} color={colors.error} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 5 },
  copy: { flex: 1 },
  name: { fontSize: 12, fontWeight: "800" },
  meta: { fontSize: 11, marginTop: 2 },
  iconButton: { padding: 4 },
});
