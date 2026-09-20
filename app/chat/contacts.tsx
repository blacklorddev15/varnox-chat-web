import { useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Names you keep for people, and nobody else sees.
 *
 * Separate from the name on somebody's account: renaming a person here changes your list only. That
 * is the entire point of a contact list, and it is why this is a table of its own rather than a
 * column on users.
 */
export default function ContactsScreen() {
  const colors = useColors();
  const router = useRouter();

  const contacts = trpc.contacts.list.useQuery();
  const setName = trpc.contacts.setName.useMutation({ onSuccess: () => contacts.refetch() });
  const removeContact = trpc.contacts.remove.useMutation({ onSuccess: () => contacts.refetch() });

  const [query, setQuery] = useState("");
  // Which row is being renamed, and the text in its box. Only one at a time: two open editors would
  // mean two Save buttons whose effects are hard to reason about.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const search = trpc.people.search.useQuery({ query }, { enabled: query.trim().length >= 2 });
  const saved = contacts.data ?? [];
  const savedIds = new Set(saved.map((row) => row.targetId));

  /**
   * People from search, minus anybody already named.
   *
   * Also minus yourself: naming yourself is not a contact, and the server refuses it too.
   */
  const suggestions = (search.data ?? []).filter((person) => !savedIds.has(person.id));

  const save = async (targetId: number, displayName: string) => {
    setError(null);
    try {
      await setName.mutateAsync({ targetId, displayName });
      setEditingId(null);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That name could not be saved");
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Contacts</Text>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={[styles.searchWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <MaterialIcons name="search" size={19} color={colors.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Find someone to name"
              placeholderTextColor={colors.muted}
              style={[styles.searchInput, { color: colors.foreground }]}
              autoCapitalize="none"
            />
          </View>

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          {/* Suggestions first, because naming somebody new is why people open this screen. */}
          {query.trim().length >= 2 ? (
            <>
              <Text style={[styles.section, { color: colors.muted }]}>ADD FROM SEARCH</Text>
              {search.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
              {suggestions.map((person) => (
                <View key={person.id} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <View style={styles.rowCopy}>
                    <Text style={[styles.rowTitle, { color: colors.foreground }]}>{person.name ?? person.username ?? `User ${person.id}`}</Text>
                    {person.username ? <Text style={[styles.rowSub, { color: colors.muted }]}>@{person.username}</Text> : null}
                  </View>
                  <Pressable
                    onPress={() => {
                      setEditingId(person.id);
                      setDraft(person.name ?? person.username ?? "");
                    }}
                    style={[styles.action, { borderColor: colors.primary }]}
                  >
                    <Text style={[styles.actionText, { color: colors.primary }]}>Name</Text>
                  </Pressable>
                </View>
              ))}
              {!search.isLoading && suggestions.length === 0 ? (
                <Text style={[styles.empty, { color: colors.muted }]}>Nobody new matches “{query.trim()}”.</Text>
              ) : null}
            </>
          ) : null}

          <Text style={[styles.section, { color: colors.muted }]}>SAVED ({saved.length})</Text>
          {contacts.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
          {saved.map((row) => (
            <View key={row.targetId} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>{row.displayName}</Text>
                <Text style={[styles.rowSub, { color: colors.muted }]}>
                  {/* The account name is shown underneath, so it is obvious which is yours and
                      which belongs to them. */}
                  {row.name ?? row.username ?? `User ${row.targetId}`} · your name for them
                </Text>
              </View>
              <Pressable onPress={() => { setEditingId(row.targetId); setDraft(row.displayName); }} style={[styles.action, { borderColor: colors.border }]}>
                <Text style={[styles.actionText, { color: colors.foreground }]}>Rename</Text>
              </Pressable>
              <Pressable onPress={() => void removeContact.mutate({ targetId: row.targetId })} style={[styles.action, { borderColor: colors.border }]}>
                <Text style={[styles.actionText, { color: colors.error }]}>Remove</Text>
              </Pressable>
            </View>
          ))}
          {!contacts.isLoading && saved.length === 0 ? (
            <Text style={[styles.empty, { color: colors.muted }]}>
              No saved contacts yet. Search above to give somebody a name only you will see.
            </Text>
          ) : null}
        </ScrollView>

        {editingId !== null ? (
          <View style={[styles.editor, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Their name in your list"
              placeholderTextColor={colors.muted}
              autoFocus
              maxLength={80}
              style={[styles.editorInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]}
            />
            <Pressable
              disabled={!draft.trim() || setName.isPending}
              onPress={() => void save(editingId, draft)}
              style={[styles.editorButton, { backgroundColor: colors.primary, opacity: !draft.trim() || setName.isPending ? 0.5 : 1 }]}
            >
              <Text style={styles.editorButtonText}>{setName.isPending ? "Saving…" : "Save"}</Text>
            </Pressable>
            <Pressable onPress={() => { setEditingId(null); setDraft(""); }} style={styles.editorCancel}>
              <Text style={[styles.actionText, { color: colors.muted }]}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingHorizontal: 14, borderWidth: 1, borderRadius: 14 },
  searchInput: { flex: 1, fontSize: 15 },
  section: { fontSize: 11, fontWeight: "800", letterSpacing: 1.1, marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 14, padding: 12 },
  rowCopy: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: "800" },
  rowSub: { fontSize: 11.5, marginTop: 2 },
  action: { borderWidth: 1, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 6 },
  actionText: { fontSize: 12, fontWeight: "700" },
  empty: { fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  error: { fontSize: 12.5, fontWeight: "700", marginTop: 4 },
  editor: { flexDirection: "row", alignItems: "center", gap: 8, padding: 14, borderTopWidth: StyleSheet.hairlineWidth },
  editorInput: { flex: 1, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  editorButton: { borderRadius: 12, paddingHorizontal: 18, paddingVertical: 11 },
  editorButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  editorCancel: { paddingHorizontal: 6, paddingVertical: 11 },
});
