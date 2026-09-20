import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

type Prepared = { filename: string; heading: string; content: string; messageCount: number };

/**
 * Exports one conversation as a text transcript.
 *
 * The transcript is built by the server from the same rows the chat reads, so the file can never
 * contain more than the exporter could already see. Preparing it is a press rather than something
 * that happens on open: a long chat is a real request, and nobody should pay for it by mistyping a URL.
 */
export default function ExportChatScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";

  const prepare = trpc.conversations.exportChat.useMutation();
  const started = useRef(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const build = () => {
    setStatus(null);
    prepare
      .mutateAsync({ conversationId })
      .then((result) => setPrepared(result))
      .catch((error: unknown) => setStatus(error instanceof Error && error.message ? error.message : "Could not prepare the export"));
  };

  // Prepare once, on arrival, because the screen exists for exactly this.
  useEffect(() => {
    if (started.current || !conversationId) return;
    started.current = true;
    build();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const save = () => {
    if (!prepared) return;
    if (Platform.OS !== "web" || typeof document === "undefined") {
      setStatus("This build cannot save files. Select the text below and copy it.");
      return;
    }
    try {
      const blob = new Blob([prepared.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = prepared.filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      // Revoked on a delay rather than immediately: some browsers cancel a download whose object URL
      // is released in the same tick.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setStatus("Download started. If nothing appeared, copy the text instead.");
    } catch {
      setStatus("This browser blocked the download. Copy the text instead.");
    }
  };

  const copy = async () => {
    if (!prepared) return;
    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(prepared.content);
        setStatus("Transcript copied");
        return;
      } catch {
        /* fall through */
      }
    }
    setStatus("Long-press the transcript to copy it");
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Export chat</Text>
      </View>

      {prepare.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[styles.copy, { color: colors.muted }]}>Building the transcript…</Text>
        </View>
      ) : null}

      {!prepare.isPending && !prepared ? (
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={26} color={colors.muted} />
          <Text style={[styles.copy, { color: colors.muted }]}>{status ?? "Nothing to export yet."}</Text>
          <Pressable onPress={build} style={[styles.button, { backgroundColor: colors.primary }]}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {prepared ? (
        <>
          <View style={styles.actions}>
            <Pressable onPress={save} style={[styles.button, { backgroundColor: colors.primary }]}>
              <MaterialIcons name="download" size={17} color="#FFFFFF" />
              <Text style={styles.buttonText}>Save {prepared.filename.endsWith(".txt") ? ".txt" : "file"}</Text>
            </Pressable>
            <Pressable onPress={() => void copy()} style={[styles.buttonGhost, { borderColor: colors.border }]}>
              <MaterialIcons name="content-copy" size={17} color={colors.primary} />
              <Text style={[styles.buttonGhostText, { color: colors.primary }]}>Copy</Text>
            </Pressable>
          </View>
          <Text style={[styles.meta, { color: colors.muted }]}>
            {prepared.heading} · {prepared.messageCount} {prepared.messageCount === 1 ? "message" : "messages"}
          </Text>
          <ScrollView style={[styles.transcript, { backgroundColor: colors.surface, borderColor: colors.border }]} contentContainerStyle={styles.transcriptInner}>
            <Text selectable style={[styles.transcriptText, { color: colors.foreground }]}>
              {prepared.content}
            </Text>
          </ScrollView>
        </>
      ) : null}

      {status && prepared ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 32 },
  copy: { fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  actions: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 14 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 11, paddingHorizontal: 16, paddingVertical: 11, flex: 1 },
  buttonText: { color: "#FFFFFF", fontSize: 13.5, fontWeight: "700" },
  buttonGhost: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderWidth: 1, borderRadius: 11, paddingHorizontal: 16, paddingVertical: 11 },
  buttonGhostText: { fontSize: 13.5, fontWeight: "700" },
  meta: { fontSize: 12, paddingHorizontal: 16, paddingTop: 10 },
  transcript: { flex: 1, margin: 16, borderWidth: 1, borderRadius: 12 },
  transcriptInner: { padding: 12 },
  transcriptText: { fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  status: { fontSize: 12.5, textAlign: "center", paddingBottom: 14 },
});
