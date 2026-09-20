import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { OfflineBanner } from "@/components/offline-banner";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { useCall } from "@/lib/call-context";
import { isOnline, OFFLINE_CALL_MESSAGE } from "@/lib/offline";
import { avatarUrl, shortTime } from "@/lib/media-url";

function initialsOf(name: string) {
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return initials || "?";
}

function labelFor(call: { outgoing: boolean; status: string }) {
  if (call.status === "declined") return "Declined";
  if (call.status === "missed") return "Missed";
  if (call.status === "ringing") return call.outgoing ? "Ringing…" : "Incoming";
  return call.outgoing ? "Outgoing" : "Incoming";
}

export default function CallsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { startCall } = useCall();
  const [toast, setToast] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  };

  const history = trpc.calls.history.useQuery({ limit: 30 });
  const createLink = trpc.calls.createLink.useMutation();

  const refetchHistory = history.refetch;
  useFocusEffect(useCallback(() => { void refetchHistory(); }, [refetchHistory]));

  const makeLink = async () => {
    // A link is minted on the server, so it needs a connection. Pressing through would leave the
    // button stuck on "Creating…" because the mutation pauses rather than fails while offline.
    if (!isOnline()) { notify(OFFLINE_CALL_MESSAGE); return; }
    try {
      const created = await createLink.mutateAsync({ kind: "audio" });
      const base = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "";
      const url = `${base}/call/${created.room}`;
      setLink(url);
      notify("Call link ready - anyone signed in can join");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not create a call link.");
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(link);
        notify("Link copied");
        return;
      }
    } catch {
      // fall through to showing it
    }
    notify("Copy the link from the card above");
  };

  const rows = history.data ?? [];

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>KEEP IN TOUCH</Text>
          <Text style={[styles.heading, { color: colors.foreground }]}>Calls</Text>
        </View>
        <Pressable onPress={makeLink} disabled={createLink.isPending} style={({ pressed }) => [styles.newCallButton, { backgroundColor: colors.primary }, (pressed || createLink.isPending) && styles.pressed]}>
          <MaterialIcons name="add-link" size={18} color="#FFFFFF" />
          <Text style={styles.newCallText}>{createLink.isPending ? "Creating…" : "Create link"}</Text>
        </Pressable>
      </View>

      <OfflineBanner />

      <View style={[styles.callCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={[styles.callCardIcon, { backgroundColor: "rgba(16,185,129,0.14)" }]}>
          <MaterialIcons name="link" size={23} color={colors.success} />
        </View>
        <View style={styles.callCardCopy}>
          <Text style={[styles.callCardTitle, { color: colors.foreground }]}>{link ? "Your call link" : "Share a call link"}</Text>
          <Text style={[styles.callCardSubtitle, { color: colors.muted }]} numberOfLines={link ? 2 : 1}>
            {link ?? "Anyone signed in can join with a link"}
          </Text>
        </View>
        {link ? (
          <View style={styles.linkActions}>
            <Pressable onPress={copyLink} style={({ pressed }) => [styles.linkButton, { borderColor: colors.border }, pressed && styles.pressed]}>
              <MaterialIcons name="content-copy" size={17} color={colors.foreground} />
            </Pressable>
            <Pressable onPress={() => router.push({ pathname: "/call/[room]", params: { room: link.split("/").pop() ?? "" } })} style={({ pressed }) => [styles.linkButton, { backgroundColor: colors.primary, borderColor: colors.primary }, pressed && styles.pressed]}>
              <MaterialIcons name="call" size={17} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : (
          <MaterialIcons name="chevron-right" size={22} color={colors.muted} />
        )}
      </View>

      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent</Text>

      {history.isLoading ? <ActivityIndicator color={colors.primary} style={styles.loading} /> : null}
      {!history.isLoading && rows.length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No calls yet.</Text> : null}

      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          // The person, then the conversation. A one-to-one has no title, so preferring the title
          // meant every such row said "Call" for somebody the server had just told us about.
          const name = item.peerName ?? item.conversationTitle ?? "Call";
          const photo = item.peerId ? avatarUrl(item.peerId, item.peerAvatarUpdatedAt) : undefined;
          const bad = item.status === "missed" || item.status === "declined";
          return (
            <Pressable
              onPress={() => { if (!isOnline()) { notify(OFFLINE_CALL_MESSAGE); return; } void startCall({ conversationId: item.conversationId, kind: item.kind === "video" ? "video" : "audio", peerName: name, peerId: item.peerId, avatarUpdatedAt: item.peerAvatarUpdatedAt }); }}
              style={({ pressed }) => [styles.callRow, pressed && styles.pressed]}
            >
              {/* Passing the peer on is also what puts their face on the call screen when you tap
                  the row to ring them back, instead of a bare circle with their initials. */}
              {photo ? (
                <Image source={{ uri: photo }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
                  <Text style={styles.avatarText}>{initialsOf(name)}</Text>
                </View>
              )}
              <View style={[styles.callCopy, { borderBottomColor: colors.border }]}>
                <Text style={[styles.callName, { color: bad ? colors.error : colors.foreground }]} numberOfLines={1}>{name}</Text>
                <View style={styles.callMeta}>
                  <MaterialIcons name={item.outgoing ? "call-made" : "call-received"} size={15} color={bad ? colors.error : colors.success} />
                  <Text style={[styles.callTime, { color: colors.muted }]}>{labelFor(item)} · {shortTime(item.startedAt)}</Text>
                </View>
              </View>
              <MaterialIcons name={item.kind === "video" ? "videocam" : "call"} size={22} color={colors.primary} />
            </Pressable>
          );
        }}
      />

      {toast ? (
        <View style={[styles.toast, { backgroundColor: colors.foreground }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 },
  heading: { fontSize: 32, lineHeight: 38, fontWeight: "800", letterSpacing: -1 },
  newCallButton: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14 },
  newCallText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  pressed: { opacity: 0.7 },
  callCard: { flexDirection: "row", alignItems: "center", gap: 13, marginHorizontal: 20, padding: 14, borderRadius: 18, borderWidth: 1 },
  callCardIcon: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  callCardCopy: { flex: 1 },
  callCardTitle: { fontSize: 15, fontWeight: "800" },
  callCardSubtitle: { fontSize: 12, marginTop: 3 },
  linkActions: { flexDirection: "row", gap: 8 },
  linkButton: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 16, fontWeight: "800", paddingHorizontal: 22, paddingTop: 24, paddingBottom: 8 },
  loading: { marginTop: 14 },
  empty: { fontSize: 13, paddingHorizontal: 22 },
  list: { paddingBottom: 30 },
  callRow: { flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 18, minHeight: 72 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  callCopy: { flex: 1, marginLeft: 13, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  callName: { fontSize: 15, fontWeight: "800" },
  callMeta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  callTime: { fontSize: 11, fontWeight: "600" },
  toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, alignItems: "center" },
  toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
});
