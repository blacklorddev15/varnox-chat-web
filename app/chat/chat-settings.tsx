import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

const TIMERS: Array<{ seconds: number | null; label: string }> = [
  { seconds: null, label: "Off" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 604800, label: "7 days" },
  { seconds: 7776000, label: "90 days" },
];

function timerLabel(seconds: number | null) {
  return TIMERS.find((entry) => entry.seconds === seconds)?.label ?? (seconds ? `${Math.round(seconds / 3600)} hours` : "Off");
}

/**
 * Settings for one conversation, plus the way into its export.
 *
 * "Disappearing" and "auto-download" can both be left to the account defaults, and the screen says so
 * rather than showing the default as though this chat had chosen it. That difference matters: picking a
 * value here pins this chat, while leaving it alone keeps following the account setting.
 */
export default function ChatSettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";

  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const settings = trpc.conversations.chatSettings.useQuery({ conversationId }, { enabled: conversationId.length > 0 });
  const setFlags = trpc.conversations.setFlags.useMutation();
  const setDisappearing = trpc.conversations.setDisappearing.useMutation();
  const utils = trpc.useUtils();

  // A local copy so a switch does not flick back while the mutation is in flight.
  const [mediaAutoLoad, setMediaAutoLoad] = useState<boolean | null>(null);
  useEffect(() => {
    if (settings.data) setMediaAutoLoad(settings.data.mediaAutoLoad);
  }, [settings.data]);

  const run = async (action: () => Promise<unknown>, after: () => Promise<unknown>, failure: string) => {
    setWorking(true);
    try {
      await action();
      await after();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : failure);
    }
    setWorking(false);
  };

  const toggleMedia = (value: boolean) => {
    setMediaAutoLoad(value);
    void run(
      () => setFlags.mutateAsync({ conversationId, mediaAutoLoad: value }),
      async () => {
        await settings.refetch();
        await utils.conversations.list.invalidate();
      },
      "Could not change that setting",
    );
  };

  const chooseTimer = (seconds: number | null) =>
    void run(
      () => setDisappearing.mutateAsync({ conversationId, seconds }),
      async () => {
        await settings.refetch();
        await utils.conversations.list.invalidate();
      },
      "Could not change the timer",
    );

  const data = settings.data;
  const timerPinned = data ? data.conversationDisappear !== null : false;
  const effectiveMedia = mediaAutoLoad ?? data?.mediaAutoLoad ?? true;

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {data?.title?.trim() || (data?.kind === "group" ? "Group settings" : "Chat settings")}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {settings.isLoading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}

        {data ? (
          <>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.row}>
                <View style={styles.copy}>
                  <Text style={[styles.rowTitle, { color: colors.foreground }]}>Media auto-download</Text>
                  <Text style={[styles.sub, { color: colors.muted }]}>
                    {effectiveMedia
                      ? "Photos and videos open as they arrive"
                      : data.autoDownloadMedia
                        ? "Off for this chat · your account default is on"
                        : "Off here and in your account default"}
                  </Text>
                </View>
                <Switch value={effectiveMedia} onValueChange={toggleMedia} disabled={working} trackColor={{ false: colors.border, true: "#A7E8CD" }} thumbColor={effectiveMedia ? colors.success : "#fff"} />
              </View>
            </View>

            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.cardHead}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Disappearing messages</Text>
                <Text style={[styles.sub, { color: colors.muted }]}>
                  {timerPinned
                    ? "New messages in this chat disappear on a timer"
                    : data.defaultDisappearSeconds > 0
                      ? `Following your account default · ${timerLabel(data.defaultDisappearSeconds)}`
                      : "Following your account default · off"}
                </Text>
              </View>
              {TIMERS.map((entry) => {
                const active = data.conversationDisappear === entry.seconds;
                return (
                  <Pressable key={entry.label} onPress={() => chooseTimer(entry.seconds)} disabled={working} style={[styles.timerRow, { borderTopColor: colors.border }]}>
                    <Text style={[styles.timerText, { color: active ? colors.primary : colors.foreground }]}>{entry.label}</Text>
                    {active ? <MaterialIcons name="check" size={18} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
              <Text style={[styles.note, { color: colors.muted }]}>New messages only. Ones already sent are left where they are.</Text>
            </View>

            <Pressable
              onPress={() => router.push({ pathname: "/chat/export", params: { conversationId } })}
              style={[styles.exportRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <MaterialIcons name="download" size={19} color={colors.primary} />
              <View style={styles.copy}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Export chat</Text>
                <Text style={[styles.sub, { color: colors.muted }]}>Save a readable copy of this conversation</Text>
              </View>
              <MaterialIcons name="chevron-right" size={20} color={colors.muted} />
            </Pressable>
          </>
        ) : null}

        {status ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 12, paddingBottom: 48 },
  loader: { marginTop: 24 },
  card: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14 },
  cardHead: { paddingVertical: 13, gap: 3 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 13 },
  copy: { flex: 1, paddingRight: 10 },
  rowTitle: { fontSize: 14.5, fontWeight: "700" },
  sub: { fontSize: 12.5, lineHeight: 17, marginTop: 3 },
  timerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 13 },
  timerText: { fontSize: 14, fontWeight: "600" },
  note: { fontSize: 12, lineHeight: 16, paddingBottom: 13 },
  exportRow: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 14 },
  status: { fontSize: 12.5, textAlign: "center", marginTop: 4 },
});
