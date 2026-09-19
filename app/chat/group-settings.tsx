import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/** Where an invite link points when the app cannot tell its own origin, which is the native shell. */
const PUBLIC_WEB_ORIGIN = "https://varnox-chat-web.vercel.app";

function inviteUrl(code: string): string {
  const origin = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : PUBLIC_WEB_ORIGIN;
  return `${origin}/join/${code}`;
}

type PermissionKey = "whoCanSend" | "whoCanEditInfo" | "whoCanAddMembers";

const PERMISSIONS: { key: PermissionKey; title: string; hint: string }[] = [
  { key: "whoCanSend", title: "Send messages", hint: "Who can post in this group" },
  { key: "whoCanEditInfo", title: "Edit group info", hint: "Name, description and photo" },
  { key: "whoCanAddMembers", title: "Add members", hint: "Who can bring new people in" },
];

/**
 * Group permissions and invite links.
 *
 * Members who are not admins still see the settings, so they know why the composer is closed or why
 * a button is missing, but the controls are read-only for them and the invite section is not drawn at
 * all - the server refuses those calls, and a control that only ever errors would be worse than none.
 */
export default function GroupSettingsScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";

  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const settings = trpc.conversations.settings.useQuery({ conversationId }, { enabled: conversationId.length > 0 });
  const isAdmin = Boolean(settings.data?.isAdmin);
  const invites = trpc.conversations.invites.useQuery({ conversationId }, { enabled: conversationId.length > 0 && isAdmin });
  const setPermissions = trpc.conversations.setPermissions.useMutation();
  const createInvite = trpc.conversations.createInvite.useMutation();
  const revokeInvite = trpc.conversations.revokeInvite.useMutation();
  const utils = trpc.useUtils();

  const applyPermission = async (key: PermissionKey, value: "all" | "admins") => {
    setWorking(true);
    try {
      await setPermissions.mutateAsync({ conversationId, [key]: value });
      await settings.refetch();
      await utils.conversations.settings.invalidate();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not change that setting");
    }
    setWorking(false);
  };

  const copyLink = async (url: string) => {
    // There is no clipboard module in this build, so on native the honest instruction is to select
    // the text rather than to offer a button that silently does nothing.
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(url);
        setStatus("Invite link copied");
        return;
      } catch {
        /* fall through to the instruction below */
      }
    }
    setStatus("Long-press the link to copy it");
  };

  const mint = async () => {
    setWorking(true);
    try {
      const created = await createInvite.mutateAsync({ conversationId, expiresInHours: 0, maxUses: 0 });
      await invites.refetch();
      await copyLink(inviteUrl(created.code));
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not create a link");
    }
    setWorking(false);
  };

  const revoke = async (code: string) => {
    setWorking(true);
    try {
      await revokeInvite.mutateAsync({ conversationId, code });
      await invites.refetch();
      setStatus("Link revoked");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not revoke that link");
    }
    setWorking(false);
  };

  const rows = invites.data ?? [];

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Group settings</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>{isAdmin ? "Admins can change these" : "Only admins can change these"}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {settings.isLoading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}

        {settings.data ? PERMISSIONS.map((entry) => {
          const current = settings.data?.[entry.key] ?? "all";
          return (
            <View key={entry.key} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.cardHead}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{entry.title}</Text>
                <Text style={[styles.cardHint, { color: colors.muted }]}>{entry.hint}</Text>
              </View>
              <View style={styles.segment}>
                {(["all", "admins"] as const).map((value) => {
                  const active = current === value;
                  return (
                    <Pressable
                      key={value}
                      disabled={!isAdmin || working}
                      onPress={() => void applyPermission(entry.key, value)}
                      style={[styles.segmentButton, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary : "transparent", opacity: isAdmin ? 1 : 0.6 }]}
                    >
                      <Text style={[styles.segmentText, { color: active ? "#FFFFFF" : colors.foreground }]}>{value === "all" ? "Everyone" : "Admins only"}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        }) : null}

        {isAdmin ? (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Invite link</Text>
              <Text style={[styles.cardHint, { color: colors.muted }]}>Anyone with the link can join this group</Text>
            </View>
            {invites.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
            {rows.map((row) => (
              <View key={row.code} style={[styles.inviteRow, { borderTopColor: colors.border }]}>
                <Text selectable style={[styles.link, { color: colors.primary }]}>{inviteUrl(row.code)}</Text>
                <Text style={[styles.cardHint, { color: colors.muted }]}>
                  {row.uses}{row.maxUses ? ` of ${row.maxUses}` : ""} used
                  {row.expiresAt ? ` · expires ${new Date(row.expiresAt).toLocaleDateString()}` : " · no expiry"}
                </Text>
                <View style={styles.inviteActions}>
                  <Pressable onPress={() => void copyLink(inviteUrl(row.code))} style={[styles.smallButton, { borderColor: colors.border }]}>
                    <MaterialIcons name="content-copy" size={16} color={colors.primary} />
                    <Text style={[styles.smallButtonText, { color: colors.primary }]}>Copy</Text>
                  </Pressable>
                  <Pressable onPress={() => void revoke(row.code)} style={[styles.smallButton, { borderColor: colors.border }]}>
                    <MaterialIcons name="link-off" size={16} color={colors.error ?? "#DC2626"} />
                    <Text style={[styles.smallButtonText, { color: colors.error ?? "#DC2626" }]}>Revoke</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            <Pressable onPress={() => void mint()} disabled={working} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
              <MaterialIcons name="add-link" size={18} color="#FFFFFF" />
              <Text style={styles.primaryButtonText}>{rows.length > 0 ? "Create another link" : "Create invite link"}</Text>
            </Pressable>
          </View>
        ) : null}

        {status ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 22, fontWeight: "800" },
  subtitle: { fontSize: 13, marginTop: 3 },
  body: { padding: 16, gap: 12, paddingBottom: 48 },
  loader: { marginTop: 24 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  cardHead: { gap: 2 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  cardHint: { fontSize: 12.5 },
  segment: { flexDirection: "row", gap: 8 },
  segmentButton: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 9, alignItems: "center" },
  segmentText: { fontSize: 13, fontWeight: "700" },
  inviteRow: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 6 },
  link: { fontSize: 13, fontWeight: "600" },
  inviteActions: { flexDirection: "row", gap: 8 },
  smallButton: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6 },
  smallButtonText: { fontSize: 12.5, fontWeight: "700" },
  primaryButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, paddingVertical: 12, marginTop: 4 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  status: { fontSize: 12.5, textAlign: "center", marginTop: 4 },
});
