import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
// The same import the chat uses: the modern path dropped the base64 reader this needs.
import * as FileSystem from "expo-file-system/legacy";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { prepareAttachment } from "@/lib/media-upload";
import { resolveMediaUrl } from "@/lib/media-url";

/** Text statuses are drawn on a coloured bubble; the key travels with the status. */
const BACKGROUNDS: [string, string][] = [
  ["amber", "#F59E0B"],
  ["violet", "#8B5CF6"],
  ["emerald", "#10B981"],
  ["rose", "#EC4899"],
  ["sky", "#0EA5E9"],
];

/**
 * What a status can carry.
 *
 * A video needs a mime type because the viewer has to hand it to a player. A recording needs its
 * length so the viewer can draw progress without first loading the file.
 */
type StatusAttachment = { kind: "image" | "video" | "voice"; url: string; mime?: string; durationMs?: number };

export default function NewStatusScreen() {
  const colors = useColors();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [background, setBackground] = useState("amber");
  /**
   * What the status will carry.
   *
   * One value rather than a url per kind: the previous shape had a single photoUrl, and adding video
   * and voice that way would have meant three nullable fields that could disagree about which one
   * had actually been chosen.
   */
  const [attachment, setAttachment] = useState<StatusAttachment | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = trpc.media.upload.useMutation();
  const create = trpc.status.create.useMutation();

  /** Picks a photo or a video from the library and uploads it. */
  const pickMedia = async (kind: "image" | "video") => {
    setStatus(null);
    const noun = kind === "video" ? "video" : "photo";
    let step = `opening the ${noun} picker`;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus(`${kind === "video" ? "Video" : "Photo"} access was refused. Allow it for this app, then try again.`);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: kind === "video" ? ["videos"] : ["images"],
        // Cropping a video is not something the picker offers, and a status is not a square.
        allowsEditing: kind === "image",
        quality: 0.85,
        base64: true,
        // Matches what a status viewer can reasonably play back in one sitting.
        videoMaxDuration: 60,
      });
      if (result.canceled || !result.assets?.length) return;
      step = `reading the chosen ${noun}`;
      const payload = await prepareAttachment(result.assets[0], kind);
      if (!payload) {
        setStatus(`Could not read that ${noun}: the picker returned no usable data.`);
        return;
      }
      step = `uploading (${Math.round(payload.base64.length / 1024)} KB as ${payload.contentType})`;
      const uploaded = await upload.mutateAsync(payload);
      setAttachment({ kind, url: uploaded.url, mime: payload.contentType });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Failed while ${step}: ${detail}`);
    }
  };

  const startRecording = async () => {
    setStatus(null);
    // Same limitation the chat has: there is no recorder on the web build.
    if (Platform.OS === "web") {
      setStatus("Voice statuses are available in the mobile build.");
      return;
    }
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setStatus("Microphone permission is needed to record a status.");
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start recording");
    }
  };

  const stopRecording = async () => {
    setStatus(null);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        setStatus("The recording produced no file.");
        return;
      }
      // Floored at a second because the server rejects a status with no length, and a very short
      // recording reports 0.
      const durationMs = Math.max(1000, Math.round(recorderState.durationMillis ?? 1000));
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const uploaded = await upload.mutateAsync({ fileName: `status-${Date.now()}.m4a`, contentType: "audio/m4a", base64 });
      setAttachment({ kind: "voice", url: uploaded.url, mime: "audio/m4a", durationMs });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the recording");
    }
  };

  const post = async () => {
    setStatus(null);
    setBusy(true);
    try {
      await create.mutateAsync({
        kind: attachment?.kind ?? "text",
        body: body.trim() || undefined,
        mediaUrl: attachment?.url,
        // Sent for the two kinds the viewer cannot infer from the url alone: it needs a mime type to
        // hand a video to the player, and a length to draw the progress on a recording.
        mediaMime: attachment?.kind === "video" ? attachment.mime : undefined,
        voiceDurationMs: attachment?.kind === "voice" ? attachment.durationMs : undefined,
        background,
      });
      router.back();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not post your status.");
    } finally {
      setBusy(false);
    }
  };

  // Nothing to post while a recording is still running: the attachment only exists once it stops.
  const canPost = Boolean(attachment || body.trim()) && !recorderState.isRecording;

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.foreground }]}>New status</Text>
            <Text style={[styles.sub, { color: colors.muted }]}>Disappears after 24 hours</Text>
          </View>
          <Pressable onPress={post} disabled={!canPost || busy} style={({ pressed }) => [styles.postButton, { backgroundColor: canPost ? colors.primary : colors.surface }, (pressed || busy) && styles.pressed]}>
            <Text style={[styles.postText, { color: canPost ? "#FFFFFF" : colors.muted }]}>{busy ? "Posting…" : "Post"}</Text>
          </Pressable>
        </View>

        {attachment ? (
          <View style={styles.previewWrap}>
            {attachment.kind === "voice" ? (
              // A recording has no frame to show, so it gets a panel and its length rather than a
              // broken image.
              <View style={[styles.preview, styles.previewVoice]}>
                <MaterialIcons name="mic" size={34} color="#FFFFFF" />
                <Text style={styles.previewVoiceText}>{Math.round((attachment.durationMs ?? 0) / 1000)}s recording</Text>
              </View>
            ) : (
              <Image source={{ uri: resolveMediaUrl(attachment.url) }} style={styles.preview} resizeMode="cover" />
            )}
            {attachment.kind === "video" ? (
              <View style={styles.previewBadge}>
                <MaterialIcons name="videocam" size={13} color="#FFFFFF" />
                <Text style={styles.previewBadgeText}>Video</Text>
              </View>
            ) : null}
            <Pressable onPress={() => setAttachment(null)} style={styles.removePhoto}>
              <MaterialIcons name="close" size={18} color="#FFFFFF" />
            </Pressable>
          </View>
        ) : (
          <View style={[styles.textCard, { backgroundColor: BACKGROUNDS.find(([key]) => key === background)?.[1] ?? colors.primary }]}>
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Type a status"
              placeholderTextColor="rgba(255,255,255,0.75)"
              multiline
              maxLength={700}
              style={styles.textInput}
            />
          </View>
        )}

        <View style={styles.toolbar}>
          <Pressable onPress={() => void pickMedia("image")} style={({ pressed }) => [styles.tool, { borderColor: colors.border }, pressed && styles.pressed]}>
            <MaterialIcons name="photo-library" size={18} color={colors.foreground} />
            <Text style={[styles.toolText, { color: colors.foreground }]}>{attachment?.kind === "image" ? "Replace photo" : "Add photo"}</Text>
          </Pressable>
          <Pressable onPress={() => void pickMedia("video")} style={({ pressed }) => [styles.tool, { borderColor: colors.border }, pressed && styles.pressed]}>
            <MaterialIcons name="videocam" size={18} color={colors.foreground} />
            <Text style={[styles.toolText, { color: colors.foreground }]}>{attachment?.kind === "video" ? "Replace video" : "Add video"}</Text>
          </Pressable>
          <Pressable
            onPress={() => void (recorderState.isRecording ? stopRecording() : startRecording())}
            style={({ pressed }) => [styles.tool, { borderColor: recorderState.isRecording ? colors.error : colors.border }, pressed && styles.pressed]}
          >
            <MaterialIcons name={recorderState.isRecording ? "stop" : "mic"} size={18} color={recorderState.isRecording ? colors.error : colors.foreground} />
            <Text style={[styles.toolText, { color: recorderState.isRecording ? colors.error : colors.foreground }]}>
              {recorderState.isRecording ? "Stop" : attachment?.kind === "voice" ? "Re-record" : "Record"}
            </Text>
          </Pressable>
          {attachment ? (
            <Pressable onPress={() => setAttachment(null)} style={({ pressed }) => [styles.tool, { borderColor: colors.border }, pressed && styles.pressed]}>
              <MaterialIcons name="text-fields" size={18} color={colors.foreground} />
              <Text style={[styles.toolText, { color: colors.foreground }]}>Use text</Text>
            </Pressable>
          ) : null}
        </View>

        {!attachment ? (
          <View style={styles.swatchRow}>
            <Text style={[styles.swatchLabel, { color: colors.muted }]}>Background</Text>
            {BACKGROUNDS.map(([key, hex]) => (
              <Pressable key={key} onPress={() => setBackground(key)} style={[styles.swatch, { backgroundColor: hex, borderColor: background === key ? colors.foreground : "transparent" }]} />
            ))}
          </View>
        ) : null}

        {status ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  previewVoice: { alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#1B1B22" },
  previewVoiceText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  previewBadge: { position: "absolute", left: 10, bottom: 10, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  previewBadgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, padding: 18 },
  headerCopy: { flex: 1 },
  title: { fontSize: 20, fontWeight: "800" },
  sub: { fontSize: 12, marginTop: 3 },
  postButton: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 13 },
  postText: { fontSize: 12, fontWeight: "800" },
  pressed: { opacity: 0.7 },
  previewWrap: { flex: 1, marginHorizontal: 18, borderRadius: 18, overflow: "hidden" },
  preview: { width: "100%", height: "100%" },
  removePhoto: { position: "absolute", top: 12, right: 12, width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  textCard: { flex: 1, marginHorizontal: 18, borderRadius: 18, padding: 20, justifyContent: "center" },
  textInput: { color: "#FFFFFF", fontSize: 21, lineHeight: 29, fontWeight: "700", textAlign: "center" },
  toolbar: { flexDirection: "row", gap: 9, paddingHorizontal: 18, paddingTop: 16 },
  tool: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 9 },
  toolText: { fontSize: 12, fontWeight: "700" },
  swatchRow: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 18, paddingTop: 16 },
  swatchLabel: { fontSize: 12, fontWeight: "700" },
  swatch: { width: 27, height: 27, borderRadius: 14, borderWidth: 2 },
  status: { fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingTop: 14 },
});
