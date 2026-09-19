import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Contacts from "expo-contacts";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import { createAudioPlayer, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { appendMessage, filterConversations } from "@/lib/pulse-chat";
import { prepareAttachment } from "@/lib/media-upload";
import { getApiBaseUrl } from "@/constants/oauth";
import { trpc } from "@/lib/trpc";
import { useCall } from "@/lib/call-context";

type Conversation = {
  id: string;
  name: string;
  initials: string;
  color: string;
  preview: string;
  time: string;
  unread: number;
  online?: boolean;
  muted?: boolean;
  pinned?: boolean;
  group?: boolean;
};

type Message = {
  id: string;
  text: string;
  time: string;
  mine?: boolean;
  read?: boolean;
  kind?: "text" | "image" | "video" | "file" | "voice";
  mediaUrl?: string;
  mediaName?: string;
  voiceDurationMs?: number;
  starred?: boolean;
  reaction?: string;
  viewOnce?: boolean;
  replyTo?: string;
};

// `userId` is only present for real Varnox accounts (people.search); device contacts have none,
// so only those can be turned into a conversation.
type ContactSuggestion = { id: string; name: string; initials: string; color: string; phone?: string; email?: string; userId?: number };

const CHAT_COLORS = ["#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#0EA5E9", "#F97316"];

function chatInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function chatColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return CHAT_COLORS[hash % CHAT_COLORS.length];
}

function chatTime(value?: string | Date | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// The demo conversation fixtures are gone: the list is built from conversations.list.

// Demo message and contact fixtures deleted - messages come from conversations.messages
// and people come from people.search.

function Avatar({ item, size = 52 }: { item: Pick<Conversation, "initials" | "color">; size?: number }) {
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: item.color }]}><Text style={[styles.avatarText, { fontSize: size * 0.31 }]}>{item.initials}</Text></View>;
}

function IconButton({ name, color, onPress }: { name: React.ComponentProps<typeof MaterialIcons>["name"]; color: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]} hitSlop={8}><MaterialIcons name={name} size={23} color={color} /></Pressable>;
}

function resolveMediaUrl(url?: string) {
  if (!url) return undefined;
  if (url.startsWith("http") || url.startsWith("file:") || url.startsWith("blob:")) return url;
  return `${getApiBaseUrl()}${url}`;
}

