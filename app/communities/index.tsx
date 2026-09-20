import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Communities: a name over a set of existing groups.
 *
 * Membership is worked out from the groups linked to it rather than kept in a separate roster, so the
 * screen says "whoever is in these groups" because that is literally true - there is nothing else to join.
 */
export default function CommunitiesScreen() {
  const colors = useColors();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const communities = trpc.communities.list.useQuery();
  const create = trpc.communities.create.useMutation();

  const submit = async () => {
    if (name.trim().length === 0) {
      setStatus("Give the community a name");
      return;
    }
    try {
      const created = await create.mutateAsync({ name: name.trim(), description: description.trim() || undefined });
      await communities.refetch();
      setName("");
      setDescription("");
      router.push({ pathname: "/communities/[id]", params: { id: created.id } });
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not create that community");
    }
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Communities</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={[styles.hint, { color: colors.muted }]}>
          A community gathers groups you already have. Everyone in those groups can see the community; nobody has to accept a second invitation.
        </Text>

        {(communities.data ?? []).map((community) => (
          <Pressable
            key={community.id}
            onPress={() => router.push({ pathname: "/communities/[id]", params: { id: community.id } })}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <MaterialIcons name="diversity-3" size={22} color={colors.primary} />
            <View style={styles.copy}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{community.name}</Text>
              <Text style={[styles.hint, { color: colors.muted }]}>
                {community.description?.trim() || "No description"}
                {community.isOwner ? " · you created it" : ""}
              </Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
          </Pressable>
        ))}

        {communities.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {!communities.isLoading && (communities.data ?? []).length === 0 ? (
          <Text style={[styles.hint, { color: colors.muted }]}>No communities yet. One becomes visible here once a group you are in is added to it.</Text>
        ) : null}

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>New community</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Community name"
            placeholderTextColor={colors.muted}
            maxLength={80}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What is it for? (optional)"
            placeholderTextColor={colors.muted}
            maxLength={255}
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <Pressable onPress={() => void submit()} disabled={create.isPending} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
            <Text style={styles.primaryText}>Create community</Text>
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
  card: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 14 },
  copy: { flex: 1 },
  cardTitle: { fontSize: 14.5, fontWeight: "700" },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13.5 },
  primaryButton: { borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
