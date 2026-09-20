import { useMemo, useState, type ComponentProps } from "react";
import { isOwnerAccount } from "@shared/owners";
import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { searchSettings, type SettingsEntry } from "@/lib/settings-catalog";

type IconName = ComponentProps<typeof MaterialIcons>["name"];

/**
 * Search across every Settings entry.
 *
 * This screen replaces a button that opened a generic "Settings search" page containing the same two
 * privacy toggles as everything else. It reads the shared catalogue, so anything reachable from
 * Settings is findable here, including the screens that live outside the Settings tab.
 */
export default function SettingsSearchScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const [query, setQuery] = useState("");

  const isOwner = isOwnerAccount(user as (typeof user & { role?: string; username?: string }) | null);
  // The catalogue is static, so the only work per keystroke is the filter itself.
  const results = useMemo(() => searchSettings(query, isOwner), [query, isOwner]);

  const open = (entry: SettingsEntry) => {
    if (entry.target.kind === "route") {
      router.push(entry.target.href);
      return;
    }
    router.push({ pathname: "/chat/setting-detail", params: { section: entry.target.section, title: entry.title, subtitle: entry.subtitle } });
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Search settings</Text>
      </View>

      <View style={[styles.searchWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <MaterialIcons name="search" size={20} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Try “pin”, “storage”, “blocked”"
          placeholderTextColor={colors.muted}
          style={[styles.searchInput, { color: colors.foreground }]}
          autoFocus
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <MaterialIcons name="close" size={18} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {results.map((entry) => (
          <Pressable
            key={entry.id}
            onPress={() => open(entry)}
            style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
          >
            <View style={styles.iconWrap}>
              <MaterialIcons name={entry.icon as IconName} size={20} color={colors.primary} />
            </View>
            <View style={styles.copy}>
              <Text style={[styles.rowTitle, { color: colors.foreground }]}>{entry.title}</Text>
              <Text style={[styles.rowSubtitle, { color: colors.muted }]} numberOfLines={2}>
                {entry.subtitle}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
          </Pressable>
        ))}

        {results.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="search-off" size={32} color={colors.muted} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Nothing matches “{query.trim()}”</Text>
            <Text style={[styles.emptyCopy, { color: colors.muted }]}>
              Settings are searched by name and by what they do, so “fingerprint” finds two-step verification.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 10, height: 50, marginHorizontal: 20, marginBottom: 14, paddingHorizontal: 14, borderWidth: 1, borderRadius: 15 },
  searchInput: { flex: 1, fontSize: 15.5, paddingVertical: 0 },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 16, padding: 14 },
  iconWrap: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,168,132,.14)" },
  copy: { flex: 1 },
  rowTitle: { fontSize: 14.5, fontWeight: "800" },
  rowSubtitle: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  pressed: { opacity: 0.65 },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16, fontWeight: "800", marginTop: 12, textAlign: "center" },
  emptyCopy: { fontSize: 13, lineHeight: 19, marginTop: 6, textAlign: "center" },
});