export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user, isAuthenticated } = useAuth();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Drives the search bar's focused treatment (accent border + soft glow).
  const [searchFocused, setSearchFocused] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [chatFilter, setChatFilter] = useState<"all" | "unread" | "groups">("all");
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [viewOnce, setViewOnce] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const [deviceContacts, setDeviceContacts] = useState<ContactSuggestion[]>([]);
  const [webNotificationStatus, setWebNotificationStatus] = useState<NotificationPermission | "unsupported">("default");
  const seenRemoteMessages = useRef<Record<string, Set<string>>>({});

  // Real conversations from the backend. The hardcoded list below is only a pre-login
  // placeholder: it used to be what signed-in users saw (fake names, fake unread counts,
  // and fake notification titles), while the backend already had the real rows.
  const conversationListQuery = trpc.conversations.list.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: isAuthenticated ? 8000 : false,
  });
  const markRead = trpc.conversations.markRead.useMutation();
  const remoteConversations = useMemo<Conversation[]>(() => {
    return (conversationListQuery.data ?? []).map((item) => {
      const name = item.title?.trim() || item.otherMember?.name?.trim() || item.otherMember?.username || "Chat";
      const last = item.lastMessage;
      const text = last
        ? last.body ?? last.mediaName ?? (last.kind === "voice" ? "Voice note" : last.kind === "text" ? "New message" : "Shared media")
        : "No messages yet";
      return {
        id: item.id,
        name,
        initials: chatInitials(name),
        color: chatColor(item.id),
        preview: last && last.senderId === user?.id ? `You: ${text}` : text,
        time: chatTime(last?.createdAt ?? item.updatedAt),
        unread: item.unreadCount ?? 0,
        group: item.kind === "group",
      } satisfies Conversation;
    });
  }, [conversationListQuery.data, user?.id]);
  const conversations = remoteConversations;

  const selectedChat = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  // `conversations` must be a dependency. Without it this memo kept whatever it computed on the
  // first render - an empty list, because the query was still loading - and never recomputed when
  // the rows arrived. That is why the hub showed "0 chats" while the conversation existed.
  const filteredConversations = useMemo(() => filterConversations(conversations, query).filter((item) => chatFilter === "all" || (chatFilter === "unread" ? item.unread > 0 : item.group)), [conversations, chatFilter, query]);
  const liveMessagesQuery = trpc.conversations.messages.useQuery(
    { conversationId: selectedId ?? "local", since: undefined },
    { enabled: Boolean(selectedId && isAuthenticated), refetchInterval: isAuthenticated ? 3000 : false },
  );
  const ensureConversation = trpc.conversations.ensure.useMutation();
  const startDirect = trpc.conversations.startDirect.useMutation();
  const sendRemoteMessage = trpc.conversations.send.useMutation();
  const uploadMedia = trpc.media.upload.useMutation();
  const registerPush = trpc.push.register.useMutation();
  const peopleSearch = trpc.people.search.useQuery({ query: contactQuery }, { enabled: isAuthenticated && contactQuery.trim().length >= 2 });

  const { startCall } = useCall();

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2200);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const requestWebNotifications = async () => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !("Notification" in window)) {
      notify("Browser notifications are not supported here");
      return;
    }
    const permission = await window.Notification.requestPermission();
    setWebNotificationStatus(permission);
    notify(permission === "granted" ? "Browser notifications enabled" : "Notification permission was not granted");
  };

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !("Notification" in window)) {
      if (Platform.OS === "web") setWebNotificationStatus("unsupported");
      return;
    }
    const syncPermission = () => setWebNotificationStatus(window.Notification.permission);
    syncPermission();
    // The permission can be granted outside React's lifetime - the Android shell asks
    // through a system dialog - so re-read it whenever the page regains focus. Without
    // this the status stays stale and alerts never start.
    window.addEventListener("focus", syncPermission);
    document.addEventListener("visibilitychange", syncPermission);
    return () => {
      window.removeEventListener("focus", syncPermission);
      document.removeEventListener("visibilitychange", syncPermission);
    };
  }, []);

  useEffect(() => {
    if (!selectedId || !isAuthenticated || ensureConversation.isPending) return;
    ensureConversation.mutate({ conversationId: selectedId, title: selectedChat?.name });
  }, [isAuthenticated, selectedChat?.name, selectedId]);

  useEffect(() => {
    if (!isAuthenticated || Platform.OS === "web") return;
    let cancelled = false;
    (async () => {
      try {
        const permission = await Notifications.getPermissionsAsync();
        const finalPermission = permission.status === "granted" ? permission : await Notifications.requestPermissionsAsync();
        if (cancelled || finalPermission.status !== "granted") return;
        const token = await Notifications.getExpoPushTokenAsync({ projectId: Constants.expoConfig?.extra?.eas?.projectId });
        if (!cancelled && token.data) registerPush.mutate({ token: token.data, platform: Platform.OS });
      } catch (error) {
        console.warn("[Push] Registration unavailable", error);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    if (Platform.OS !== "web" || !selectedId || !isAuthenticated || !liveMessagesQuery.data) return;
    const seen = seenRemoteMessages.current[selectedId] ?? new Set<string>();
    const incoming = liveMessagesQuery.data.filter((item) => item.senderId !== user?.id && !seen.has(item.id));
    const isFirstLoad = seen.size === 0;
    seenRemoteMessages.current[selectedId] = new Set(liveMessagesQuery.data.map((item) => item.id));

    if (isFirstLoad || incoming.length === 0 || webNotificationStatus !== "granted") return;
    const latest = incoming[incoming.length - 1];
    const body = latest.body ?? latest.mediaName ?? "You received a new message";
    const notification = new window.Notification(selectedChat?.name ?? "Varnox Chat", { body, tag: `varnox-${latest.id}` });
    notification.onclick = () => window.focus();
  }, [isAuthenticated, liveMessagesQuery.data, selectedChat?.name, selectedId, user?.id, webNotificationStatus]);

  const routeParams = useLocalSearchParams<{ conversationId?: string }>();

  // Opened from the new-group screen or from a search hit: select that conversation.
  useEffect(() => {
    const requested = typeof routeParams.conversationId === "string" ? routeParams.conversationId : "";
    if (requested) {
      setSelectedId(requested);
      setChatFilter("all");
    }
  }, [routeParams.conversationId]);

  // Clear the unread badge for the conversation being read.
  useEffect(() => {
    if (!isAuthenticated || !selectedId) return;
    const entry = (conversationListQuery.data ?? []).find((item) => item.id === selectedId);
    if (!entry || !entry.unreadCount) return;
    markRead.mutate({ conversationId: selectedId }, { onSuccess: () => conversationListQuery.refetch() });
  }, [conversationListQuery.data, isAuthenticated, selectedId]);

  // Alerts for every conversation, not only the open one. The effect above sees just the
  // selected chat, so a message arriving anywhere else used to pass in total silence.
  const seenConversationMessages = useRef<Set<string>>(new Set());
  const alertWatcherPrimed = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "web" || !isAuthenticated || typeof window === "undefined" || !("Notification" in window)) return;
    const items = conversationListQuery.data ?? [];
    if (items.length === 0) return;

    const alerts: { name: string; body: string; messageId: string; conversationId: string }[] = [];
    for (const item of items) {
      const last = item.lastMessage;
      if (!last || seenConversationMessages.current.has(last.id)) continue;
      seenConversationMessages.current.add(last.id);
      if (!alertWatcherPrimed.current) continue; // do not replay history on first paint
      if (last.senderId === user?.id) continue; // never alert on your own message
      if (item.id === selectedId) continue; // the open chat is handled above
      if (webNotificationStatus !== "granted") continue;
      alerts.push({
        name: item.title?.trim() || item.otherMember?.name?.trim() || item.otherMember?.username || "Varnox Chat",
        body: last.body ?? last.mediaName ?? "You received a new message",
        messageId: last.id,
        conversationId: item.id,
      });
    }
    alertWatcherPrimed.current = true;

    for (const alert of alerts) {
      const notification = new window.Notification(alert.name, { body: alert.body, tag: `varnox-${alert.messageId}` });
      notification.onclick = () => {
        window.focus();
        setSelectedId(alert.conversationId);
      };
    }
  }, [conversationListQuery.data, isAuthenticated, selectedId, user?.id, webNotificationStatus]);

  const discoverContacts = async () => {
    // Web has no device address book, so the sheet simply lists people from people.search.
    if (Platform.OS === "web") { setShowContacts(true); return; }
    try {
      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== "granted") { notify("Contacts permission is needed to find friends"); return; }
      const result = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails] });
      const mapped = result.data.filter((contact) => contact.name).slice(0, 80).map((contact, index) => {
        const name = contact.name ?? "Contact";
        const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
        return { id: contact.id ?? `contact-${index}`, name, initials, color: ["#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#0EA5E9"][index % 5], phone: contact.phoneNumbers?.[0]?.number, email: contact.emails?.[0]?.email };
      });
      setDeviceContacts(mapped);
      setShowContacts(true);
    } catch { notify("Could not access contacts right now"); }
  };

  const sendMessage = async (override?: Partial<Message>) => {
    const trimmed = composerText.trim();
    if ((!trimmed && !override?.mediaUrl) || !selectedId) return;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const localMessage: Message = { id: `new-${Date.now()}`, text: trimmed || override?.text || "Shared media", time, mine: true, read: true, viewOnce, replyTo: replyTo ?? undefined, ...override };
    if (isAuthenticated) {
      try {
        await sendRemoteMessage.mutateAsync({ conversationId: selectedId, body: localMessage.text, kind: localMessage.kind ?? "text", mediaUrl: localMessage.mediaUrl, mediaName: localMessage.mediaName, voiceDurationMs: localMessage.voiceDurationMs });
        await liveMessagesQuery.refetch();
      } catch { notify("Message saved locally; reconnect to sync it"); }
    } else {
      setMessages((current) => ({ ...current, [selectedId]: appendMessage(current[selectedId] ?? [], localMessage) }));
    }
    setComposerText("");
    setViewOnce(false);
    setReplyTo(null);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const shareMedia = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.82, allowsEditing: false });
      if (result.canceled || !result.assets[0] || !selectedId) return;
      const asset = result.assets[0];
      const kind = asset.type === "video" ? "video" : "image";
      if (!isAuthenticated) { await sendMessage({ text: kind === "video" ? "Video" : "Photo", kind, mediaUrl: asset.uri, mediaName: asset.fileName ?? undefined }); return; }
      const payload = await prepareAttachment(asset, kind);
      if (!payload) { notify("Could not read that file"); return; }
      const uploaded = await uploadMedia.mutateAsync(payload);
      await sendMessage({ text: kind === "video" ? "Video" : "Photo", kind, mediaUrl: uploaded.url, mediaName: uploaded.fileName });
      notify("Media sent");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Media upload was cancelled or unavailable");
    }
  };

  const startVoiceNote = async () => {
    if (Platform.OS === "web") { notify("Voice notes are available in the mobile build"); return; }
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) { notify("Microphone permission is needed for voice notes"); return; }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    notify("Recording voice note… tap again to stop");
  };

  const stopVoiceNote = async () => {
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri || !selectedId) return;
    const durationMs = Math.max(1000, Math.round((recorderState.durationMillis ?? 1000)));
    try {
      if (!isAuthenticated) { await sendMessage({ text: `Voice note · ${Math.round(durationMs / 1000)}s`, kind: "voice", mediaUrl: uri, voiceDurationMs: durationMs }); return; }
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const uploaded = await uploadMedia.mutateAsync({ fileName: `voice-${Date.now()}.m4a`, contentType: "audio/m4a", base64 });
      await sendMessage({ text: `Voice note · ${Math.round(durationMs / 1000)}s`, kind: "voice", mediaUrl: uploaded.url, mediaName: uploaded.fileName, voiceDurationMs: durationMs });
      notify("Voice note sent");
    } catch { notify("Voice note saved locally; reconnect to sync it"); }
  };

  const backendMessages: Message[] = (liveMessagesQuery.data ?? []).map((item) => ({ id: item.id, text: item.body ?? item.mediaName ?? (item.kind === "voice" ? "Voice note" : "Shared media"), time: new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), mine: item.senderId === user?.id, read: item.senderId === user?.id, kind: item.kind, mediaUrl: item.mediaUrl ?? undefined, mediaName: item.mediaName ?? undefined, voiceDurationMs: item.voiceDurationMs ?? undefined }));

  if (selectedChat) {
    const chatMessages = isAuthenticated && liveMessagesQuery.data ? backendMessages : (messages[selectedChat.id] ?? []);
    return (
      <ScreenContainer edges={["top", "bottom", "left", "right"]} containerClassName="bg-background">
        <StatusBar style="light" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={8}>
          <View style={[styles.chatHeader, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
            <Pressable onPress={() => setSelectedId(null)} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}><MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} /></Pressable>
            <Avatar item={selectedChat} size={40} />
            <Pressable onPress={() => router.push({ pathname: "/chat/group-info", params: { conversationId: selectedChat.id } })} style={styles.chatTitleBlock}><Text style={[styles.chatTitle, { color: colors.foreground }]}>{selectedChat.name}</Text><Text style={[styles.chatSubtitle, { color: selectedChat.online ? colors.success : colors.muted }]}>{selectedChat.group ? "tap for group info" : isAuthenticated ? "syncing every few seconds" : selectedChat.online ? "active now" : "last seen recently"}</Text></Pressable>
            <IconButton name="videocam" color={colors.primary} onPress={() => void startCall({ conversationId: selectedChat.id, kind: "video", peerName: selectedChat.name })} />
            <IconButton name="call" color={colors.primary} onPress={() => void startCall({ conversationId: selectedChat.id, kind: "audio", peerName: selectedChat.name })} />
          </View>
          <FlatList data={chatMessages} keyExtractor={(item) => item.id} contentContainerStyle={styles.messageList} showsVerticalScrollIndicator={false} ListHeaderComponent={<View style={styles.encryptionNote}><MaterialIcons name="lock" size={13} color={colors.muted} /><Text style={[styles.encryptionText, { color: colors.muted }]}>{isAuthenticated ? "Live sync enabled" : "Messages are private and secure"}</Text></View>} renderItem={({ item }) => <Pressable onLongPress={() => setActiveMessageId(activeMessageId === item.id ? null : item.id)} style={[styles.messageRow, item.mine ? styles.messageRowMine : styles.messageRowTheirs]}><View style={[styles.bubble, item.mine ? [styles.bubbleMine, { backgroundColor: colors.bubbleOutgoing }] : [styles.bubbleTheirs, { backgroundColor: colors.bubbleIncoming }]]}>
            {item.mediaUrl && item.kind === "image" ? <Image source={{ uri: resolveMediaUrl(item.mediaUrl) }} style={styles.messageImage} resizeMode="cover" /> : null}
            {item.kind === "voice" ? <Pressable onPress={() => { if (item.mediaUrl) createAudioPlayer(resolveMediaUrl(item.mediaUrl)).play(); }} style={styles.voiceBubble}><MaterialIcons name="play-arrow" size={22} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /><View style={styles.voiceWave}><View style={[styles.voiceLine, { backgroundColor: item.mine ? colors.bubbleOutgoingText : colors.primary }]} /><View style={[styles.voiceLineShort, { backgroundColor: item.mine ? colors.bubbleOutgoingText : colors.primary }]} /><View style={[styles.voiceLine, { backgroundColor: item.mine ? colors.bubbleOutgoingText : colors.primary }]} /></View><Text style={[styles.voiceLabel, { color: item.mine ? colors.bubbleOutgoingText : colors.foreground }]}>{item.text}</Text></Pressable> : null}
            {item.kind !== "voice" && (item.kind !== "image" || !item.mediaUrl) ? <Text style={[styles.messageText, { color: item.mine ? colors.bubbleOutgoingText : colors.foreground }]}>{item.text}</Text> : null}
            <View style={styles.messageMeta}><Text style={[styles.messageTime, { color: item.mine ? colors.bubbleOutgoingText : colors.muted, opacity: item.mine ? 0.75 : 1 }]}>{item.time}</Text>{item.starred ? <MaterialIcons name="star" size={13} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /> : null}{item.mine ? <MaterialIcons name="done-all" size={14} color="#53BDEB" /> : null}</View>
          </View>{activeMessageId === item.id ? <View style={[styles.messageActions, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => { setReplyTo(item.text); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Reply</Text></Pressable><Pressable onPress={() => { notify("Reaction added"); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>React</Text></Pressable><Pressable onPress={() => { notify("Message forwarded"); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Forward</Text></Pressable><Pressable onPress={() => { notify("Message starred"); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Star</Text></Pressable></View> : null}</Pressable>} />
          <View style={[styles.composerArea, { borderTopColor: colors.border, backgroundColor: colors.background }]}>{replyTo ? <Pressable onPress={() => setReplyTo(null)} style={[styles.replyBanner, { backgroundColor: colors.surface }]}><Text style={[styles.replyText, { color: colors.muted }]} numberOfLines={1}>Replying to: {replyTo}</Text><MaterialIcons name="close" size={16} color={colors.muted}/></Pressable> : null}<View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}><IconButton name="add" color={colors.muted} onPress={shareMedia} /><Pressable onPress={() => setViewOnce(!viewOnce)} style={[styles.viewOnce, viewOnce && { backgroundColor: colors.primary }]}><Text style={[styles.viewOnceText, { color: viewOnce ? "#FFFFFF" : colors.muted }]}>1</Text></Pressable><TextInput value={composerText} onChangeText={setComposerText} placeholder="Write a message" placeholderTextColor={colors.muted} style={[styles.composerInput, { color: colors.foreground }]} multiline maxLength={500} /><IconButton name="mood" color={colors.muted} onPress={() => setComposerText((current) => `${current}${current ? " " : ""}✨`)} /></View><Pressable onPress={composerText.trim() ? () => void sendMessage() : recorderState.isRecording ? () => void stopVoiceNote() : () => void startVoiceNote()} style={({ pressed }) => [styles.sendButton, { backgroundColor: recorderState.isRecording ? colors.error : colors.primary }, pressed && styles.sendPressed]}><MaterialIcons name={composerText.trim() ? "send" : recorderState.isRecording ? "stop" : "mic"} size={21} color="#FFFFFF" /></Pressable></View>
        </KeyboardAvoidingView>
      </ScreenContainer>
    );
  }

  const remotePeople: ContactSuggestion[] = (peopleSearch.data ?? []).map((person, index) => {
    const name = person.name ?? person.email ?? "Varnox contact";
    return { id: String(person.id), name, initials: name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase(), color: ["#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#0EA5E9"][index % 5], email: person.email ?? undefined, userId: person.id };
  });
  const discoveredPeople = [...remotePeople, ...deviceContacts].filter((person, index, list) => list.findIndex((candidate) => candidate.name === person.name) === index).filter((person) => `${person.name} ${person.email ?? ""} ${person.phone ?? ""}`.toLowerCase().includes(contactQuery.toLowerCase()));

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="light" />
      <View style={styles.header}><Text style={[styles.heading, { color: colors.foreground }]}>Messages</Text><View style={styles.headerActions}><IconButton name="camera-alt" color={colors.foreground} onPress={() => notify("Camera ready")} /><IconButton name="more-horiz" color={colors.foreground} onPress={() => setShowMenu((current) => !current)} /></View></View>
      {showMenu ? <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => { setChatFilter("all"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="forum" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>All chats</Text></Pressable><Pressable onPress={() => { setChatFilter("unread"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="mark-chat-unread" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Unread</Text></Pressable><Pressable onPress={() => { setChatFilter("groups"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="groups" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Groups</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/search"); }} style={styles.menuItem}><MaterialIcons name="manage-search" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Search messages</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/starred"); }} style={styles.menuItem}><MaterialIcons name="star-border" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Starred messages</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/new-group"); }} style={styles.menuItem}><MaterialIcons name="group-add" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>New group</Text></Pressable><Pressable onPress={() => { setShowMenu(false); Platform.OS === "web" ? requestWebNotifications() : notify(isAuthenticated ? "Push notifications are registered" : "Sign in to enable push notifications"); }} style={styles.menuItem}><MaterialIcons name="notifications-active" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Notification setup</Text></Pressable></View> : null}
      <View style={[styles.searchWrap, { backgroundColor: colors.surface, borderColor: searchFocused ? colors.primary : colors.border }, searchFocused && styles.searchWrapFocused]}><MaterialIcons name="search" size={20} color={searchFocused ? colors.primary : colors.muted} /><TextInput value={query} onChangeText={setQuery} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} placeholder="Search conversations" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} returnKeyType="search" />{query ? <Pressable onPress={() => setQuery("")} hitSlop={8} style={styles.searchClear}><MaterialIcons name="close" size={18} color={colors.muted} /></Pressable> : null}</View>
      <View style={styles.listHeader}><Text style={[styles.sectionLabel, { color: colors.muted }]}>RECENT</Text><Text style={[styles.countLabel, { color: colors.muted }]}>{filteredConversations.length} {filteredConversations.length === 1 ? "chat" : "chats"}</Text></View>
      <FlatList data={filteredConversations} keyExtractor={(item) => item.id} contentContainerStyle={styles.chatList} showsVerticalScrollIndicator={false} ListEmptyComponent={<View style={styles.emptyState}><MaterialIcons name={query.trim() || chatFilter !== "all" ? "search-off" : "forum"} size={34} color={colors.muted}/><Text style={[styles.emptyTitle, { color: colors.foreground }]}>{query.trim() ? "No chats match that search" : chatFilter === "unread" ? "Nothing unread" : chatFilter === "groups" ? "No groups yet" : "No chats yet"}</Text><Text style={[styles.emptyCopy, { color: colors.muted }]}>{query.trim() ? "Try a different name or message." : chatFilter === "unread" ? "You are all caught up." : "Start one and it will show up here."}</Text>{!query.trim() && chatFilter === "all" ? <Pressable onPress={() => setShowContacts(true)} style={({ pressed }) => [styles.emptyCta, { backgroundColor: colors.primary }, pressed && styles.rowPressed]}><MaterialIcons name="chat-bubble-outline" size={18} color="#FFFFFF" /><Text style={[styles.emptyCtaText, { color: "#FFFFFF" }]}>Start a chat</Text></Pressable> : null}</View>} renderItem={({ item }) => <Pressable onPress={() => setSelectedId(item.id)} style={({ pressed }) => [styles.chatRow, pressed && styles.rowPressed]}><View style={styles.avatarWrap}><Avatar item={item}/>{item.online ? <View style={[styles.onlineDot, { borderColor: colors.background }]} /> : null}</View><View style={[styles.chatCopy, { borderBottomColor: colors.border }]}><View style={styles.rowTop}><Text style={[styles.chatName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text><Text style={[styles.chatTime, { color: item.unread ? colors.primary : colors.muted }]}>{item.time}</Text></View><View style={styles.rowBottom}><View style={styles.previewLine}>{item.pinned ? <MaterialIcons name="push-pin" size={13} color={colors.muted} style={styles.pin}/> : null}<Text style={[styles.chatPreview, { color: item.unread ? colors.foreground : colors.muted }]} numberOfLines={1}>{item.preview}</Text></View>{item.muted ? <MaterialIcons name="volume-off" size={15} color={colors.muted} /> : item.unread ? <View style={[styles.unread, { backgroundColor: colors.unreadBadge }]}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}</View></View></Pressable>} />
      <Pressable onPress={discoverContacts} style={({ pressed }) => [styles.fab, { backgroundColor: colors.primary }, pressed && styles.sendPressed]}><MaterialIcons name="person-add-alt-1" size={22} color="#FFFFFF" /></Pressable>
      {showContacts ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>New conversation</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Find people from your contacts</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowContacts(false)} /></View><View style={[styles.searchWrap, styles.contactSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="search" size={20} color={colors.muted}/><TextInput value={contactQuery} onChangeText={setContactQuery} placeholder="Search by name, phone or username" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]}/></View><FlatList data={discoveredPeople} keyExtractor={(item) => item.id.toString()} contentContainerStyle={styles.contactList} ListEmptyComponent={<Text style={[styles.emptyCopy, { color: colors.muted }]}>{contactQuery.trim().length < 2 ? "Search by name, phone or username — at least two characters." : peopleSearch.isFetching ? "Searching…" : `No one found for “${contactQuery.trim()}”.`}</Text>} renderItem={({ item }) => <Pressable onPress={() => { const existing = conversations.find((conversation) => conversation.name === item.name || conversation.id === item.id); setShowContacts(false); setContactQuery(""); if (existing) { setSelectedId(existing.id); return; } if (!item.userId) { notify(`Invite link ready for ${item.name}`); return; } startDirect.mutate({ userId: item.userId }, { onSuccess: (result) => { void conversationListQuery.refetch(); setSelectedId(result.conversationId); notify(`Chat with ${item.name} started`); }, onError: (error) => notify(error.message) }); }} style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}><View style={[styles.contactAvatar, { backgroundColor: item.color }]}><Text style={styles.avatarText}>{item.initials}</Text></View><View style={styles.contactCopy}><Text style={[styles.chatName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.chatPreview, { color: colors.muted }]}>{item.phone ?? item.email ?? "From your contacts"}</Text></View><MaterialIcons name="chevron-right" size={21} color={colors.muted}/></Pressable>} /></View> : null}
      {toast ? <View style={[styles.toast, { backgroundColor: colors.foreground }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 }, eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 }, heading: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.4 }, headerActions: { flexDirection: "row", gap: 4 }, iconButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19 }, pressed: { opacity: 0.55 }, searchWrap: { height: 48, borderRadius: 14, marginHorizontal: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderWidth: 1 }, searchWrapFocused: { shadowColor: "#00A884", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 3 }, searchClear: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" }, searchInput: { flex: 1, marginLeft: 10, fontSize: 15.5, paddingVertical: 0, letterSpacing: 0.1, backgroundColor: "transparent" }, listHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 22, paddingTop: 25, paddingBottom: 8 }, sectionLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2 }, countLabel: { fontSize: 12 }, chatList: { paddingBottom: 100 }, chatRow: { flexDirection: "row", paddingLeft: 16, minHeight: 74 }, rowPressed: { opacity: 0.68 }, avatarWrap: { width: 60, alignItems: "flex-start", paddingTop: 11 }, avatar: { alignItems: "center", justifyContent: "center" }, avatarText: { color: "#FFFFFF", fontWeight: "800", letterSpacing: 0.2 }, onlineDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: "#25D366", borderWidth: 3, position: "absolute", bottom: 0, right: 5 }, chatCopy: { flex: 1, paddingRight: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth }, rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, chatName: { flex: 1, fontSize: 16.5, fontWeight: "600", letterSpacing: -0.1 }, chatTime: { fontSize: 11.5, fontWeight: "500" }, rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: 8 }, previewLine: { flex: 1, flexDirection: "row", alignItems: "center" }, pin: { marginRight: 4, transform: [{ rotate: "35deg" }] }, chatPreview: { flex: 1, fontSize: 13.5, lineHeight: 18 }, unread: { minWidth: 21, height: 21, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }, unreadText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" }, fab: { position: "absolute", right: 20, bottom: 20, width: 55, height: 55, borderRadius: 28, alignItems: "center", justifyContent: "center", shadowColor: "#000000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5 }, toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, alignItems: "center" }, toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" }, menu: { position: "absolute", zIndex: 5, right: 15, top: 70, width: 210, borderRadius: 14, borderWidth: 1, paddingVertical: 6, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }, menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 }, menuText: { fontSize: 13, fontWeight: "600" }, emptyCta: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 14, marginTop: 14 }, emptyCtaText: { fontSize: 14, fontWeight: "800" }, emptyState: { alignItems: "center", paddingTop: 80, paddingHorizontal: 30 }, emptyTitle: { fontSize: 18, fontWeight: "800", marginTop: 12 }, emptyCopy: { fontSize: 13, marginTop: 5, textAlign: "center" }, chatHeader: { height: 60, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth }, backButton: { width: 32, height: 42, justifyContent: "center", alignItems: "center" }, chatTitleBlock: { flex: 1, paddingLeft: 8 }, chatTitle: { fontSize: 16.5, fontWeight: "600" }, chatSubtitle: { fontSize: 11, marginTop: 3, fontWeight: "600" }, messageList: { paddingHorizontal: 12, paddingBottom: 14, flexGrow: 1, justifyContent: "flex-end" }, encryptionNote: { alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(245, 158, 11, 0.10)", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 20 }, encryptionText: { fontSize: 10, fontWeight: "600" }, messageRow: { width: "100%", marginBottom: 5 }, messageRowMine: { alignItems: "flex-end" }, messageRowTheirs: { alignItems: "flex-start" }, bubble: { maxWidth: "82%", paddingHorizontal: 12, paddingTop: 9, paddingBottom: 6, borderRadius: 12 }, bubbleMine: { borderTopRightRadius: 3 }, bubbleTheirs: { borderTopLeftRadius: 3 }, messageText: { fontSize: 14.5, lineHeight: 20 }, messageMeta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 3 }, messageActions: { flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, borderWidth: 1, marginTop: 4 }, actionText: { fontSize: 11, fontWeight: "800" }, replyBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, marginBottom: 6 }, replyText: { flex: 1, fontSize: 12 }, viewOnce: { width: 25, height: 25, borderRadius: 13, alignItems: "center", justifyContent: "center", marginBottom: 10 }, viewOnceText: { fontSize: 13, fontWeight: "900" }, messageTime: { fontSize: 10 }, messageImage: { width: 190, height: 150, borderRadius: 12, marginBottom: 5 }, composerArea: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 9, borderTopWidth: StyleSheet.hairlineWidth }, composer: { flex: 1, minHeight: 46, maxHeight: 110, borderRadius: 23, borderWidth: 1, flexDirection: "row", alignItems: "flex-end", paddingLeft: 3, paddingRight: 4 }, composerInput: { flex: 1, fontSize: 15, maxHeight: 94, paddingHorizontal: 7, paddingVertical: 12, backgroundColor: "transparent" }, sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" }, sendPressed: { transform: [{ scale: 0.96 }], opacity: 0.88 }, voiceBubble: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 170 }, voiceWave: { flexDirection: "row", gap: 3, alignItems: "center" }, voiceLine: { width: 3, height: 18, borderRadius: 2 }, voiceLineShort: { width: 3, height: 10, borderRadius: 2 }, voiceLabel: { flexShrink: 1, fontSize: 12, fontWeight: "700" }, contactSheet: { position: "absolute", zIndex: 10, top: 0, left: 0, right: 0, bottom: 0, paddingTop: 18, borderTopWidth: 1 }, contactHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingBottom: 18 }, contactTitle: { fontSize: 21, fontWeight: "800" }, contactSubtitle: { fontSize: 12, marginTop: 4 }, contactSearch: { marginBottom: 12 }, contactList: { paddingBottom: 30 }, contactRow: { minHeight: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: 20 }, contactAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", marginRight: 12 }, contactCopy: { flex: 1 },
});
