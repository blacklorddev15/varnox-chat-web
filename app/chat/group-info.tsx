import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, type ComponentProps } from "react";
import * as ImagePicker from "expo-image-picker";
import { ActivityIndicator, Alert, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { groupIconUrl, shortTime } from "@/lib/media-url";
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

type IconName = ComponentProps<typeof MaterialIcons>["name"];

/** One icon per event kind, so the log can be scanned without reading every line of it. */
const ACTIVITY_ICONS: Record<string, IconName> = {
  created: "group",
  "member-add": "person-add",
  "member-remove": "person-remove",
  "member-leave": "logout",
  "join-approved": "how-to-reg",
  "role-change": "admin-panel-settings",
  "icon-change": "photo-camera",
  "info-change": "edit",
};

/** Group settings: members, owner/admin roles, add and remove. */
export default function GroupInfoScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

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
  const setDescription = trpc.conversations.setDescription.useMutation();
  const leave = trpc.conversations.leave.useMutation();

  const myRole = membersQuery.data?.role ?? "member";
  const members = (membersQuery.data?.members ?? []) as Member[];
  const isOwner = myRole === "owner";
  const canManage = isOwner || myRole === "admin";
  const busy = setRole.isPending || removeMember.isPending || addMembers.isPending || setDescription.isPending || leave.isPending;
  const description = membersQuery.data?.description ?? null;

  // ---- group photo ------------------------------------------------------------------------
  const iconVersions = trpc.conversations.iconVersions.useQuery();
  const setIcon = trpc.conversations.setIcon.useMutation();
  const clearIcon = trpc.conversations.clearIcon.useMutation();
  const [iconBusy, setIconBusy] = useState(false);

  // Undefined means this group has no photo: iconVersions only lists conversations that have one,
  // so there is no "still loading" state to distinguish here.
  const iconUrl = groupIconUrl(
    conversationId,
    iconVersions.data?.find((row) => row.conversationId === conversationId)?.updatedAt ?? null,
  );

  /** Mirrors the server's ceiling, so an oversized pick is refused before anything is uploaded. */
  const MAX_ICON_BYTES = 4 * 1024 * 1024;

  const changeIcon = async () => {
    if (!canManage) return;
    setStatus(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus("Photo access is needed to choose a group photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        // Square, because a group photo is always rendered in a circle.
        allowsEditing: true,
        aspect: [1, 1],
        base64: true,
      });
      const asset = result.canceled ? null : result.assets?.[0];
      if (!asset?.base64) return;
      if (Math.floor((asset.base64.length * 3) / 4) > MAX_ICON_BYTES) {
        setStatus("That image is larger than 4 MB. Pick a smaller one.");
        return;
      }
      setIconBusy(true);
      await setIcon.mutateAsync({ conversationId, mimeType: asset.mimeType ?? "image/jpeg", data: asset.base64 });
      await iconVersions.refetch();
      setStatus("Group photo updated.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the group photo");
    } finally {
      setIconBusy(false);
    }
  };

  const removeIcon = async () => {
    if (!canManage) return;
    setIconBusy(true);
    try {
      await clearIcon.mutateAsync({ conversationId });
      await iconVersions.refetch();
      setStatus("Group photo removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove the group photo");
    } finally {
      setIconBusy(false);
    }
  };

  // ---- activity ---------------------------------------------------------------------------
  const activity = trpc.conversations.activity.useQuery({ conversationId }, { enabled: conversationId.length > 0 });

  /** One line per event, phrased from the reader's point of view. */
  const describeEvent = (event: { kind: string; actorName?: string | null; actorUsername?: string | null; targetUserId?: number | null; detail?: string | null }): string => {
    const who = event.actorName?.trim() || event.actorUsername || "Someone";
    // A target is shown by name when they are still a member, and by id when they have left.
    const targetMember = event.targetUserId ? members.find((member) => member.userId === event.targetUserId) : undefined;
    const target = targetMember ? label(targetMember) : event.targetUserId ? `user ${event.targetUserId}` : null;
    switch (event.kind) {
      case "member-add":
        return `${who} added ${target ?? "someone"}`;
      case "member-remove":
        return `${who} removed ${target ?? "someone"}`;
      case "member-leave":
        return `${who} left`;
      case "role-change":
        return `${who} made ${target ?? "someone"} ${event.detail ?? "an admin"}`;
      case "icon-change":
        return event.detail ? `${who} ${event.detail}` : `${who} changed the group photo`;
      case "info-change":
        return event.detail ? `${who} ${event.detail}` : `${who} updated the group`;
      case "created":
        return `${who} created this group`;
      default:
        return `${who} ${event.detail ?? "changed something"}`;
    }
  };

  const refresh = () => membersQuery.refetch();

  const saveDescription = async () => {
    try {
      await setDescription.mutateAsync({ conversationId, description: descriptionDraft.trim() || null });
      setEditingDescription(false);
      setStatus("Description updated.");
      refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the description");
    }
  };

  const leaveGroup = async () => {
    try {
      const outcome = await leave.mutateAsync({ conversationId });
      // Ownership passing to someone else is worth saying out loud: the leaver was the only one who
      // could manage the group until that moment.
      setStatus(outcome.transferredTo ? "You left the group. Ownership passed to another member." : "You left the group.");
      router.replace("/");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not leave the group");
    }
  };

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
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>{membersQuery.data?.title?.trim() || "Group info"}</Text>
        {busy ? <ActivityIndicator color={colors.primary} /> : null}
      </View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {membersQuery.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {membersQuery.error ? (
          <Text style={[styles.error, { color: "#EF4444" }]}>{membersQuery.error.message}</Text>
        ) : null}

        <Text style={[styles.section, { color: colors.muted }]}>GROUP PHOTO</Text>
        <View style={styles.photoRow}>
          {iconUrl ? (
            <Image source={{ uri: iconUrl }} style={styles.photo} />
          ) : (
            // Falls back to an icon rather than the group's initials: this screen does not have the
            // member list rendered as an avatar anywhere else, so initials here would be a new
            // invention rather than a match for how the group looks in the chat list.
            <View style={[styles.photo, styles.photoEmpty, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <MaterialIcons name="group" size={26} color={colors.muted} />
            </View>
          )}
          <View style={styles.photoActions}>
            <Pressable
              disabled={!canManage || iconBusy}
              onPress={() => void changeIcon()}
              style={[styles.action, { borderColor: colors.border, opacity: canManage ? 1 : 0.45 }]}
            >
              <Text style={[styles.actionText, { color: colors.primary }]}>
                {iconBusy ? "Working…" : iconUrl ? "Change photo" : "Add photo"}
              </Text>
            </Pressable>
            {iconUrl && canManage ? (
              <Pressable disabled={iconBusy} onPress={() => void removeIcon()} style={[styles.action, { borderColor: colors.border }]}>
                <Text style={[styles.actionText, { color: "#EF4444" }]}>Remove</Text>
              </Pressable>
            ) : null}
            {!canManage ? (
              <Text style={[styles.photoHint, { color: colors.muted }]}>Only admins can change the group photo.</Text>
            ) : null}
          </View>
        </View>

        <Text style={[styles.section, { color: colors.muted }]}>DESCRIPTION</Text>
        {editingDescription ? (
          <>
            <TextInput
              value={descriptionDraft}
              onChangeText={setDescriptionDraft}
              placeholder="What is this group about?"
              placeholderTextColor={colors.muted}
              multiline
              maxLength={255}
              style={[styles.descriptionInput, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]}
            />
            <View style={styles.descriptionActions}>
              <Pressable onPress={() => setEditingDescription(false)} style={[styles.action, { borderColor: colors.border }]}>
                <Text style={[styles.actionText, { color: colors.muted }]}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void saveDescription()} style={[styles.action, { borderColor: colors.border }]}>
                <Text style={[styles.actionText, { color: colors.primary }]}>Save</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Pressable
            onPress={() => {
              if (!canManage) return;
              setDescriptionDraft(description ?? "");
              setEditingDescription(true);
            }}
            style={[styles.descriptionBox, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Text style={[styles.descriptionText, { color: description ? colors.foreground : colors.muted }]}>
              {description || (canManage ? "Add a description" : "No description yet")}
            </Text>
            {canManage ? <MaterialIcons name="edit" size={16} color={colors.muted} /> : null}
          </Pressable>
        )}

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

        <Pressable
          onPress={() => router.push({ pathname: "/chat/group-settings", params: { conversationId } })}
          style={[styles.settingsRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <MaterialIcons name="admin-panel-settings" size={18} color={colors.primary} />
          <View style={styles.settingsCopy}>
            <Text style={[styles.settingsTitle, { color: colors.foreground }]}>Permissions and invite link</Text>
            <Text style={[styles.hint, { color: colors.muted }]}>Who can send, edit info and add people</Text>
          </View>
          <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
        </Pressable>

        <Pressable
          onPress={() => confirmThen("Leave this group? You will stop receiving its messages.", leaveGroup)}
          style={styles.leaveButton}
        >
          <MaterialIcons name="logout" size={18} color="#EF4444" />
          <Text style={styles.leaveText}>Leave group</Text>
        </Pressable>

        <Text style={[styles.section, { color: colors.muted }]}>RECENT ACTIVITY</Text>
        {activity.data?.length ? (
          activity.data.map((event) => (
            <View key={event.id} style={styles.activityRow}>
              <MaterialIcons name={ACTIVITY_ICONS[event.kind] ?? "history"} size={15} color={colors.muted} />
              <Text style={[styles.activityText, { color: colors.foreground }]}>{describeEvent(event)}</Text>
              <Text style={[styles.activityTime, { color: colors.muted }]}>{shortTime(event.createdAt)}</Text>
            </View>
          ))
        ) : activity.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={[styles.activityEmpty, { color: colors.muted }]}>
            Nothing has happened in this group yet. Members joining, leaving and role changes will be listed here.
          </Text>
        )}

        {status ? <Text style={[styles.error, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  settingsRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  settingsCopy: { flex: 1 },
  settingsTitle: { fontSize: 14, fontWeight: "700" },
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
  photoRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  photo: { width: 84, height: 84, borderRadius: 42, overflow: "hidden" },
  photoEmpty: { borderWidth: 1, alignItems: "center", justifyContent: "center" },
  photoActions: { flex: 1, gap: 8, alignItems: "flex-start" },
  photoHint: { fontSize: 11.5, lineHeight: 16 },
  activityRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(127,127,127,0.2)" },
  activityText: { flex: 1, fontSize: 13, lineHeight: 18 },
  activityTime: { fontSize: 11 },
  activityEmpty: { fontSize: 12.5, lineHeight: 18 },
  action: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 7 },
  actionText: { fontSize: 12, fontWeight: "800" },
  searchWrap: { height: 48, borderRadius: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderWidth: 1 },
  searchInput: { flex: 1, marginLeft: 9, fontSize: 15 },
  descriptionBox: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  descriptionText: { flex: 1, fontSize: 14, lineHeight: 20 },
  descriptionInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, minHeight: 76, textAlignVertical: "top" },
  descriptionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  leaveButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 34, borderWidth: 1, borderColor: "#EF4444", borderRadius: 14, paddingVertical: 13 },
  leaveText: { color: "#EF4444", fontSize: 14, fontWeight: "800" },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16, textAlign: "center" },
  error: { fontSize: 13, fontWeight: "700", marginTop: 16, textAlign: "center" },
});
