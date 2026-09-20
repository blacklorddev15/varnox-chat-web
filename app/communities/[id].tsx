import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * One community: its groups, and the people across all of them.
 *
 * Adding a group needs two permissions at once - being able to manage the community, and being an admin
 * of the group being added - because it exposes that group to everybody else in the community.
 */
export default function CommunityDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const communityId = typeof params.id === "string" ? params.id : "";
  const [status, setStatus] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const detail = trpc.communities.detail.useQuery({ communityId }, { enabled: communityId.length > 0 });
  const conversations = trpc.conversations.list.useQuery();
  const linkGroup = trpc.communities.linkGroup.useMutation();
  const unlinkGroup = trpc.communities.unlinkGroup.useMutation();
  const removeCommunity = trpc.communities.remove.useMutation();

  const linkedIds = new Set((detail.data?.groups ?? []).map((group) => group.id));
  // Only groups the person runs can be added, because adding one publishes it to the community.
  const candidates = (conversations.data ?? []).filter((row) => row.kind === "group" && !linkedIds.has(row.id));

  const add = async (conversationId: string) => {
    try {
      await linkGroup.mutateAsync({ communityId, conversationId });
      await detail.refetch();
      setPicking(false);
      setStatus("Group added to the community");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not add that group");
    }
  };

  const drop = async (conversationId: string) => {
    try {
      await unlinkGroup.mutateAsync({ communityId, conversationId });
      await detail.refetch();
      setStatus("Group removed from the community");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not remove that group");
    }
  };

  const dissolve = async () => {
    try {
      await removeCommunity.mutateAsync({ communityId });
      await router.back();
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not delete this community");
    }
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {detail.data?.name ?? "Community"}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {detail.isLoading ? <ActivityIndicator color={colors.primary} /> : null}

        {detail.data ? (
          <>
            <Text style={[styles.hint, { color: colors.muted }]}>
              {detail.data.description?.trim() || "No description"} · {detail.data.groups.length} {detail.data.groups.length === 1 ? "group" : "groups"} ·{" "}
              {detail.data.members.length} {detail.data.members.length === 1 ? "person" : "people"}
            </Text>

            <Text style={[styles.section, { color: colors.muted }]}>GROUPS</Text>
            {detail.data.groups.map((group) => (
              <View key={group.id} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <MaterialIcons name="group" size={19} color={colors.primary} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
                  {group.title?.trim() || "Untitled group"}
                </Text>
                {detail.data?.canManage ? (
                  <Pressable onPress={() => void drop(group.id)} style={[styles.smallButton, { borderColor: colors.border }]}>
                    <Text style={[styles.smallText, { color: colors.error ?? "#DC2626" }]}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
            {detail.data.groups.length === 0 ? (
              <Text style={[styles.hint, { color: colors.muted }]}>No groups yet. Add one and everyone in it joins the community.</Text>
            ) : null}

            {detail.data.canManage ? (
              picking ? (
                <>
                  <Text style={[styles.section, { color: colors.muted }]}>ADD A GROUP</Text>
                  {candidates.map((group) => (
                    <Pressable key={group.id} onPress={() => void add(group.id)} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                      <MaterialIcons name="add-circle-outline" size={19} color={colors.primary} />
                      <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
                        {group.title?.trim() || "Untitled group"}
                      </Text>
                    </Pressable>
                  ))}
                  {candidates.length === 0 ? <Text style={[styles.hint, { color: colors.muted }]}>Every group you are in is already here.</Text> : null}
                </>
              ) : (
                <Pressable onPress={() => setPicking(true)} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
                  <Text style={styles.primaryText}>Add a group</Text>
                </Pressable>
              )
            ) : null}

            <Text style={[styles.section, { color: colors.muted }]}>PEOPLE</Text>
            {detail.data.members.map((member) => (
              <View key={member.userId} style={styles.personRow}>
                <MaterialIcons name="person" size={16} color={colors.muted} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]} numberOfLines={1}>
                  {member.name}
                </Text>
              </View>
            ))}

            {detail.data.isOwner ? (
              <Pressable onPress={() => void dissolve()} style={[styles.dangerButton, { borderColor: colors.border }]}>
                <MaterialIcons name="delete-outline" size={18} color={colors.error ?? "#DC2626"} />
                <Text style={[styles.smallText, { color: colors.error ?? "#DC2626" }]}>Delete this community</Text>
              </Pressable>
            ) : null}

            <Text style={[styles.hint, { color: colors.muted }]}>
              Deleting a community only removes the grouping. The groups and their messages stay exactly as they are.
            </Text>
          </>
        ) : null}

        {status ? <Text style={[styles.hint, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 8, paddingBottom: 40 },
  hint: { fontSize: 12.5, lineHeight: 18 },
  section: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 12, padding: 12 },
  rowTitle: { flex: 1, fontSize: 14, fontWeight: "600" },
  personRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 5 },
  smallButton: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  smallText: { fontSize: 12.5, fontWeight: "700" },
  primaryButton: { borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 6 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  dangerButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderRadius: 12, paddingVertical: 12, marginTop: 16 },
});
