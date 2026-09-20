import { useMemo } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { firstLink } from "@/lib/rich-text";

/**
 * The card shown under a message that contains a link.
 *
 * The URL is derived from the body here rather than passed in, so a caller only has to hand over the
 * text. `firstLink` is the same parser the renderer uses, which means the card appears for exactly
 * the strings that were turned into tappable links - no second, divergent idea of what a link is.
 *
 * One card per message is fine even though several messages can share a URL: React Query keys the
 * request by the URL, so the duplicate cards share one cache entry and one network call. The server
 * caches per URL as well, so the second reader of a link costs nothing.
 */
export function LinkPreviewCard({ text, mine }: { text: string; mine: boolean }) {
  const colors = useColors();
  const url = useMemo(() => firstLink(text), [text]);

  const query = trpc.links.preview.useQuery(
    { url: url ?? "" },
    {
      enabled: Boolean(url),
      // A preview does not change minute to minute, and refetching it on every mount would make
      // scrolling a busy thread issue a request per link.
      staleTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      // A link that will not preview is a normal outcome, not a failure worth retrying.
      retry: false,
    },
  );

  if (!url) return null;

  const preview = query.data;
  const muted = mine ? colors.bubbleOutgoingText : colors.muted;
  const strong = mine ? colors.bubbleOutgoingText : colors.foreground;

  // Nothing to show yet, or nothing to show ever: the message already contains the link itself, so
  // an empty state here would just be clutter.
  if (!preview) return null;

  const open = () => {
    void Linking.openURL(preview.url).catch(() => undefined);
  };

  return (
    <Pressable onPress={open} style={({ pressed }) => [styles.card, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && styles.pressed]}>
      {preview.imageUrl ? <Image source={{ uri: preview.imageUrl }} style={styles.image} resizeMode="cover" /> : null}
      <View style={styles.copy}>
        {preview.siteName ? <Text style={[styles.site, { color: muted }]} numberOfLines={1}>{preview.siteName}</Text> : null}
        {preview.title ? <Text style={[styles.title, { color: strong }]} numberOfLines={2}>{preview.title}</Text> : null}
        {preview.description ? <Text style={[styles.description, { color: muted }]} numberOfLines={2}>{preview.description}</Text> : null}
      </View>
      <MaterialIcons name="open-in-new" size={14} color={muted} style={styles.icon} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: 232, borderWidth: 1, borderRadius: 12, marginTop: 6, marginBottom: 4, overflow: "hidden" },
  image: { width: "100%", height: 118, backgroundColor: "rgba(127,127,127,0.14)" },
  copy: { paddingHorizontal: 10, paddingVertical: 8, gap: 3 },
  site: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.4 },
  title: { fontSize: 13, fontWeight: "700", lineHeight: 18 },
  description: { fontSize: 11.5, lineHeight: 16 },
  icon: { position: "absolute", top: 8, right: 8 },
  pressed: { opacity: 0.75 },
});
