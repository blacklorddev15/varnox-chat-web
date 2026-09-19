import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
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

export default function NewStatusScreen() {
  const colors = useColors();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [background, setBackground] = useState("amber");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = trpc.media.upload.useMutation();
  const create = trpc.status.create.useMutation();

  const pickPhoto = async () => {
    setStatus(null);
    let step = "opening the photo picker";
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus("Photo access was refused. Allow photos for this app, then try again.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.85, base64: true });
      if (result.canceled || !result.assets?.length) return;
      step = "reading the chosen image";
      const payload = await prepareAttachment(result.assets[0], "image");
      if (!payload) {
        setStatus("Could not read that image: the picker returned no usable data.");
        return;
      }
      step = `uploading (${Math.round(payload.base64.length / 1024)} KB as ${payload.contentType})`;
      const uploaded = await upload.mutateAsync(payload);
      setPhotoUrl(uploaded.url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Failed while ${step}: ${detail}`);
    }
  };

  const post = async () => {
    setStatus(null);
    setBusy(true);
    try {
      await create.mutateAsync({ kind: photoUrl ? "image" : "text", body: body.trim() || undefined, mediaUrl: photoUrl ?? undefined, background });
      router.back();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not post your status.");
    } finally {
      setBusy(false);
    }
  };

  const canPost = Boolean(photoUrl || body.trim());

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

        {photoUrl ? (
          <View style={styles.previewWrap}>
            <Image source={{ uri: resolveMediaUrl(photoUrl) }} style={styles.preview} resizeMode="cover" />
            <Pressable onPress={() => setPhotoUrl(null)} style={styles.removePhoto}>
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
          <Pressable onPress={pickPhoto} style={({ pressed }) => [styles.tool, { borderColor: colors.border }, pressed && styles.pressed]}>
            <MaterialIcons name="photo-library" size={18} color={colors.foreground} />
            <Text style={[styles.toolText, { color: colors.foreground }]}>{photoUrl ? "Replace photo" : "Add photo"}</Text>
          </Pressable>
          {photoUrl ? (
            <Pressable onPress={() => setPhotoUrl(null)} style={({ pressed }) => [styles.tool, { borderColor: colors.border }, pressed && styles.pressed]}>
              <MaterialIcons name="text-fields" size={18} color={colors.foreground} />
              <Text style={[styles.toolText, { color: colors.foreground }]}>Use text</Text>
            </Pressable>
          ) : null}
        </View>

        {!photoUrl ? (
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
