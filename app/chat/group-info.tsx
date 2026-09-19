import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

type Member = {
  userId: number;
  role: string;
  name?: string | null;
  username?: string | null;
};

function label(member: Member): string {
  return member.name?.trim() || member.username || `User ${member.userId}`;
}

function initialFor(member: Member): string {
  const text = label(member);
  const parts = text.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : text.slice(0, 2)).toUpperCase();
}

/** Group settings: members, owner/admin roles, add and remove. */
export default function GroupInfoScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const membersQuery = trpc.conversations.members.useQuery(
    { conversationId },
    { enabled: conversationId.length > 0 },
  );
  const peopleSearch = trpc.people.search.useQuery(
    { query: query.trim() },
    { enabled: query.trim().length >= 2 && conversationId.length > 0 },
  );
  const setRole = trpc.conversations.setRole.useMutation();
  const removeMember = trpc.conversations.removeMember.useMutation();
  const addMembers = trpc.conversations.addMembers.useMutation();

  const myRole = membersQuery.data?.role ?? "member";
  const members = (membersQuery.data?.members ?? []) as Member[];
  const isOwner = myRole === "owner";
  const canManage = isOwner || myRole === "admin";
  const busy = setRole.isPending || removeMember.isPending || addMembers.isPending;

  const refresh = () => membersQuery.refetch();

  const confirmThen = (message: string, action: () => Promise<void>) => {
    const run = async () => {
      setStatus(null);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : "Something went wrong.");
      }
    };
    // react-native-web has no Alert implementation, so fall back to the browser confirm.
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && !window.confirm(message)) return;
      void run();
      return;
    }
    Alert.alert(message, undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", style: "destructive", onPress: () => { void run(); } },
    ]);
  };

  const candidates = (peopleSearch.data ?? []).filter(
    (person) => !members.some((member) => member.userId === person.id),
  );

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Group info</Text>
        {busy ? <ActivityIndicator color={colors.primary} /> : null}
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {membersQuery.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {membersQuery.error ? (
          <Text style={[styles.error, { color: "#EF4444" }]}>{membersQuery.error.message}</Text>
        ) : null}

        <Text style={[styles.section, { color: colors.muted }]}>
          {members.length} {members.length === 1 ? "MEMBER" : "MEMBERS"}
        </Text>

        {members.map((member) => {
          const isTargetOwner = member.role === "owner";
          const isTargetAdmin = member.role === "admin";
          // The owner manages admins; an admin may only remove plain members.
          const canRemove = !isTargetOwner && (isOwner || (myRole === "admin" && member.role === "member"));
          return (
            <View key={member.userId} style={[styles.memberRow, { borderBottomColor: colors.border }]}>
              <View style={[styles.avatar, { backgroundColor: colors.surface }]}>
                <Text style={[styles.avatarText, { color: colors.primary }]}>{initialFor(member)}</Text>
              </View>
              <View style={styles.copy}>
                <Text style={[styles.name, { color: colors.foreground }]}>{label(member)}</Text>
                <Text style={[styles.role, { color: isTargetOwner ? colors.primary : colors.muted }]}>
                  {isTargetOwner ? "Owner" : isTargetAdmin ? "Admin" : "Member"}
                </Text>
              </View>

              {isOwner && !isTargetOwner ? (
                <Pressable
                  onPress={() =>
                    confirmThen(
                      isTargetAdmin
                        ? `Dismiss ${label(member)} as admin?`
                        : `Make ${label(member)} an admin?`,
                      async () => {
                        await setRole.mutateAsync({
                          conversationId,
                          userId: member.userId,
                          role: isTargetAdmin ? "member" : "admin",
                        });
                      },
                    )
                  }
                  style={[styles.action, { borderColor: colors.border }]}
                >
                  <Text style={[styles.actionText, { color: colors.primary }]}>
                    {isTargetAdmin ? "Dismiss admin" : "Make admin"}
                  </Text>
                </Pressable>
              ) : null}

              {canRemove ? (
                <Pressable
                  onPress={() =>
                    confirmThen(`Remove ${label(member)} from the group?`, async () => {
                      await removeMember.mutateAsync({ conversationId, userId: member.userId });
                    })
                  }
                  style={[styles.action, { borderColor: colors.border }]}
                >
                  <Text style={[styles.actionText, { color: "#EF4444" }]}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {canManage ? (
          <>
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

            {candidates.map((person) => (
              <View key={person.id} style={[styles.memberRow, { borderBottomColor: colors.border }]}>
                <View style={styles.copy}>
                  <Text style={[styles.name, { color: colors.foreground }]}>
                    {person.name?.trim() || person.username}
                  </Text>
                  {person.username ? (
                    <Text style={[styles.role, { color: colors.muted }]}>@{person.username}</Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() =>
                    confirmThen(`Add ${person.name?.trim() || person.username} to the group?`, async () => {
                      await addMembers.mutateAsync({ conversationId, userIds: [person.id] });
                      setQuery("");
                    })
                  }
                  style={[styles.action, { borderColor: colors.border }]}
                >
                  <Text style={[styles.actionText, { color: colors.primary }]}>Add</Text>
                </Pressable>
              </View>
            ))}

            {query.trim().length >= 2 && !peopleSearch.isFetching && candidates.length === 0 ? (
              <Text style={[styles.hint, { color: colors.muted }]}>Nobody new found with that name.</Text>
            ) : null}
          </>
        ) : (
          <Text style={[styles.hint, { color: colors.muted }]}>
            Only the owner and admins can add or remove members.
          </Text>
        )}

        {status ? <Text style={[styles.error, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { padding: 20, paddingBottom: 60 },
  section: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginTop: 22, marginBottom: 8 },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 14, fontWeight: "800" },
  copy: { flex: 1 },
  name: { fontSize: 15, fontWeight: "700" },
  role: { fontSize: 12, marginTop: 3, fontWeight: "600" },
  action: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 7 },
  actionText: { fontSize: 12, fontWeight: "800" },
  searchWrap: { height: 48, borderRadius: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderWidth: 1 },
  searchInput: { flex: 1, marginLeft: 9, fontSize: 15 },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
  error: { fontSize: 13, fontWeight: "700", marginTop: 16, textAlign: "center" },
});
