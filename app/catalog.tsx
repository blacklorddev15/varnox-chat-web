import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * A list of things somebody offers.
 *
 * Two modes in one screen: your own list, which you can edit, and somebody else's, opened with a
 * `userId`, which is read only. Splitting them would have meant two nearly identical screens and a
 * second place for the price formatting to drift.
 */
export default function CatalogScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ userId?: string }>();
  const requestedId = params.userId ? Number(params.userId) : null;
  const myId = (user as (typeof user & { id?: number }) | null)?.id ?? null;

  // Undefined means "mine"; a number that is not mine switches the whole screen to read only.
  const isMine = requestedId === null || requestedId === myId;
  const ownerId = isMine ? myId : requestedId;

  const mine = trpc.catalog.mine.useQuery(undefined, { enabled: isMine });
  const theirs = trpc.catalog.ofUser.useQuery({ userId: requestedId ?? 0 }, { enabled: !isMine && Boolean(requestedId) });
  const items = isMine ? (mine.data ?? []) : (theirs.data ?? []);
  const loading = isMine ? mine.isLoading : theirs.isLoading;

  const addItem = trpc.catalog.add.useMutation({ onSuccess: () => { void mine.refetch(); setName(""); setPrice(""); setDescription(""); setComposing(false); } });
  const archiveItem = trpc.catalog.archive.useMutation({ onSuccess: () => mine.refetch() });

  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** "12.50" into 1250. Rounded, because a fractional minor unit is not a price. */
  const priceToCents = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100);
  };

  const submit = async () => {
    setError(null);
    const priceCents = priceToCents(price);
    // A price that was typed and could not be read is worth refusing; a blank one is simply optional.
    if (price.trim() && priceCents === null) {
      setError("That price could not be read. Use a number like 12.50.");
      return;
    }
    try {
      await addItem.mutateAsync({ name: name.trim(), description: description.trim() || undefined, priceCents: priceCents ?? undefined });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That item could not be added");
    }
  };

  const formatPrice = (cents: number | null, currency: string) => {
    if (cents === null) return "Ask";
    // Intl rather than string arithmetic, so the symbol and separators follow the currency.
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>{isMine ? "My catalog" : "Catalog"}</Text>
        {isMine ? (
          <Pressable onPress={() => setComposing((open) => !open)} hitSlop={10}>
            <MaterialIcons name={composing ? "close" : "add"} size={22} color={colors.primary} />
          </Pressable>
        ) : null}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {composing && isMine ? (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput value={name} onChangeText={setName} placeholder="What are you offering?" placeholderTextColor={colors.muted} maxLength={120} style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
              <TextInput value={price} onChangeText={setPrice} placeholder="Price, e.g. 12.50 (optional)" placeholderTextColor={colors.muted} keyboardType="decimal-pad" style={[styles.input, { color: colors.foreground, borderColor: colors.border }]} />
              <TextInput value={description} onChangeText={setDescription} placeholder="Details (optional)" placeholderTextColor={colors.muted} multiline maxLength={2000} style={[styles.input, styles.multiline, { color: colors.foreground, borderColor: colors.border }]} />
              {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              <Pressable
                disabled={!name.trim() || addItem.isPending}
                onPress={() => void submit()}
                style={[styles.primary, { backgroundColor: colors.primary, opacity: !name.trim() || addItem.isPending ? 0.5 : 1 }]}
              >
                <Text style={styles.primaryText}>{addItem.isPending ? "Adding…" : "Add to catalog"}</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? <ActivityIndicator color={colors.primary} /> : null}

          {items.map((item) => (
            <View key={item.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.itemRow}>
                {item.imageUrl ? (
                  <Image source={{ uri: item.imageUrl }} style={styles.thumb} resizeMode="cover" />
                ) : (
                  <View style={[styles.thumb, styles.thumbEmpty, { borderColor: colors.border }]}>
                    <MaterialIcons name="inventory-2" size={20} color={colors.muted} />
                  </View>
                )}
                <View style={styles.itemCopy}>
                  <Text style={[styles.itemName, { color: colors.foreground }]} numberOfLines={2}>{item.name}</Text>
                  <Text style={[styles.itemPrice, { color: colors.primary }]}>
                    {formatPrice(item.priceCents, ("currency" in item ? item.currency : "USD") ?? "USD")}
                  </Text>
                  {item.description ? <Text style={[styles.itemMeta, { color: colors.muted }]} numberOfLines={3}>{item.description}</Text> : null}
                </View>
              </View>
              {isMine && "archivedAt" in item && !item.archivedAt ? (
                <Pressable onPress={() => void archiveItem.mutate({ id: item.id })} style={styles.archiveLink}>
                  <Text style={[styles.actionText, { color: colors.error }]}>Remove from catalog</Text>
                </Pressable>
              ) : null}
            </View>
          ))}

          {!loading && items.length === 0 ? (
            <Text style={[styles.empty, { color: colors.muted }]}>
              {isMine
                ? "Nothing in your catalog yet. Add what you offer — a price is optional, and “Ask” is shown when there is none."
                : "This person has not listed anything."}
            </Text>
          ) : null}

          {isMine && items.length > 0 ? (
            <Text style={[styles.note, { color: colors.muted }]}>
              Removing an item archives it rather than deleting it, so anything already shared in a chat does not vanish from it.
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  primary: { borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 2 },
  primaryText: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "800" },
  itemRow: { flexDirection: "row", gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 12, overflow: "hidden" },
  thumbEmpty: { borderWidth: 1, alignItems: "center", justifyContent: "center" },
  itemCopy: { flex: 1 },
  itemName: { fontSize: 15, fontWeight: "800" },
  itemPrice: { fontSize: 13.5, fontWeight: "700", marginTop: 2 },
  itemMeta: { fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  archiveLink: { marginTop: 4 },
  actionText: { fontSize: 12.5, fontWeight: "700" },
  empty: { fontSize: 12.5, lineHeight: 18 },
  note: { fontSize: 11.5, lineHeight: 17, marginTop: 6 },
  error: { fontSize: 12.5, fontWeight: "700" },
});
