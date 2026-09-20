import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

type Picked = { userId: number; name: string };

/**
 * Broadcast lists: one message, delivered as an ordinary direct message to each person on the list.
 *
 * Nobody on the list can tell it went to anybody else, which is the feature. The screen says that out
 * loud, because "broadcast" suggests otherwise and somebody planning an announcement should know they
 * are sending individual messages.
 */
export default function BroadcastsScreen() {
  const colors = useColors();
  const router = useRouter();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [draft, setDraft] = useState("");
  const [openListId, setOpenListId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const lists = trpc.broadcasts.list.useQuery();
  const results = trpc.people.search.useQuery({ query: query.trim() }, { enabled: query.trim().length >= 2 });
  const create = trpc.broadcasts.create.useMutation();
  const remove = trpc.broadcasts.remove.useMutation();
  const send = trpc.broadcasts.send.useMutation();
  const utils = trpc.useUtils();

  const add = (person: { id: number; name?: string | null; username?: string | null }) =>
    setPicked((current) => (current.some((entry) => entry.userId === person.id) ? current : [...current, { userId: person.id, name: person.name?.trim() || person.username || `User ${person.id}` }]));

  const createList = async () => {
    if (name.trim().length === 0 || picked.length === 0) {
      setStatus("Give the list a name and pick at least one person");
      return;
    }
    setWorking(true);
    try {
      await create.mutateAsync({ name: name.trim(), memberIds: picked.map((entry) => entry.userId) });
      await lists.refetch();
      setName("");
      setPicked([]);
      setQuery("");
      setStatus("List created");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not create that list");
    }
    setWorking(false);
  };

  const sendToList = async (listId: string) => {
    if (draft.trim().length === 0) {
      setStatus("Type a message first");
      return;
    }
    setWorking(true);
    try {
      const result = await send.mutateAsync({ listId, body: draft.trim() });
      setDraft("");
      setOpenListId(null);
      await utils.conversations.list.invalidate();
      setStatus(
        result.failed.length === 0
          ? `Sent to ${result.delivered} ${result.delivered === 1 ? "person" : "people"}`
          : `Sent to ${result.delivered}, could not reach ${result.failed.length} (blocked or unreachable)`,
      );
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not send that message");
    }
    setWorking(false);
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Broadcast lists</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.hint, { color: colors.muted }]}>
          Each person receives an ordinary message and cannot see who else is on the list.
        </Text>

        {(lists.data ?? []).map((list) => (
          <View key={list.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{list.name}</Text>
              <Text style={[styles.hint, { color: colors.muted }]}>
                {list.recipients.length} {list.recipients.length === 1 ? "person" : "people"} · {list.recipients.map((entry) => entry.name).slice(0, 3).join(", ")}
                {list.recipients.length > 3 ? "…" : ""}
              </Text>
            </View>
            {openListId === list.id ? (
              <View style={styles.sendRow}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder={`Message to ${list.name}`}
                  placeholderTextColor={colors.muted}
                  style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                />
                <Pressable onPress={() => void sendToList(list.id)} disabled={working} style={[styles.primarySmall, { backgroundColor: colors.primary }]}>
                  <MaterialIcons name="send" size={17} color="#FFFFFF" />
                </Pressable>
              </View>
            ) : (
              <View style={styles.row}>
                <Pressable onPress={() => { setOpenListId(list.id); setDraft(""); }} style={[styles.smallButton, { borderColor: colors.border }]}>
                  <MaterialIcons name="send" size={15} color={colors.primary} />
                  <Text style={[styles.smallText, { color: colors.primary }]}>Send</Text>
                </Pressable>
                <Pressable
                  onPress={() => void remove.mutateAsync({ listId: list.id }).then(() => lists.refetch()).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not remove that list"))}
                  style={[styles.smallButton, { borderColor: colors.border }]}
                >
                  <MaterialIcons name="delete-outline" size={15} color={colors.error ?? "#DC2626"} />
                  <Text style={[styles.smallText, { color: colors.error ?? "#DC2626" }]}>Delete</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}

        {lists.isLoading ? <ActivityIndicator color={colors.primary} /> : null}

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>New list</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="List name"
            placeholderTextColor={colors.muted}
            maxLength={64}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          />

          {picked.length > 0 ? (
            <View style={styles.chips}>
              {picked.map((entry) => (
                <Pressable key={entry.userId} onPress={() => setPicked((current) => current.filter((item) => item.userId !== entry.userId))} style={[styles.chip, { borderColor: colors.border }]}>
                  <Text style={[styles.chipText, { color: colors.primary }]}>{entry.name}</Text>
                  <MaterialIcons name="close" size={13} color={colors.primary} />
                </Pressable>
              ))}
            </View>
          ) : null}

          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search people by name or username"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          {(results.data ?? []).slice(0, 8).map((person) => (
            <Pressable key={person.id} onPress={() => add(person)} style={[styles.resultRow, { borderTopColor: colors.border }]}>
              <MaterialIcons name="person-add" size={17} color={colors.primary} />
              <Text style={[styles.resultText, { color: colors.foreground }]}>{person.name?.trim() || person.username || `User ${person.id}`}</Text>
            </Pressable>
          ))}

          <Pressable onPress={() => void createList()} disabled={working} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
            <Text style={styles.primaryText}>Create list</Text>
          </Pressable>
        </View>

        {status ? <Text style={[styles.hint, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  hint: { fontSize: 12.5, lineHeight: 18 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  cardHead: { gap: 3 },
  cardTitle: { fontSize: 14.5, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8 },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  smallButton: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 7 },
  smallText: { fontSize: 12.5, fontWeight: "700" },
  primarySmall: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13.5, flex: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 14, paddingHorizontal: 9, paddingVertical: 5 },
  chipText: { fontSize: 12, fontWeight: "700" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 9, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  resultText: { fontSize: 13.5, fontWeight: "600" },
  primaryButton: { borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
