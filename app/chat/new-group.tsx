import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

type Person = { id: number; name?: string | null; username?: string | null };

function initialOf(person: Person): string {
  const label = person.name?.trim() || person.username || "?";
  const parts = label.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2)).toUpperCase();
}

export default function NewGroupScreen() {
  const colors = useColors();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);

  const peopleSearch = trpc.people.search.useQuery(
    { query: query.trim() },
    { enabled: query.trim().length >= 2 },
  );
  const createGroup = trpc.conversations.createGroup.useMutation();
  const busy = createGroup.isPending;

  const toggle = (person: Person) => {
    setSelected((current) =>
      current.some((item) => item.id === person.id)
        ? current.filter((item) => item.id !== person.id)
        : [...current, person],
    );
  };

  const create = async () => {
    setError(null);
    const name = title.trim();
    if (!name) {
      setError("Give the group a name first.");
      return;
    }
    try {
      const result = await createGroup.mutateAsync({ title: name, memberIds: selected.map((item) => item.id) });
      // Open the new group in the chats screen (it reads the conversationId param).
      router.replace({ pathname: "/", params: { conversationId: result.conversationId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the group.");
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="close" size={23} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>New group</Text>
        <Pressable onPress={create} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={[styles.create, { color: title.trim() ? colors.primary : colors.muted }]}>Create</Text>
          )}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.groupAvatar, { backgroundColor: colors.primary }]}>
          <MaterialIcons name="groups" size={30} color="#fff" />
        </View>

        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Group name"
          placeholderTextColor={colors.muted}
          maxLength={80}
          style={[styles.nameInput, { color: colors.foreground, borderBottomColor: colors.border }]}
        />

        {selected.length > 0 ? (
          <View style={styles.chips}>
            {selected.map((person) => (
              <Pressable
                key={person.id}
                onPress={() => toggle(person)}
                style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <Text style={[styles.chipText, { color: colors.foreground }]}>
                  {person.name?.trim() || person.username || `User ${person.id}`}
                </Text>
                <MaterialIcons name="close" size={14} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <Text style={[styles.section, { color: colors.muted }]}>ADD MEMBERS</Text>
        <View style={[styles.searchWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <MaterialIcons name="search" size={19} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search people by name or username"
            placeholderTextColor={colors.muted}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
        </View>

        {query.trim().length > 0 && query.trim().length < 2 ? (
          <Text style={[styles.hint, { color: colors.muted }]}>Type at least two characters.</Text>
        ) : null}
        {peopleSearch.isFetching ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}

        {(peopleSearch.data ?? []).map((person) => {
          const chosen = selected.some((item) => item.id === person.id);
          return (
            <Pressable
              key={person.id}
              onPress={() => toggle(person)}
              style={[styles.personRow, { borderBottomColor: colors.border }]}
            >
              <View style={[styles.personAvatar, { backgroundColor: colors.surface }]}>
                <Text style={[styles.personInitial, { color: colors.primary }]}>{initialOf(person)}</Text>
              </View>
              <View style={styles.personCopy}>
                <Text style={[styles.personName, { color: colors.foreground }]}>
                  {person.name?.trim() || person.username}
                </Text>
                {person.username ? (
                  <Text style={[styles.personHandle, { color: colors.muted }]}>@{person.username}</Text>
                ) : null}
              </View>
              <MaterialIcons
                name={chosen ? "check-circle" : "radio-button-unchecked"}
                size={22}
                color={chosen ? colors.primary : colors.border}
              />
            </Pressable>
          );
        })}

        {query.trim().length >= 2 && !peopleSearch.isFetching && (peopleSearch.data ?? []).length === 0 ? (
          <Text style={[styles.hint, { color: colors.muted }]}>Nobody found with that name.</Text>
        ) : null}

        {error ? <Text style={[styles.error, { color: "#EF4444" }]}>{error}</Text> : null}

        <Text style={[styles.hint, { color: colors.muted }]}>
          You will be the group owner and can add admins once it exists.
        </Text>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  create: { fontSize: 14, fontWeight: "800" },
  content: { padding: 24, paddingBottom: 60 },
  groupAvatar: { width: 84, height: 84, borderRadius: 42, alignSelf: "center", alignItems: "center", justifyContent: "center", marginBottom: 24 },
  nameInput: { height: 52, borderBottomWidth: 1, fontSize: 18, textAlign: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 18 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { fontSize: 12, fontWeight: "700" },
  section: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginTop: 30, marginBottom: 10 },
  searchWrap: { height: 48, borderRadius: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderWidth: 1 },
  searchInput: { flex: 1, marginLeft: 9, fontSize: 15 },
  spinner: { marginTop: 18 },
  personRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  personAvatar: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  personInitial: { fontSize: 14, fontWeight: "800" },
  personCopy: { flex: 1 },
  personName: { fontSize: 15, fontWeight: "700" },
  personHandle: { fontSize: 12, marginTop: 3 },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
  error: { fontSize: 13, fontWeight: "700", marginTop: 16, textAlign: "center" },
});
