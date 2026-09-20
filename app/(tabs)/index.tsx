import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type StyleProp,
  type TextStyle,
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
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from "expo-audio";

import { ScreenContainer } from "@/components/screen-container";
import { EmojiPicker } from "@/components/emoji-picker";
import { LinkPreviewCard } from "@/components/link-preview-card";
import { LiveLocationBar, type LiveShare } from "@/components/live-location-bar";
import { VideoMessage } from "@/components/video-message";
import { OfflineBanner } from "@/components/offline-banner";
import { completeMention, mentionQuery, parseMentions } from "@/lib/mentions";
import { parseRichText, type RichNode, type RichStyle } from "@/lib/rich-text";
// Type-only, so nothing from the server bundle is pulled into the client. `lib/trpc.ts` already
// imports a type from `@/server/routers` the same way.
import type { ReportCategory } from "@/server/db";
import { useColors } from "@/hooks/use-colors";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import { useOnline } from "@/hooks/use-online";
import { appendMessage, filterConversations } from "@/lib/pulse-chat";
import { describeConversation, isStrandedGroup } from "@/lib/conversation-info";
import { avatarUrl } from "@/lib/media-url";
import { isOnline, OFFLINE_ACTION_MESSAGE, OFFLINE_CALL_MESSAGE, OFFLINE_SEND_MESSAGE, OFFLINE_UPLOAD_MESSAGE } from "@/lib/offline";
import { MAX_ATTACHMENT_BYTES, pickDocumentFile, prepareAttachment, prepareDocument } from "@/lib/media-upload";
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
  muted?: boolean;
  pinned?: boolean;
  archived?: boolean;
  group?: boolean;
  /**
   * The raw kind, alongside the boolean above.
   *
   * `group` is derived from this and is what the list filters on; both are kept because the header
   * needs to tell a direct chat from a group to pick the right info screen, and a two-person group
   * is still a group. See lib/conversation-info.ts.
   */
  kind?: string | null;
  /** How many people are in it, which is how a group nobody was added to becomes visible. */
  memberCount?: number | null;
  /**
   * The other person in a direct chat, and the stamp that versions their photo.
   *
   * Carried on the row so the avatar can be drawn without a query per chat: the server already
   * returns `otherMember` on every conversation, and it was being read for the name and thrown away
   * for the picture.
   *
   * `Date` as well as string because that is what actually arrives: the column is a timestamp and
   * superjson preserves it rather than stringifying it. `avatarUrl` accepts either.
   */
  peerId?: number | null;
  avatarUpdatedAt?: string | Date | null;
  // Drafts come back from the server so a half-written message survives leaving the chat.
  draft?: string | null;
  disappearSeconds?: number | null;
  /** Tri-state from the server: true, false, or absent when the row predates the option. */
  mediaAutoLoad?: boolean;
};

/** The message a reply points at, resolved by the server. */
type MessageQuote = { id: string; body: string | null; kind: string; mediaName?: string | null; senderId: number; senderName: string; deleted: boolean };

/** Content of the message kinds that carry no file, mirroring the union in drizzle/schema.ts. */
type MessageMeta =
  | { kind: "poll"; question: string; options: string[] }
  | { kind: "location"; lat: number; lng: number; label?: string }
  | { kind: "contact"; userId: number; name: string; username?: string; phone?: string };

type Message = {
  id: string;
  text: string;
  time: string;
  mine?: boolean;
  read?: boolean;
  kind?: "text" | "image" | "video" | "file" | "voice" | "poll" | "location" | "contact" | "sticker";
  mediaUrl?: string;
  mediaName?: string;
  // Stored server-side all along; carried through so attachments can be labelled by type instead
  // of every one of them reading "Shared media".
  mediaMime?: string;
  voiceDurationMs?: number;
  starred?: boolean;
  // Personal: this reader asked that the message survive its disappearing timer.
  kept?: boolean;
  // Shared with the conversation: set when anyone pinned it.
  pinnedAt?: string | null;
  // Only ever set on your own messages: the server withholds a scheduled message from everyone else
  // until its time, so anybody who can see one is looking at their own.
  scheduledAt?: string | null;
  viewOnce?: boolean;
  // Everything below is stored server-side. These fields used to exist as local-only flags on
  // buttons that raised a toast, which is why they are spelled out here.
  status?: "sent" | "delivered" | "read" | null;
  edited?: boolean;
  deleted?: boolean;
  forwarded?: boolean;
  expiresAt?: string;
  reactions?: Array<{ userId: number; emoji: string; name: string }>;
  quote?: MessageQuote;
  /** Poll answers, one row per person. The tally is built here, from the rows the server sends. */
  votes?: Array<{ userId: number; optionIndex: number; name: string }>;
  meta?: MessageMeta;
};

// `userId` is only present for real Varnox accounts (people.search); device contacts have none,
// so only those can be turned into a conversation.
type ContactSuggestion = { id: string; name: string; initials: string; color: string; phone?: string; email?: string; userId?: number; username?: string };

const CHAT_COLORS = ["#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#0EA5E9", "#F97316"];

/** The reaction row offered when a message is long-pressed. */
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/**
 * The categories the report sheet offers.
 *
 * The server holds the authoritative list and rejects anything outside it, so this only decides what
 * the sheet shows. `satisfies` makes a rename or removal on the server a compile error here rather
 * than a rejection the user discovers by tapping send; an addition on the server would simply not be
 * offered yet, which is harmless.
 */
const REPORT_CATEGORIES = ["spam", "abuse", "scam", "impersonation", "other"] as const satisfies readonly ReportCategory[];

/** Tick glyph for one of my own messages: one tick sent, two delivered, two blue read. */
function MessageTicks({ status, color, readColor }: { status?: "sent" | "delivered" | "read" | null; color: string; readColor: string }) {
  if (!status) return null;
  if (status === "sent") return <MaterialIcons name="done" size={14} color={color} />;
  return <MaterialIcons name="done-all" size={14} color={status === "read" ? readColor : color} />;
}

function disappearLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

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

/**
 * "last seen 14:32" for today, a short date for anything older.
 *
 * Returns null when there is nothing to show: either the person has never been seen, or their
 * `last seen` privacy setting hides it - the server blanks the value in that case rather than
 * expecting every screen to remember to check.
 */
function lastSeenLabel(value?: string | Date | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? `last seen ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : `last seen ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
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

/**
 * A chat's picture: the other person's photo in a direct chat, initials when there is none.
 *
 * This drew initials and nothing else, which is why a chat header and a chat list row showed "ED"
 * for somebody whose photo the Contact info screen displayed perfectly well. The photo was being
 * fetched by that one screen and by nothing else.
 *
 * `avatarUrl` carries `avatarUpdatedAt` in the query string, so a replaced photo is not masked by a
 * cached response, and it returns undefined when the person has never set one - which is the signal
 * to fall back rather than to render nothing.
 */
function Avatar({ item, size = 52 }: { item: Pick<Conversation, "initials" | "color" | "peerId" | "avatarUpdatedAt">; size?: number }) {
  const photo = item.peerId ? avatarUrl(item.peerId, item.avatarUpdatedAt) : undefined;
  if (photo) {
    return <Image source={{ uri: photo }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: item.color }} />;
  }
  return <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: item.color }]}><Text style={[styles.avatarText, { fontSize: size * 0.31 }]}>{item.initials}</Text></View>;
}

/**
 * An icon control in a header or the composer.
 *
 * `dimmed` fades a control without disabling it, which is what the call buttons use when there is
 * no connection. A wholly disabled button says nothing; a faded one that still answers with "no
 * connection" is the difference between a broken-looking app and one that has simply lost signal.
 */
function IconButton({ name, color, onPress, dimmed = false }: { name: React.ComponentProps<typeof MaterialIcons>["name"]; color: string; onPress: () => void; dimmed?: boolean }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.iconButton, dimmed && styles.dimmed, pressed && styles.pressed]} hitSlop={8}><MaterialIcons name={name} size={23} color={color} /></Pressable>;
}

/**
 * Icon and human label for an attachment, from its MIME type.
 *
 * Falls back to a generic file rather than guessing, because a wrong icon (a spreadsheet that says
 * "Photo") is worse than a neutral one.
 */
type IconName = ComponentProps<typeof MaterialIcons>["name"];

/**
 * How each inline marker renders.
 *
 * Colours are not set here: a bubble is green for the sender and grey for everyone else, so the
 * caller passes them in. These are only the glyph-level differences.
 */
const RICH_STYLE_OVERRIDES: Record<RichStyle, TextStyle> = {
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  mono: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
};

/**
 * Message text with @mentions emphasised and inline formatting applied.
 *
 * Both parses are pure functions in `lib/`; this only turns their output into nested `<Text>`, which
 * is how React Native applies mixed styling within one paragraph. A body with nothing to mark up
 * takes the plain path, so the common case renders exactly as it did before.
 */
function MessageText({
  text,
  names,
  style,
  mentionStyle,
  linkStyle,
  onPressLink,
}: {
  text: string;
  names: string[];
  style: StyleProp<TextStyle>;
  mentionStyle: StyleProp<TextStyle>;
  linkStyle: StyleProp<TextStyle>;
  onPressLink: (href: string) => void;
}) {
  const nodes = useMemo(() => parseRichText(text), [text]);

  if (nodes.length === 0) return <Text style={style}>{text}</Text>;
  if (nodes.length === 1 && nodes[0].kind === "text") return <Text style={style}>{nodes[0].text}</Text>;

  // Mentions are found inside the leaf runs, so "*bold @Ann*" highlights the name inside the style.
  const renderPlain = (value: string, keyPrefix: string): ReactNode => {
    const segments = parseMentions(value, names);
    if (!segments.some((segment) => segment.mention)) return value;

    return segments.map((segment, index) =>
      segment.mention ? (
        <Text key={`${keyPrefix}-mention-${index}`} style={mentionStyle}>
          {segment.text}
        </Text>
      ) : (
        segment.text
      ),
    );
  };

  const renderNodes = (list: RichNode[], keyPrefix: string): ReactNode[] =>
    list.map((node, index) => {
      const key = `${keyPrefix}-${index}`;
      if (node.kind === "text") return renderPlain(node.text, key);
      if (node.kind === "link") {
        return (
          <Text key={key} style={linkStyle} onPress={() => onPressLink(node.href)}>
            {node.text}
          </Text>
        );
      }
      return (
        <Text key={key} style={RICH_STYLE_OVERRIDES[node.kind]}>
          {renderNodes(node.children, key)}
        </Text>
      );
    });

  return <Text style={style}>{renderNodes(nodes, "rich")}</Text>;
}

/**
 * Bar heights for a voice note, derived from its id so the same note looks the same everywhere.
 *
 * These are decorative. Nothing decodes the recording to measure amplitude, so only the fill - the
 * part driven by the player's real position - carries information. The comment says so because a
 * waveform that pretends to be sampled is exactly the kind of decoration worth being honest about.
 */
function voiceBars(seed: string, count = 26): number[] {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000;
  return Array.from({ length: count }, () => {
    hash = (hash * 1_103_515_245 + 12_345) % 2_147_483_648;
    return 5 + (hash % 16);
  });
}

/** Seconds as m:ss, for the voice note's elapsed and total readouts. */
function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * A voice note with a real transport: play/pause, tap-to-seek, and 1x / 1.5x / 2x speed.
 *
 * The player is created per row by the audio library's own hook, so two voice notes in a thread
 * never share transport state, and the speed setting survives pausing because it lives here rather
 * than on the player object.
 */
function VoiceNoteBubble({ message, mine, colors }: { message: Message; mine: boolean; colors: ReturnType<typeof useColors> }) {
  const player = useAudioPlayer(resolveMediaUrl(message.mediaUrl) ?? "");
  const status = useAudioPlayerStatus(player);
  const [rate, setRate] = useState(1);
  const [trackWidth, setTrackWidth] = useState(0);
  const bars = voiceBars(message.id);
  const tint = mine ? colors.bubbleOutgoingText : colors.primary;
  // The recorded length is the fallback until the file reports its own duration.
  const duration = status.duration > 0 ? status.duration : (message.voiceDurationMs ?? 0) / 1000;
  const progress = duration > 0 ? Math.min(1, status.currentTime / duration) : 0;

  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    player.playbackRate = next;
  };

  return (
    <View style={styles.voiceBubble}>
      <Pressable onPress={() => (status.playing ? player.pause() : player.play())} hitSlop={8} style={styles.voicePlay}>
        <MaterialIcons name={status.playing ? "pause" : "play-arrow"} size={22} color={tint} />
      </Pressable>
      <Pressable
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onPress={(event) => { if (trackWidth > 0 && duration > 0) void player.seekTo(Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth)) * duration); }}
        style={styles.voiceTrack}
      >
        <View style={styles.voiceWave}>
          {bars.map((height, index) => <View key={index} style={[styles.voiceBar, { height, backgroundColor: tint, opacity: index / bars.length <= progress ? 1 : 0.32 }]} />)}
        </View>
      </Pressable>
      <Text style={[styles.voiceLabel, { color: mine ? colors.bubbleOutgoingText : colors.foreground }]}>{clockLabel(status.currentTime > 0 ? status.currentTime : duration)}</Text>
      <Pressable onPress={cycleRate} hitSlop={8} style={[styles.voiceRate, { borderColor: tint }]}>
        <Text style={[styles.voiceRateText, { color: tint }]}>{rate === 1 ? "1×" : `${rate}×`}</Text>
      </Pressable>
    </View>
  );
}

/**
 * A poll: the question, one row per answer with a share bar, and the count behind each row.
 *
 * The bars are computed from the per-person rows the server sends rather than from a stored total,
 * so two people voting at the same moment can never leave the UI showing a tally that adds up to
 * more answers than there are voters. Tapping a row votes; tapping another changes the answer.
 */
function PollBubble({ meta, votes, myUserId, mine, colors, onVote }: { meta: { question: string; options: string[] }; votes: Array<{ userId: number; optionIndex: number; name: string }>; myUserId?: number; mine: boolean; colors: ReturnType<typeof useColors>; onVote: (optionIndex: number) => void }) {
  const textColor = mine ? colors.bubbleOutgoingText : colors.foreground;
  const mutedColor = mine ? colors.bubbleOutgoingText : colors.muted;
  const total = votes.length;
  const myVote = votes.find((vote) => vote.userId === myUserId)?.optionIndex ?? -1;
  return (
    <View style={styles.pollCard}>
      <Text style={[styles.pollQuestion, { color: textColor }]}>{meta.question}</Text>
      {meta.options.map((option, index) => {
        const count = votes.filter((vote) => vote.optionIndex === index).length;
        const share = total > 0 ? Math.round((count / total) * 100) : 0;
        const chosen = myVote === index;
        return (
          <Pressable key={`${index}-${option}`} onPress={() => onVote(index)} style={[styles.pollOption, { borderColor: chosen ? colors.primary : colors.border }]}>
            <View style={[styles.pollBar, { width: `${share}%`, backgroundColor: chosen ? colors.primary : colors.border }]} />
            <View style={styles.pollOptionRow}>
              <MaterialIcons name={chosen ? "radio-button-checked" : "radio-button-unchecked"} size={16} color={chosen ? colors.primary : mutedColor} />
              <Text style={[styles.pollOptionText, { color: textColor }]} numberOfLines={2}>{option}</Text>
              <Text style={[styles.pollCount, { color: mutedColor }]}>{count}</Text>
            </View>
          </Pressable>
        );
      })}
      <Text style={[styles.pollFootnote, { color: mutedColor }]}>{total === 0 ? "No votes yet · tap an answer" : `${total} ${total === 1 ? "vote" : "votes"} · tap an answer to vote`}</Text>
    </View>
  );
}

function attachmentKind(mime?: string): { icon: IconName; label: string } {
  const type = (mime ?? "").toLowerCase();
  if (type.startsWith("image/")) return { icon: "image", label: "Photo" };
  if (type.startsWith("video/")) return { icon: "movie", label: "Video" };
  if (type.startsWith("audio/")) return { icon: "audiotrack", label: "Audio" };
  if (type === "application/pdf") return { icon: "picture-as-pdf", label: "PDF document" };
  if (/zip|compressed|tar|rar|7z/.test(type)) return { icon: "folder-zip", label: "Archive" };
  if (/word|opendocument\.text|msword/.test(type)) return { icon: "description", label: "Document" };
  if (/sheet|excel|csv/.test(type)) return { icon: "table-chart", label: "Spreadsheet" };
  if (/presentation|powerpoint/.test(type)) return { icon: "slideshow", label: "Presentation" };
  if (type.startsWith("text/")) return { icon: "article", label: "Text file" };
  return { icon: "insert-drive-file", label: "File" };
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
  // Used to tell "your share" from somebody else's in the live location bar.
  const myUserId = (user as (typeof user & { id?: number }) | null)?.id ?? null;
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
  // Messages whose media the reader chose to load anyway, in a chat with auto-download turned off.
  // Cleared whenever the open chat changes, so the choice does not leak into the next conversation.
  const [loadedMedia, setLoadedMedia] = useState<string[]>([]);
  const [showStickers, setShowStickers] = useState(false);
  const [chatFilter, setChatFilter] = useState<"all" | "unread" | "groups" | "archived">("all");
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [viewOnce, setViewOnce] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; text: string; senderName: string } | null>(null);
  // The message being edited, the one with its reaction row open, the one being forwarded, the
  // chat row whose menu is open, and a view-once photo currently being displayed.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reactingToId, setReactingToId] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [oncePreview, setOncePreview] = useState<string | null>(null);
  const [onceVideo, setOnceVideo] = useState<string | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  // Where the caret sits in the composer, so an emoji lands where the person is typing rather than
  // always at the end. React Native reports UTF-16 offsets, which is what slice() uses.
  const [composerSelection, setComposerSelection] = useState({ start: 0, end: 0 });
  // The poll being composed, or null while the builder is closed. Deliberately not part of the
  // composer text: a poll is a structured message, not a line of text with options glued on.
  const [pollDraft, setPollDraft] = useState<{ question: string; options: string[] } | null>(null);
  // The share-a-contact sheet: pick a Varnox account to send as a card.
  const [showShareContact, setShowShareContact] = useState(false);
  const [showTimer, setShowTimer] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const [deviceContacts, setDeviceContacts] = useState<ContactSuggestion[]>([]);
  const [webNotificationStatus, setWebNotificationStatus] = useState<NotificationPermission | "unsupported">("default");
  const seenRemoteMessages = useRef<Record<string, Set<string>>>({});
  // Every refresh timer below is gated on this, so a backgrounded app stops talking to the server.
  const appVisible = useAppVisible();

  // Realtime nudges. When the stream is up the fast intervals below collapse to a slow safety net:
  // an event channel can lose an event, and "lost" has to mean "a few seconds late", never "gone".
  const trpcUtils = trpc.useUtils();
  const realtimeInvalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (realtimeInvalidateTimer.current) clearTimeout(realtimeInvalidateTimer.current); }, []);
  const realtime = useRealtime(() => {
    if (realtimeInvalidateTimer.current) return;
    realtimeInvalidateTimer.current = setTimeout(() => {
      realtimeInvalidateTimer.current = null;
      // Coalesced: a burst of events (typing, then sending) causes one refetch pass, not one each.
      void trpcUtils.invalidate();
    }, 250);
  }, isAuthenticated && appVisible);

  const listInterval = realtime.live ? 30_000 : 8_000;
  const messageInterval = realtime.live ? 30_000 : 2_500;
  const presenceInterval = realtime.live ? 30_000 : 4_000;
  const inboxInterval = realtime.live ? 30_000 : 6_000;

  // Real conversations from the backend. The hardcoded list below is only a pre-login
  // placeholder: it used to be what signed-in users saw (fake names, fake unread counts,
  // and fake notification titles), while the backend already had the real rows.
  const conversationListQuery = trpc.conversations.list.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: isAuthenticated && appVisible ? listInterval : false,
  });
  const markRead = trpc.conversations.markRead.useMutation();
  const markDelivered = trpc.conversations.markDelivered.useMutation();
  const setFlags = trpc.conversations.setFlags.useMutation();
  const reactMessage = trpc.conversations.react.useMutation();
  const starMessage = trpc.conversations.star.useMutation();
  const editMessage = trpc.conversations.editMessage.useMutation();
  const removeMessage = trpc.conversations.deleteMessage.useMutation();
  const openViewOnce = trpc.conversations.openViewOnce.useMutation();
  const votePoll = trpc.conversations.votePoll.useMutation();
  const setDisappearing = trpc.conversations.setDisappearing.useMutation();
  const remoteConversations = useMemo<Conversation[]>(() => {
    return (conversationListQuery.data ?? []).map((item) => {
      const name = item.title?.trim() || item.otherMember?.name?.trim() || item.otherMember?.username || "Chat";
      const last = item.lastMessage;
      const text = last
        ? last.deletedAt
          ? "This message was deleted"
          : last.body ?? last.mediaName ?? (last.kind === "voice" ? "Voice note" : last.kind === "text" ? "New message" : "Shared media")
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
        kind: item.kind,
        memberCount: item.memberCount,
        peerId: item.otherMember?.id ?? null,
        avatarUpdatedAt: item.otherMember?.avatarUpdatedAt ?? null,
        muted: item.muted,
        pinned: item.pinned,
        archived: item.archived,
        draft: item.draft,
        disappearSeconds: item.disappearSeconds ?? null,
        mediaAutoLoad: item.mediaAutoLoad !== false,
      } satisfies Conversation;
    });
  }, [conversationListQuery.data, user?.id]);
  const conversations = remoteConversations;

  const selectedChat = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  // `conversations` must be a dependency. Without it this memo kept whatever it computed on the
  // first render - an empty list, because the query was still loading - and never recomputed when
  // the rows arrived. That is why the hub showed "0 chats" while the conversation existed.
  const filteredConversations = useMemo(() => {
    // Archived chats are out of the way until the Archived filter is chosen.
    const visible = conversations.filter((item) => (chatFilter === "archived" ? item.archived : !item.archived));
    const matched = filterConversations(visible, query).filter(
      (item) => chatFilter === "all" || chatFilter === "archived" || (chatFilter === "unread" ? item.unread > 0 : item.group),
    );
    // Pinned chats float to the top.
    return [...matched].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }, [conversations, chatFilter, query]);
  const liveMessagesQuery = trpc.conversations.messages.useQuery(
    { conversationId: selectedId ?? "local", since: undefined },
    { enabled: Boolean(selectedId && isAuthenticated), refetchInterval: isAuthenticated && appVisible ? messageInterval : false },
  );
  const ensureConversation = trpc.conversations.ensure.useMutation();
  const startDirect = trpc.conversations.startDirect.useMutation();
  const sendRemoteMessage = trpc.conversations.send.useMutation();
  const addSticker = trpc.stickers.add.useMutation();
  const uploadMedia = trpc.media.upload.useMutation();
  const registerPush = trpc.push.register.useMutation();
  const peopleSearch = trpc.people.search.useQuery({ query: contactQuery }, { enabled: isAuthenticated && contactQuery.trim().length >= 2 });

  // Presence. The inbox variant covers the whole chat list so rows can show a typing line and an
  // online dot; the per-conversation variant feeds the header of the chat that is open.
  const presenceInbox = trpc.presence.inbox.useQuery(undefined, {
    enabled: isAuthenticated && appVisible,
    refetchInterval: isAuthenticated && appVisible ? inboxInterval : false,
  });
  const chatPresence = trpc.presence.forConversation.useQuery(
    { conversationId: selectedId ?? "none" },
    { enabled: Boolean(selectedId && isAuthenticated && appVisible), refetchInterval: isAuthenticated && appVisible ? presenceInterval : false },
  );
  const presenceHeartbeat = trpc.presence.heartbeat.useMutation();

  // Member names, for @mention highlighting and completion.
  const chatMembers = trpc.conversations.members.useQuery(
    { conversationId: selectedId ?? "none" },
    { enabled: Boolean(selectedId && isAuthenticated) },
  );
  const mentionNames = useMemo(
    () =>
      (chatMembers.data?.members ?? [])
        .map((member) => (member.name?.trim() || member.username || "").trim())
        .filter(Boolean),
    [chatMembers.data],
  );
  const mentionFragment = mentionQuery(composerText);
  const mentionSuggestions = useMemo(
    () =>
      mentionFragment === null
        ? []
        : mentionNames.filter((name) => name.toLowerCase().startsWith(mentionFragment.toLowerCase())).slice(0, 5),
    [mentionFragment, mentionNames],
  );
  // Presence keyed by conversation, for the list rows.
  const inboxPresence = useMemo(() => new Map((presenceInbox.data ?? []).map((row) => [row.conversationId, row] as const)), [presenceInbox.data]);

  // Refs, not state: these change on every keystroke and must not re-render the list.
  const heartbeatRef = useRef(presenceHeartbeat);
  heartbeatRef.current = presenceHeartbeat;
  const typingTargetRef = useRef<string | null>(null);
  const typingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentAt = useRef(0);

  // A beat every 20s while the app is in front. It carries the current typing target, so the same
  // call that proves the client is alive also refreshes the server's short typing lease.
  // Which photos were loaded by hand belongs to one chat. Leaving it set would carry a tap from one
  // conversation into the next one the reader opens.
  useEffect(() => {
    setLoadedMedia([]);
  }, [selectedId]);

  useEffect(() => {
    if (!isAuthenticated || !appVisible) return;
    const beat = () => heartbeatRef.current.mutate({ typingConversationId: typingTargetRef.current });
    beat();
    const timer = setInterval(beat, 20_000);
    return () => clearInterval(timer);
  }, [isAuthenticated, appVisible]);

  // Drives the offline banner and the dimmed controls. The handlers below deliberately do not read
  // this value - they call isOnline() at the moment they run, so a tap is never judged against a
  // render that has since gone stale.
  const online = useOnline();

  // Typing: announced on the first keystroke, re-sent every 4s while keys keep arriving (the
  // server lease is 8s), and dropped the moment the box empties. If this client vanishes
  // mid-sentence the lease expires on its own, so nobody is left watching a stuck indicator.
  useEffect(() => {
    if (!isAuthenticated || !appVisible || !online) return;
    const want = selectedId && composerText.trim().length > 0 ? selectedId : null;
    if (want === null && typingTargetRef.current === null) return;
    const now = Date.now();
    if (want !== null && now - lastTypingSentAt.current < 4000) return;
    if (typingClearTimer.current) clearTimeout(typingClearTimer.current);
    typingTargetRef.current = want;
    lastTypingSentAt.current = now;
    heartbeatRef.current.mutate({ typingConversationId: want });
    if (want) {
      typingClearTimer.current = setTimeout(() => {
        typingTargetRef.current = null;
        heartbeatRef.current.mutate({ typingConversationId: null });
      }, 6000);
    }
    // `online` is a dependency as well as a guard: with the connection gone there is nothing to
    // announce, and React Query would only pause the heartbeat anyway.
  }, [composerText, selectedId, isAuthenticated, appVisible, online]);

  useEffect(() => () => { if (typingClearTimer.current) clearTimeout(typingClearTimer.current); }, []);

  const { startCall } = useCall();

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2200);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  /**
   * Refuses a write while offline and returns true when the caller should stop.
   *
   * This is not belt-and-braces around a failing request. React Query pauses a mutation while
   * offline rather than failing it, so the `await mutation.mutateAsync(...)` that every send in this
   * screen ends with would never settle - the message would not send, no error would appear, and
   * anything after the await (clearing the composer, closing a sheet) would never run. Refusing
   * before the mutation is fired is what makes an offline tap a clear answer instead of a hang.
   *
   * The signal is the same one React Query pauses on, so the two cannot disagree: if this says
   * online, the mutation really will go out.
   */
  const blockedOffline = (message: string = OFFLINE_SEND_MESSAGE) => {
    if (isOnline()) return false;
    notify(message);
    return true;
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

  // Opening a chat also marks its messages delivered (a separate cursor from read), and brings
  // back whatever draft was left in the composer.
  useEffect(() => {
    if (!isAuthenticated || !selectedId) return;
    markDelivered.mutate({ conversationId: selectedId });
    const entry = (conversationListQuery.data ?? []).find((item) => item.id === selectedId);
    setComposerText(entry?.draft ?? "");
    setEditingId(null);
    setReplyTo(null);
    // Intentionally keyed on the chat alone: re-running when the list refetches would wipe a
    // half-typed message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, selectedId]);

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

  /**
   * Sends the poll being composed.
   *
   * Blank answers are dropped, and a question with fewer than two answers left is refused here as
   * well as on the server: tapping "Add answer" by accident should not produce a poll nobody can
   * meaningfully answer.
   */
  const sendPoll = async () => {
    if (!pollDraft || !selectedId) return;
    const question = pollDraft.question.trim();
    const options = pollDraft.options.map((option) => option.trim()).filter(Boolean);
    if (!question) { notify("A poll needs a question"); return; }
    if (options.length < 2) { notify("A poll needs at least two answers"); return; }
    // Before the sheet is dismissed, so the poll somebody just wrote is still there to send again.
    if (blockedOffline()) return;
    setPollDraft(null);
    await sendMessage({ text: question, kind: "poll", meta: { kind: "poll", question, options } });
  };

  /**
   * Sends a contact card.
   *
   * Only Varnox accounts are shareable. The point of the card is that tapping it opens a chat, and a
   * phone-book entry with no account behind it would be a card that does nothing when tapped.
   */
  const sendContactCard = async (person: ContactSuggestion) => {
    if (!person.userId || !selectedId) return;
    // Before the sheet closes and the search is cleared: the person just chosen should still be on
    // screen when the toast says it did not send.
    if (blockedOffline()) return;
    setShowShareContact(false);
    setContactQuery("");
    await sendMessage({ text: person.name, kind: "contact", meta: { kind: "contact", userId: person.userId, name: person.name, username: person.username, phone: person.phone } });
  };

  /** Opens the chat behind a shared contact card. */
  const openSharedContact = (meta?: MessageMeta) => {
    if (meta?.kind !== "contact") return;
    startDirect.mutate({ userId: meta.userId }, {
      onSuccess: (result) => { void conversationListQuery.refetch(); setSelectedId(result.conversationId); },
      onError: (error) => notify(error.message),
    });
  };

  /** Records my answer to a poll. Changing my mind is the same call; the server replaces the row. */
  const castVote = async (message: Message, optionIndex: number) => {
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await votePoll.mutateAsync({ messageId: message.id, optionIndex });
      await liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not record that vote");
    }
  };

  const sendMessage = async (override?: Partial<Message>) => {
    const trimmed = composerText.trim();
    if ((!trimmed && !override?.mediaUrl && !override?.text) || !selectedId) return;
    // Checked before the text is cleared below, so an offline send leaves the message in the box to
    // be typed again rather than swallowing it.
    if (blockedOffline()) return;
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const localMessage: Message = { id: `new-${Date.now()}`, text: trimmed || override?.text || "Shared media", time, mine: true, read: true, viewOnce, quote: replyTo ? { id: replyTo.id, body: replyTo.text, kind: "text", senderId: user?.id ?? 0, senderName: replyTo.senderName, deleted: false } : undefined, ...override };
    if (isAuthenticated) {
      try {
        // mediaMime was never sent before, so every attachment was stored untyped and the UI could
        // not tell a PDF from a zip.
        await sendRemoteMessage.mutateAsync({ conversationId: selectedId, body: localMessage.text, kind: localMessage.kind ?? "text", mediaUrl: localMessage.mediaUrl, mediaName: localMessage.mediaName, mediaMime: localMessage.mediaMime, voiceDurationMs: localMessage.voiceDurationMs, replyToId: replyTo?.id, viewOnce, meta: localMessage.meta });
        await liveMessagesQuery.refetch();
      } catch (error) {
        // This used to read "Message saved locally; reconnect to sync it", and both halves of that
        // were untrue. There is no outbox: nothing was saved, and nothing would sync. The composer
        // was then cleared anyway, so the message was gone and the sender had no reason to think so -
        // which is how somebody ends up insisting they sent something the other person never saw.
        //
        // Returning here keeps the text in the box, skips the draft clear and holds off the "sent"
        // haptic, so a failed send stays a failed send.
        notify(error instanceof Error && error.message ? error.message : "Could not send that message. It is still in the box.");
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
    } else {
      setMessages((current) => ({ ...current, [selectedId]: appendMessage(current[selectedId] ?? [], localMessage) }));
    }
    setComposerText("");
    setViewOnce(false);
    setReplyTo(null);
    // The draft just became a message, so it must not reappear the next time this chat opens.
    void setFlags.mutateAsync({ conversationId: selectedId, draft: null }).catch(() => undefined);
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  /** Picks a document and sends it as an attachment. */
  const shareDocument = async () => {
    // Before the file picker, not after the upload. The upload is a mutation like any other, so
    // offline it would pause and the sheet would sit on "uploading" forever with the picked file
    // already in memory.
    if (blockedOffline(OFFLINE_UPLOAD_MESSAGE)) return;
    try {
      const asset = await pickDocumentFile();
      if (!asset || !selectedId) return;

      // Checked here so an oversized file is a clear message rather than a failed upload: the
      // database is the store, and 4 MB is its ceiling.
      if (asset.size && asset.size > MAX_ATTACHMENT_BYTES) {
        notify(`That file is ${(asset.size / (1024 * 1024)).toFixed(1)} MB. The limit is 4 MB.`);
        return;
      }

      const payload = await prepareDocument(asset);
      if (!payload) { notify("Could not read that file"); return; }

      const uploaded = await uploadMedia.mutateAsync(payload);
      await sendMessage({ text: payload.fileName, kind: "file", mediaUrl: uploaded.url, mediaName: payload.fileName, mediaMime: payload.contentType });
      notify("Attachment sent");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not send that file");
    }
  };

  const shareMedia = async () => {
    if (blockedOffline(OFFLINE_UPLOAD_MESSAGE)) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.82, allowsEditing: false });
      if (result.canceled || !result.assets[0] || !selectedId) return;
      const asset = result.assets[0];
      const kind = asset.type === "video" ? "video" : "image";
      if (!isAuthenticated) { await sendMessage({ text: kind === "video" ? "Video" : "Photo", kind, mediaUrl: asset.uri, mediaName: asset.fileName ?? undefined }); return; }
      const payload = await prepareAttachment(asset, kind);
      if (!payload) { notify("Could not read that file"); return; }
      const uploaded = await uploadMedia.mutateAsync(payload);
      await sendMessage({ text: kind === "video" ? "Video" : "Photo", kind, mediaUrl: uploaded.url, mediaName: uploaded.fileName, mediaMime: payload.contentType });
      notify("Media sent");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Media upload was cancelled or unavailable");
    }
  };

  const startVoiceNote = async () => {
    if (Platform.OS === "web") { notify("Voice notes are available in the mobile build"); return; }
    // Refused before the recorder starts. Letting somebody speak a note that cannot be uploaded
    // would waste the recording and leave the mic on for nothing.
    if (blockedOffline(OFFLINE_UPLOAD_MESSAGE)) return;
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
    // Stopping always stops the recorder - the recording happened and the mic has to be released.
    // Only the upload is refused, and the toast says so rather than the note vanishing silently.
    if (blockedOffline(OFFLINE_UPLOAD_MESSAGE)) return;
    const durationMs = Math.max(1000, Math.round((recorderState.durationMillis ?? 1000)));
    try {
      if (!isAuthenticated) { await sendMessage({ text: `Voice note · ${Math.round(durationMs / 1000)}s`, kind: "voice", mediaUrl: uri, voiceDurationMs: durationMs }); return; }
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const uploaded = await uploadMedia.mutateAsync({ fileName: `voice-${Date.now()}.m4a`, contentType: "audio/m4a", base64 });
      await sendMessage({ text: `Voice note · ${Math.round(durationMs / 1000)}s`, kind: "voice", mediaUrl: uploaded.url, mediaName: uploaded.fileName, voiceDurationMs: durationMs });
      notify("Voice note sent");
    } catch { notify("Voice note saved locally; reconnect to sync it"); }
  };

  const backendMessages: Message[] = (liveMessagesQuery.data ?? []).map((item) => ({
    id: item.id,
    text: item.deletedAt ? "This message was deleted" : item.body ?? item.mediaName ?? (item.kind === "voice" ? "Voice note" : item.kind === "poll" ? "Poll" : item.kind === "location" ? "Location" : item.kind === "contact" ? "Contact" : "Shared media"),
    time: new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    mine: item.senderId === user?.id,
    read: item.status === "read",
    kind: item.kind,
    mediaUrl: item.mediaUrl ?? undefined,
    mediaName: item.mediaName ?? undefined,
    mediaMime: item.mediaMime ?? undefined,
    voiceDurationMs: item.voiceDurationMs ?? undefined,
    starred: item.starred,
    kept: item.kept,
    pinnedAt: item.pinnedAt ? new Date(item.pinnedAt).toISOString() : null,
    scheduledAt: item.scheduledAt ? new Date(item.scheduledAt).toISOString() : null,
    viewOnce: item.viewOnce === 1,
    status: item.status,
    edited: Boolean(item.editedAt),
    deleted: Boolean(item.deletedAt),
    forwarded: Boolean(item.forwardedFromId),
    expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString() : undefined,
    reactions: item.reactions,
    quote: item.replyTo ?? undefined,
    votes: item.votes,
    meta: item.meta ?? undefined,
  }));

  // ---- the message menu ---------------------------------------------------------------
  // Every one of these now writes to the server. They previously raised a toast and saved
  // nothing, so the buttons looked functional while the other side never learned about them.
  const applyReaction = async (message: Message, emoji: string) => {
    setReactingToId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    const existing = (message.reactions ?? []).find((reaction) => reaction.userId === user?.id);
    // Tapping the reaction you already gave removes it, which is what people expect.
    try {
      await reactMessage.mutateAsync({ messageId: message.id, emoji: existing?.emoji === emoji ? null : emoji });
      await liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not add that reaction");
    }
  };

  const toggleStar = async (message: Message) => {
    setActiveMessageId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await starMessage.mutateAsync({ messageId: message.id, starred: !message.starred });
      await liveMessagesQuery.refetch();
      notify(message.starred ? "Removed from starred" : "Added to starred");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not star that message");
    }
  };

  // ---- pins, keeps and reports ----------------------------------------------------------
  // Message-level actions live on the conversations router, next to the other row operations.
  const pinMessage = trpc.conversations.pin.useMutation();
  const keepMessage = trpc.conversations.keep.useMutation();
  const reportMessage = trpc.reports.submit.useMutation();

  // ---- live location ---------------------------------------------------------------------
  const [showLocation, setShowLocation] = useState(false);
  const [myShareId, setMyShareId] = useState<string | null>(null);
  const locationQuery = trpc.locations.list.useQuery(
    { conversationId: selectedId ?? "" },
    { enabled: Boolean(selectedId) && isAuthenticated, refetchInterval: 10_000 },
  );
  const startLocation = trpc.locations.start.useMutation();
  const updateLocation = trpc.locations.update.useMutation();
  const stopLocation = trpc.locations.stop.useMutation();

  /** The interval that keeps a share moving. A ref so it survives re-renders. */
  const locationTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Asks the browser for a position once, as a promise. */
  const readPosition = () =>
    new Promise<{ lat: number; lng: number }>((resolve, reject) => {
      // Web only, for the same reason as screen sharing: the native shell has no location permission
      // model this code can drive.
      if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.geolocation) {
        reject(new Error("Sharing a live location needs the browser build."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        () => reject(new Error("Location permission was refused.")),
        { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
      );
    });

  const clearLocationTimer = () => {
    if (locationTimer.current) {
      clearInterval(locationTimer.current);
      locationTimer.current = null;
    }
  };

  const startSharing = async (durationMs: number) => {
    if (!selectedId) return;
    // A share is a live feed. Starting one offline would publish a position that is already stale by
    // the time it arrives, so it is refused rather than started and left frozen.
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    setShowLocation(false);
    try {
      const { lat, lng } = await readPosition();
      const started = await startLocation.mutateAsync({ conversationId: selectedId, lat, lng, durationMs });
      setMyShareId(started.id);
      await locationQuery.refetch();
      clearLocationTimer();
      // Browsers throttle timers in a hidden tab, so a share can fall behind while this one is in the
      // background. It catches up on the next tick rather than pretending to still be live.
      locationTimer.current = setInterval(() => {
        void readPosition()
          .then(({ lat: nextLat, lng: nextLng }) => updateLocation.mutateAsync({ id: started.id, lat: nextLat, lng: nextLng }))
          .then(() => locationQuery.refetch())
          .catch(() => undefined);
      }, 30_000);
      notify("Sharing your location");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not share your location");
    }
  };

  const stopSharing = async (id: string) => {
    // Local state is torn down either way - the timer must stop whether or not the server hears
    // about it. Refusing outright would leave a live share running on a device that thinks it
    // stopped.
    clearLocationTimer();
    setMyShareId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await stopLocation.mutateAsync({ id });
      await locationQuery.refetch();
      notify("Stopped sharing your location");
    } catch {
      notify("Could not stop that share");
    }
  };

  // Only the timer is torn down on unmount. The share keeps its own expiry, so closing a tab cannot
  // leave one running indefinitely.
  useEffect(() => () => clearLocationTimer(), []);

  // ---- send later -----------------------------------------------------------------------
  const [showSchedule, setShowSchedule] = useState(false);

  /**
   * The times offered, as offsets rather than a date picker.
   *
   * The app has no date picker and adding one is a dependency and a screen of its own, so these are
   * the handful of times people actually pick. Anything that has already passed is dropped rather
   * than offered and then refused by the server.
   */
  const schedulePresets = (() => {
    const now = new Date();
    const at = (dayOffset: number, hour: number) => {
      const when = new Date(now);
      when.setDate(when.getDate() + dayOffset);
      when.setHours(hour, 0, 0, 0);
      return when;
    };
    const monday = ((8 - now.getDay()) % 7) || 7;

    return [
      { label: "In 1 hour", when: new Date(now.getTime() + 60 * 60 * 1000) },
      { label: "In 3 hours", when: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
      { label: "This evening at 8pm", when: at(0, 20) },
      { label: "Tomorrow at 9am", when: at(1, 9) },
      { label: "Next Monday at 9am", when: at(monday, 9) },
    ].filter((option) => option.when.getTime() > now.getTime() + 60 * 1000);
  })();

  /**
   * Sends what is in the composer at a later time.
   *
   * Deliberately not routed through the local sendMessage helper: that one echoes the message into
   * the thread immediately, which for a scheduled message would look like it had already arrived.
   * The server withholds it from everyone else until its time comes.
   */
  const scheduleComposer = async (when: Date) => {
    const text = composerText.trim();
    if (!text || !selectedId) return;
    if (blockedOffline()) return;
    setShowSchedule(false);
    try {
      await sendRemoteMessage.mutateAsync({ conversationId: selectedId, body: text, kind: "text", scheduledAt: when.toISOString() });
      setComposerText("");
      setComposerSelection({ start: 0, end: 0 });
      await liveMessagesQuery.refetch();
      notify(`Scheduled for ${when.toLocaleString()}`);
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not schedule that message");
    }
  };
  const pinnedQuery = trpc.conversations.pinned.useQuery(
    { conversationId: selectedId ?? "" },
    { enabled: Boolean(selectedId) && isAuthenticated },
  );

  // ---- self chat and chat lock ----------------------------------------------------------
  const selfChat = trpc.conversations.selfChat.useMutation();
  const lockedChats = trpc.conversations.lockedChats.useQuery(undefined, { enabled: isAuthenticated });
  const verifyPin = trpc.security.verifyPin.useMutation();
  // Unlocked for this session only. A chat lock that survived a reload would still be open the next
  // time somebody picked the phone up, which is the situation it exists for.
  const [unlockedChats, setUnlockedChats] = useState<string[]>([]);
  const [chatPin, setChatPin] = useState("");
  const [chatPinError, setChatPinError] = useState<string | null>(null);

  const isChatLocked = Boolean(selectedId && lockedChats.data?.includes(selectedId) && !unlockedChats.includes(selectedId));

  /**
   * Opens the thread you have with yourself.
   *
   * Created on demand and reused: the conversation id is derived from the user id on the server, so
   * tapping this twice cannot leave you with two empty conversations.
   */
  const openSelfChat = () => {
    setShowContacts(false);
    selfChat.mutate(undefined, {
      onSuccess: (result) => {
        void conversationListQuery.refetch();
        setSelectedId(result.conversationId);
      },
      onError: (error) => notify(error.message),
    });
  };

  const tryUnlockChat = async () => {
    if (!selectedId) return;
    // The PIN is checked on the server. Offline the check would pause and the box would sit on
    // "Checking…" indefinitely, which reads as a wrong PIN.
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    setChatPinError(null);
    try {
      await verifyPin.mutateAsync({ pin: chatPin.trim() });
      setUnlockedChats((current) => (current.includes(selectedId) ? current : [...current, selectedId]));
      setChatPin("");
    } catch (error) {
      // verifyPin rejects on a wrong PIN, so its message is already the one worth showing.
      setChatPinError(error instanceof Error && error.message ? error.message : "That PIN is not right");
    }
  };
  // So the pinned banner can scroll the thread to the message it names.
  const messageListRef = useRef<FlatList<Message>>(null);
  // The message a report is being filed about, or null while the report sheet is closed.
  const [reportTarget, setReportTarget] = useState<Message | null>(null);
  const [reportCategory, setReportCategory] = useState<ReportCategory>("spam");
  const [reportNote, setReportNote] = useState("");

  const togglePin = async (message: Message) => {
    setActiveMessageId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await pinMessage.mutateAsync({ messageId: message.id, pinned: !message.pinnedAt });
      await Promise.all([liveMessagesQuery.refetch(), pinnedQuery.refetch()]);
      notify(message.pinnedAt ? "Unpinned" : "Pinned to this chat");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not pin that message");
    }
  };

  const toggleKeep = async (message: Message) => {
    setActiveMessageId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await keepMessage.mutateAsync({ messageId: message.id, kept: !message.kept });
      await liveMessagesQuery.refetch();
      notify(message.kept ? "No longer kept" : "Kept in this chat");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not keep that message");
    }
  };

  /** Unpinning from the banner, which knows the message only by id. */
  const unpinById = async (messageId: string) => {
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await pinMessage.mutateAsync({ messageId, pinned: false });
      await Promise.all([liveMessagesQuery.refetch(), pinnedQuery.refetch()]);
      notify("Unpinned");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not unpin that message");
    }
  };

  /**
   * Scrolls the thread to a message the banner names.
   *
   * The thread is paged, so a pin from long ago may not be loaded. Saying so is better than
   * scrolling somewhere that merely looks close.
   */
  const jumpToMessage = (messageId: string, loaded: Message[]) => {
    const index = loaded.findIndex((message) => message.id === messageId);
    if (index < 0) {
      notify("That message is further up this chat");
      return;
    }
    messageListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  };

  const sendReport = async () => {
    const target = reportTarget;
    if (!target) return;
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await reportMessage.mutateAsync({
        category: reportCategory,
        note: reportNote.trim() || undefined,
        messageId: target.id,
      });
      setReportTarget(null);
      setReportNote("");
      setReportCategory("spam");
      notify("Report sent for review");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not send that report");
    }
  };

  const beginEdit = (message: Message) => {
    setActiveMessageId(null);
    setEditingId(message.id);
    setComposerText(message.text);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const body = composerText.trim();
    if (!body) return;
    // The edit stays in the composer and the banner stays up, so nothing typed is lost and the
    // message is still in edit mode to try again.
    if (blockedOffline()) return;
    try {
      await editMessage.mutateAsync({ messageId: editingId, body });
      await liveMessagesQuery.refetch();
      setEditingId(null);
      setComposerText("");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not edit that message");
    }
  };

  const deleteMessage = async (message: Message, forEveryone: boolean) => {
    setActiveMessageId(null);
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await removeMessage.mutateAsync({ messageId: message.id, forEveryone });
      await liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not delete that message");
    }
  };

  const forwardTo = async (conversationId: string) => {
    const message = forwarding;
    if (!message) return;
    // Checked before the picker closes, so the message being forwarded is not dropped when the
    // forward is refused.
    if (blockedOffline()) return;
    setForwarding(null);
    try {
      await sendRemoteMessage.mutateAsync({ conversationId, body: message.text, kind: message.kind ?? "text", mediaUrl: message.mediaUrl, mediaName: message.mediaName, forwardedFromId: message.id });
      await liveMessagesQuery.refetch();
      notify("Forwarded");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not forward that message");
    }
  };

  // The server drops the stored copy as this resolves, so it only ever displays once.
  /** Opens an attachment in the system browser, where it can be viewed or saved. */
  // Saved stickers are only fetched while the picker is open.
  const stickersQuery = trpc.stickers.list.useQuery(undefined, { enabled: isAuthenticated });

  /**
   * Keeps the image behind a message as a sticker.
   *
   * The bytes have to go through the client because the server never holds them outside a message row;
   * fetch-and-encode is what makes "save that as a sticker" possible without an upload endpoint of its own.
   */
  const saveAsSticker = async (message: Message) => {
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    const url = resolveMediaUrl(message.mediaUrl);
    if (!url) {
      notify("That image is no longer available");
      return;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("fetch failed");
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(blob);
      });
      if (base64.length === 0) throw new Error("empty");
      await addSticker.mutateAsync({ base64, mimeType: blob.type || "image/png" });
      await stickersQuery.refetch();
      notify("Added to your stickers");
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not save that as a sticker");
    }
  };

  /** Sends one sticker to the open chat. */
  const sendSticker = async (stickerId: string) => {
    if (!selectedId) return;
    if (blockedOffline()) return;
    setShowStickers(false);
    try {
      await sendRemoteMessage.mutateAsync({ conversationId: selectedId, kind: "sticker", mediaUrl: `/api/sticker/${stickerId}` });
      void liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not send that sticker");
    }
  };

  const openAttachment = async (message: Message) => {
    const url = resolveMediaUrl(message.mediaUrl);
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      notify("Could not open that attachment");
    }
  };

  /** Follows a link a sender typed into a message body. */
  const openLink = (href: string) => {
    void Linking.openURL(href).catch(() => notify("Could not open that link"));
  };

  /**
   * Drops an emoji in at the caret.
   *
   * The offsets are clamped to the current text because the tracked selection can be a render behind
   * after an external change (a cleared composer, a completed mention), and slicing past the end
   * would silently insert nothing.
   */
  const insertEmoji = (emoji: string) => {
    setComposerText((current) => {
      const from = Math.max(0, Math.min(composerSelection.start, current.length));
      const to = Math.max(from, Math.min(composerSelection.end, current.length));
      return `${current.slice(0, from)}${emoji}${current.slice(to)}`;
    });
    setComposerSelection((current) => ({ start: current.start + emoji.length, end: current.start + emoji.length }));
  };

  /**
   * View-once video. The stored copy is consumed first, exactly as for a photo, so a failure to
   * play cannot leave the media readable afterwards.
   */
  const openVideoOnce = async (message: Message) => {
    // Opening a view-once message is a write: the server consumes the stored copy as it hands it
    // over. Offline that exchange cannot happen, and showing the media anyway would leave a copy
    // that the server still believes is unopened - readable again on the next launch.
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      const opened = await openViewOnce.mutateAsync({ messageId: message.id });
      setOnceVideo(resolveMediaUrl(opened.mediaUrl) ?? null);
      await liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "That video has already been opened");
    }
  };

  const openOnce = async (message: Message) => {
    // See openVideoOnce: the copy is consumed server-side, so this cannot be served offline.
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      const opened = await openViewOnce.mutateAsync({ messageId: message.id });
      setOncePreview(resolveMediaUrl(opened.mediaUrl) ?? null);
      await liveMessagesQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "That photo has already been opened");
    }
  };

  const toggleChatFlag = async (conversationId: string, flags: { pinned?: boolean; muted?: boolean; archived?: boolean }) => {
    setRowMenuId(null);
    // The row menu is dismissed above so it does not stay open over the list. The change itself is
    // refused, because a pinned chat that silently un-pins on the next sync is worse than a refusal.
    if (blockedOffline(OFFLINE_ACTION_MESSAGE)) return;
    try {
      await setFlags.mutateAsync({ conversationId, ...flags });
      await conversationListQuery.refetch();
    } catch (error) {
      notify(error instanceof Error && error.message ? error.message : "Could not update that chat");
    }
  };

  const onComposerChange = (value: string) => {
    setComposerText(value);
    if (!selectedId || !isAuthenticated) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    // Debounced: saving on every keystroke would be a request per character.
    draftTimer.current = setTimeout(() => {
      void setFlags.mutateAsync({ conversationId: selectedId, draft: value }).catch(() => undefined);
    }, 700);
  };

  // Varnox accounts matching the contact search. Built before the chat branch rather than beside
  // the chat-list helpers, because the share-a-contact sheet lives inside a conversation and needs
  // the same list.
  const remotePeople: ContactSuggestion[] = (peopleSearch.data ?? []).map((person, index) => {
    const name = person.name ?? person.email ?? "Varnox contact";
    return { id: String(person.id), name, initials: name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase(), color: ["#F59E0B", "#8B5CF6", "#10B981", "#EC4899", "#0EA5E9"][index % 5], email: person.email ?? undefined, userId: person.id, username: person.username ?? undefined };
  });

  if (selectedChat) {
    // Media loads by itself unless this chat has auto-download switched off. Undefined (an older row
    // from before the setting existed) loads, which is what it did then.
    const autoLoadsMedia = selectedChat.mediaAutoLoad !== false;
    // What this chat is, and therefore which info screen its header opens.
    const chatInfo = describeConversation(selectedChat);
    const chatMessages = isAuthenticated && liveMessagesQuery.data ? backendMessages : (messages[selectedChat.id] ?? []);
    // What the other side is doing, as far as I am allowed to see it. A direct chat has one peer,
    // so the first entry is the person; groups report typing but never presence.
    const peerRows = chatPresence.data ?? [];
    const peerTyping = peerRows.some((row) => row.typingIn === selectedChat.id);
    const peerOnline = peerRows.some((row) => row.online);
    const peerLastSeen = lastSeenLabel(peerRows.find((row) => row.lastSeenAt)?.lastSeenAt ?? null);
    // Pins are shared, so the banner shows the newest one. Anything the reader has hidden is already
    // filtered out server-side, which is why this can be rendered without a second check.
    const pins = pinnedQuery.data ?? [];
    const activePin = pins[0] ?? null;
    return (
      <ScreenContainer edges={["top", "bottom", "left", "right"]} containerClassName="bg-background">
        <StatusBar style="light" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={8}>
          <View style={[styles.chatHeader, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
            <Pressable onPress={() => setSelectedId(null)} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}><MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} /></Pressable>
            <Avatar item={selectedChat} size={40} />
            {/* Which screen this opens is decided by what the conversation is, not by this being the
                only info screen that existed. A 1:1 used to open the group screen, member list and
                "Leave group" and all. */}
            <Pressable onPress={() => router.push({ pathname: chatInfo.route, params: { conversationId: selectedChat.id } })} style={styles.chatTitleBlock}><Text style={[styles.chatTitle, { color: colors.foreground }]}>{selectedChat.name}</Text><Text style={[styles.chatSubtitle, { color: peerTyping || peerOnline ? colors.primary : colors.muted }]}>{peerTyping ? "typing…" : peerOnline ? "online" : peerLastSeen ?? chatInfo.subtitle}</Text></Pressable>
            <IconButton name="timer" color={selectedChat.disappearSeconds ? colors.primary : colors.muted} onPress={() => setShowTimer((current) => !current)} />
            <IconButton name="more-vert" color={colors.muted} onPress={() => router.push({ pathname: "/chat/chat-settings", params: { conversationId: selectedChat.id } })} />
            {/* Refused here rather than inside startCall so the answer is a toast in the header
                rather than the full call overlay appearing only to report an error. */}
            <IconButton name="videocam" dimmed={!online} color={online ? colors.primary : colors.muted} onPress={() => { if (blockedOffline(OFFLINE_CALL_MESSAGE)) return; void startCall({ conversationId: selectedChat.id, kind: "video", peerName: selectedChat.name }); }} />
            <IconButton name="call" dimmed={!online} color={online ? colors.primary : colors.muted} onPress={() => { if (blockedOffline(OFFLINE_CALL_MESSAGE)) return; void startCall({ conversationId: selectedChat.id, kind: "audio", peerName: selectedChat.name }); }} />
          </View>
          <OfflineBanner />
          {/*
            A group whose only member is you. Every message sent from here is stored and delivered to
            nobody, and until this banner existed there was nothing on the screen to say so - which is
            how somebody ends up asking a friend why they cannot see any of their messages.
          */}
          {isStrandedGroup(selectedChat) ? <View style={[styles.strandedBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}><MaterialIcons name="error-outline" size={16} color={colors.warning} /><Text style={[styles.strandedText, { color: colors.muted }]}>You are the only member of this group. Nobody else receives what you send here - open it from the new-conversation sheet to start a one-to-one chat instead.</Text></View> : null}
          {showTimer ? <View style={[styles.timerSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.timerHeading, { color: colors.muted }]}>Disappearing messages</Text>{([[null, "Off"], [86400, "24 hours"], [604800, "7 days"], [7776000, "90 days"]] as Array<[number | null, string]>).map(([seconds, label]) => <Pressable key={label} onPress={() => { setShowTimer(false); if (!selectedId) return; void setDisappearing.mutateAsync({ conversationId: selectedId, seconds }).then(() => conversationListQuery.refetch()).catch((error) => notify(error instanceof Error && error.message ? error.message : "Could not update the timer")); }} style={styles.timerOption}><Text style={[styles.timerLabel, { color: (selectedChat.disappearSeconds ?? null) === seconds ? colors.primary : colors.foreground }]}>{label}</Text>{(selectedChat.disappearSeconds ?? null) === seconds ? <MaterialIcons name="check" size={17} color={colors.primary} /> : null}</Pressable>)}<Text style={[styles.timerNote, { color: colors.muted }]}>New messages disappear for everyone. Already-sent ones are left alone.</Text></View> : null}
          <LiveLocationBar shares={(locationQuery.data ?? []) as LiveShare[]} myUserId={myUserId} onStop={(id) => void stopSharing(id)} />
          {isChatLocked ? <View style={[styles.chatLock, { backgroundColor: colors.background }]}><MaterialIcons name="lock" size={30} color={colors.primary} /><Text style={[styles.chatLockTitle, { color: colors.foreground }]}>This chat is locked</Text><Text style={[styles.chatLockCopy, { color: colors.muted }]}>Enter your PIN to open it. It locks again when you close the app.</Text><TextInput value={chatPin} onChangeText={setChatPin} placeholder="PIN" placeholderTextColor={colors.muted} secureTextEntry keyboardType="number-pad" maxLength={16} style={[styles.chatLockInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />{chatPinError ? <Text style={[styles.chatLockError, { color: colors.error }]}>{chatPinError}</Text> : null}<Pressable disabled={!chatPin.trim() || verifyPin.isPending} onPress={() => void tryUnlockChat()} style={[styles.chatLockButton, { backgroundColor: colors.primary, opacity: !chatPin.trim() || verifyPin.isPending ? 0.5 : 1 }]}><Text style={styles.chatLockButtonText}>{verifyPin.isPending ? "Checking…" : "Unlock"}</Text></Pressable></View> : null}
          {activePin ? <Pressable onPress={() => jumpToMessage(activePin.id, chatMessages)} style={[styles.pinBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}><MaterialIcons name="push-pin" size={15} color={colors.primary} style={styles.pin} /><View style={styles.pinCopy}><Text style={[styles.pinSender, { color: colors.primary }]} numberOfLines={1}>{activePin.senderName}</Text><Text style={[styles.pinBody, { color: colors.muted }]} numberOfLines={1}>{activePin.body ?? activePin.mediaName ?? "Attachment"}</Text></View>{pins.length > 1 ? <Text style={[styles.pinCount, { color: colors.muted }]}>{pins.length} pinned</Text> : null}<Pressable onPress={() => void unpinById(activePin.id)} hitSlop={10}><MaterialIcons name="close" size={16} color={colors.muted} /></Pressable></Pressable> : null}
          <FlatList ref={messageListRef} onScrollToIndexFailed={() => notify("That message is further up this chat")} data={chatMessages} keyExtractor={(item) => item.id} contentContainerStyle={styles.messageList} showsVerticalScrollIndicator={false} ListHeaderComponent={<View style={styles.encryptionNote}><MaterialIcons name={selectedChat.disappearSeconds ? "timer" : "lock"} size={13} color={colors.muted} /><Text style={[styles.encryptionText, { color: colors.muted }]}>{selectedChat.disappearSeconds ? `Messages disappear after ${disappearLabel(selectedChat.disappearSeconds)}` : isAuthenticated ? "Live sync enabled" : "Messages are private and secure"}</Text></View>} renderItem={({ item }) => <Pressable onLongPress={() => setActiveMessageId(activeMessageId === item.id ? null : item.id)} style={[styles.messageRow, item.mine ? styles.messageRowMine : styles.messageRowTheirs]}><View style={[styles.bubble, item.mine ? [styles.bubbleMine, { backgroundColor: colors.bubbleOutgoing }] : [styles.bubbleTheirs, { backgroundColor: colors.bubbleIncoming }]]}>
            {item.quote ? <View style={[styles.quoteBlock, { borderLeftColor: item.mine ? colors.bubbleOutgoingText : colors.primary }]}><Text style={[styles.quoteName, { color: item.mine ? colors.bubbleOutgoingText : colors.primary }]} numberOfLines={1}>{item.quote.senderName}</Text><Text style={[styles.quoteBody, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]} numberOfLines={2}>{item.quote.deleted ? "This message was deleted" : item.quote.body ?? item.quote.mediaName ?? "Attachment"}</Text></View> : null}
            {item.forwarded && !item.deleted ? <View style={styles.forwardRow}><MaterialIcons name="forward" size={12} color={item.mine ? colors.bubbleOutgoingText : colors.muted} /><Text style={[styles.forwardText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>Forwarded</Text></View> : null}
            {item.deleted ? <Text style={[styles.deletedText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>This message was deleted</Text> : null}
            {!item.deleted && item.viewOnce && item.kind === "image" ? (item.mediaUrl ? <Pressable onPress={() => void openOnce(item)} style={styles.onceTile}><MaterialIcons name="visibility" size={22} color="#FFFFFF" /><Text style={styles.onceTileText}>Tap to view once</Text></Pressable> : <View style={styles.onceGone}><MaterialIcons name="visibility-off" size={15} color={item.mine ? colors.bubbleOutgoingText : colors.muted} /><Text style={[styles.onceGoneText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>Photo opened</Text></View>) : null}
            {!item.deleted && !item.viewOnce && item.mediaUrl && item.kind === "image" ? (autoLoadsMedia || loadedMedia.includes(item.id) ? <Image source={{ uri: resolveMediaUrl(item.mediaUrl) }} style={styles.messageImage} resizeMode="cover" /> : <Pressable onPress={() => setLoadedMedia((current) => [...current, item.id])} style={[styles.mediaHeld, { borderColor: item.mine ? colors.bubbleOutgoingText : colors.border }]}><MaterialIcons name="image" size={20} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /><Text style={[styles.mediaHeldText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>Photo not downloaded · tap to load</Text></Pressable>) : null}
            {!item.deleted && item.viewOnce && item.kind === "video" ? (item.mediaUrl ? <Pressable onPress={() => void openVideoOnce(item)} style={styles.onceTile}><MaterialIcons name="visibility" size={22} color="#FFFFFF" /><Text style={styles.onceTileText}>Tap to view once</Text></Pressable> : <View style={styles.onceGone}><MaterialIcons name="visibility-off" size={15} color={item.mine ? colors.bubbleOutgoingText : colors.muted} /><Text style={[styles.onceGoneText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>Video opened</Text></View>) : null}
            {!item.deleted && item.kind === "sticker" && item.mediaUrl ? <Image source={{ uri: resolveMediaUrl(item.mediaUrl) }} style={styles.stickerImage} resizeMode="contain" /> : null}
            {!item.deleted && !item.viewOnce && item.mediaUrl && item.kind === "video" ? (autoLoadsMedia || loadedMedia.includes(item.id) ? <VideoMessage uri={resolveMediaUrl(item.mediaUrl) ?? ""} style={styles.messageVideo} /> : <Pressable onPress={() => setLoadedMedia((current) => [...current, item.id])} style={[styles.mediaHeld, { borderColor: item.mine ? colors.bubbleOutgoingText : colors.border }]}><MaterialIcons name="videocam" size={20} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /><Text style={[styles.mediaHeldText, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>Video not downloaded · tap to load</Text></Pressable>) : null}
            {!item.deleted && item.kind === "file" ? <Pressable onPress={() => void openAttachment(item)} style={styles.fileTile}><View style={[styles.fileIcon, { backgroundColor: item.mine ? "rgba(255,255,255,0.18)" : colors.background }]}><MaterialIcons name={attachmentKind(item.mediaMime).icon} size={20} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /></View><View style={styles.fileCopy}><Text style={[styles.fileName, { color: item.mine ? colors.bubbleOutgoingText : colors.foreground }]} numberOfLines={1}>{item.mediaName ?? "Attachment"}</Text><Text style={[styles.fileMeta, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>{attachmentKind(item.mediaMime).label} · Tap to open</Text></View><MaterialIcons name="open-in-new" size={17} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /></Pressable> : null}
            {item.kind === "voice" ? <VoiceNoteBubble message={item} mine={Boolean(item.mine)} colors={colors} /> : null}
            {!item.deleted && item.kind === "poll" && item.meta?.kind === "poll" ? <PollBubble meta={item.meta} votes={item.votes ?? []} myUserId={user?.id} mine={Boolean(item.mine)} colors={colors} onVote={(index) => void castVote(item, index)} /> : null}
            {!item.deleted && item.kind === "contact" && item.meta?.kind === "contact" ? <Pressable onPress={() => openSharedContact(item.meta)} style={styles.contactCard}><View style={[styles.contactCardAvatar, { backgroundColor: chatColor(item.meta.name) }]}><Text style={styles.contactCardInitials}>{chatInitials(item.meta.name)}</Text></View><View style={styles.contactCardCopy}><Text style={[styles.contactCardName, { color: item.mine ? colors.bubbleOutgoingText : colors.foreground }]} numberOfLines={1}>{item.meta.name}</Text><Text style={[styles.contactCardMeta, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]} numberOfLines={1}>{item.meta.username ? `@${item.meta.username}` : item.meta.phone ?? "Varnox contact"}</Text></View><MaterialIcons name="chat-bubble-outline" size={17} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /></Pressable> : null}
            {item.kind !== "voice" && item.kind !== "file" && item.kind !== "poll" && item.kind !== "contact" && item.kind !== "sticker" && (item.kind !== "image" || !item.mediaUrl) ? <MessageText text={item.text} names={mentionNames} style={[styles.messageText, { color: item.mine ? colors.bubbleOutgoingText : colors.foreground }]} mentionStyle={[styles.mention, { color: colors.primary }]} linkStyle={[styles.link, { color: item.mine ? colors.bubbleOutgoingText : colors.primary }]} onPressLink={openLink} /> : null}
            {!item.deleted && item.kind === "text" && item.text ? <LinkPreviewCard text={item.text} mine={Boolean(item.mine)} /> : null}
            <View style={styles.messageMeta}>{item.edited ? <Text style={[styles.editedTag, { color: item.mine ? colors.bubbleOutgoingText : colors.muted }]}>edited</Text> : null}<Text style={[styles.messageTime, { color: item.mine ? colors.bubbleOutgoingText : colors.muted, opacity: item.mine ? 0.75 : 1 }]}>{item.time}</Text>{item.starred ? <MaterialIcons name="star" size={13} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /> : null}{item.kept ? <MaterialIcons name="bookmark" size={13} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /> : null}{item.scheduledAt && new Date(item.scheduledAt).getTime() > Date.now() ? <MaterialIcons name="schedule" size={13} color={item.mine ? colors.bubbleOutgoingText : colors.primary} /> : null}<MessageTicks status={item.status} color={item.mine ? colors.bubbleOutgoingText : colors.muted} readColor="#53BDEB" /></View>
          </View>{item.reactions && item.reactions.length > 0 ? <View style={styles.reactionRow}>{item.reactions.map((reaction) => <View key={`${item.id}-${reaction.userId}`} style={[styles.reactionChip, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={styles.reactionEmoji}>{reaction.emoji}</Text></View>)}</View> : null}{reactingToId === item.id ? <View style={[styles.reactionPicker, { backgroundColor: colors.surface, borderColor: colors.border }]}>{REACTION_EMOJIS.map((emoji) => <Pressable key={emoji} onPress={() => void applyReaction(item, emoji)} hitSlop={6}><Text style={styles.reactionEmoji}>{emoji}</Text></Pressable>)}</View> : null}{activeMessageId === item.id ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.actionsScroll} contentContainerStyle={[styles.messageActions, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => { setReplyTo({ id: item.id, text: item.text, senderName: item.mine ? "You" : selectedChat.name }); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Reply</Text></Pressable><Pressable onPress={() => { setReactingToId(item.id); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>React</Text></Pressable><Pressable onPress={() => void toggleStar(item)}><Text style={[styles.actionText, { color: colors.foreground }]}>{item.starred ? "Unstar" : "Star"}</Text></Pressable><Pressable onPress={() => { setForwarding(item); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Forward</Text></Pressable><Pressable onPress={() => void togglePin(item)}><Text style={[styles.actionText, { color: colors.foreground }]}>{item.pinnedAt ? "Unpin" : "Pin"}</Text></Pressable>{item.expiresAt ? <Pressable onPress={() => void toggleKeep(item)}><Text style={[styles.actionText, { color: colors.foreground }]}>{item.kept ? "Stop keeping" : "Keep in chat"}</Text></Pressable> : null}{item.kind === "image" && item.mediaUrl && !item.viewOnce ? <Pressable onPress={() => { setActiveMessageId(null); void saveAsSticker(item); }}><Text style={[styles.actionText, { color: colors.foreground }]}>Save as sticker</Text></Pressable> : null}{item.mine && !item.deleted && item.kind === "text" ? <Pressable onPress={() => beginEdit(item)}><Text style={[styles.actionText, { color: colors.foreground }]}>Edit</Text></Pressable> : null}<Pressable onPress={() => void deleteMessage(item, false)}><Text style={[styles.actionText, { color: colors.foreground }]}>Delete for me</Text></Pressable>{item.mine && !item.deleted ? <Pressable onPress={() => void deleteMessage(item, true)}><Text style={[styles.actionText, { color: colors.error }]}>Delete for everyone</Text></Pressable> : null}{!item.mine && !item.deleted ? <Pressable onPress={() => { setReportTarget(item); setActiveMessageId(null); }}><Text style={[styles.actionText, { color: colors.error }]}>Report</Text></Pressable> : null}</ScrollView> : null}</Pressable>} />
          <View style={[styles.composerArea, { borderTopColor: colors.border, backgroundColor: colors.background }]}>{editingId ? <Pressable onPress={() => { setEditingId(null); setComposerText(""); }} style={[styles.replyBanner, { backgroundColor: colors.surface }]}><View style={styles.replyBannerCopy}><Text style={[styles.replySender, { color: colors.primary }]}>Editing message</Text><Text style={[styles.replyText, { color: colors.muted }]} numberOfLines={1}>{composerText}</Text></View><MaterialIcons name="close" size={16} color={colors.muted}/></Pressable> : replyTo ? <Pressable onPress={() => setReplyTo(null)} style={[styles.replyBanner, { backgroundColor: colors.surface }]}><View style={styles.replyBannerCopy}><Text style={[styles.replySender, { color: colors.primary }]}>{replyTo.senderName}</Text><Text style={[styles.replyText, { color: colors.muted }]} numberOfLines={1}>{replyTo.text}</Text></View><MaterialIcons name="close" size={16} color={colors.muted}/></Pressable> : null}{mentionSuggestions.length > 0 ? <View style={[styles.mentionBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>{mentionSuggestions.map((name) => <Pressable key={name} onPress={() => setComposerText((current) => completeMention(current, name))} style={[styles.mentionChip, { borderColor: colors.border }]}><Text style={[styles.mentionChipText, { color: colors.primary }]}>{name}</Text></Pressable>)}</View> : null}<View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}><IconButton name="add" color={colors.muted} onPress={() => setShowAttach((current) => !current)} /><Pressable onPress={() => setViewOnce(!viewOnce)} style={[styles.viewOnce, viewOnce && { backgroundColor: colors.primary }]}><Text style={[styles.viewOnceText, { color: viewOnce ? "#FFFFFF" : colors.muted }]}>1</Text></Pressable><TextInput value={composerText} onChangeText={onComposerChange} onSelectionChange={(event) => setComposerSelection(event.nativeEvent.selection)} placeholder={editingId ? "Edit message" : "Write a message"} placeholderTextColor={colors.muted} style={[styles.composerInput, { color: colors.foreground }]} multiline maxLength={500} /><IconButton name="my-location" color={showLocation || myShareId ? colors.primary : colors.muted} onPress={() => { setShowAttach(false); setShowEmoji(false); setShowSchedule(false); setShowLocation((current) => !current); }} /><IconButton name="schedule" color={showSchedule ? colors.primary : colors.muted} onPress={() => { setShowAttach(false); setShowEmoji(false); setShowLocation(false); setShowSchedule((current) => !current); }} /><IconButton name="mood" color={showEmoji ? colors.primary : colors.muted} onPress={() => { setShowAttach(false); setShowEmoji((current) => !current); }} /></View>{showEmoji ? <EmojiPicker colors={colors} onSelect={insertEmoji} onClose={() => setShowEmoji(false)} /> : null}{showAttach ? <View style={styles.attachSheet}><Pressable onPress={() => { setShowAttach(false); void shareMedia(); }} style={[styles.attachOption, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="perm-media" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.foreground }]}>Photo or video</Text></Pressable><Pressable onPress={() => { setShowAttach(false); void shareDocument(); }} style={[styles.attachOption, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="attach-file" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.foreground }]}>Document</Text></Pressable><Pressable onPress={() => { setShowAttach(false); setPollDraft({ question: "", options: ["", ""] }); }} style={[styles.attachOption, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="poll" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.foreground }]}>Poll</Text></Pressable><Pressable onPress={() => { setShowAttach(false); setShowShareContact(true); }} style={[styles.attachOption, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="contact-page" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.foreground }]}>Contact</Text></Pressable><Pressable onPress={() => { setShowAttach(false); setShowStickers(true); }} style={[styles.attachOption, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="emoji-emotions" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.foreground }]}>Sticker</Text></Pressable></View> : null}<Pressable onPress={editingId ? () => void saveEdit() : composerText.trim() ? () => void sendMessage() : recorderState.isRecording ? () => void stopVoiceNote() : () => void startVoiceNote()} style={({ pressed }) => [styles.sendButton, { backgroundColor: recorderState.isRecording ? colors.error : colors.primary }, !online && styles.dimmed, pressed && styles.sendPressed]}><MaterialIcons name={editingId ? "check" : composerText.trim() ? "send" : recorderState.isRecording ? "stop" : "mic"} size={21} color="#FFFFFF" /></Pressable></View>
          {onceVideo ? <View style={styles.overlay}><VideoMessage uri={onceVideo} style={styles.overlayVideo} /><Text style={styles.overlayNote}>This video can only be opened once. The stored copy has already been removed.</Text><Pressable onPress={() => setOnceVideo(null)} style={styles.overlayClose}><Text style={styles.overlayCloseText}>Close</Text></Pressable></View> : null}
          {showLocation ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Share your location</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>It stops on its own, and you can stop it sooner</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowLocation(false)} /></View><ScrollView contentContainerStyle={styles.pollBuilder}>{[{ label: "15 minutes", ms: 15 * 60_000 }, { label: "1 hour", ms: 60 * 60_000 }, { label: "8 hours", ms: 8 * 60 * 60_000 }].map((option) => <Pressable key={option.label} disabled={!selectedId} onPress={() => void startSharing(option.ms)} style={({ pressed }) => [styles.scheduleRow, { borderColor: colors.border, backgroundColor: colors.surface, opacity: selectedId ? 1 : 0.5 }, pressed && styles.pressed]}><MaterialIcons name="my-location" size={17} color={colors.primary} /><Text style={[styles.scheduleLabel, { color: colors.foreground }]}>{option.label}</Text></Pressable>)}<Text style={[styles.locationNote, { color: colors.muted }]}>{`Your position updates roughly every 30 seconds while this tab is open. Everyone in the chat can see it until it expires.`}</Text></ScrollView></View> : null}
          {showSchedule ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Send later</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Nobody else sees it until then</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowSchedule(false)} /></View><ScrollView contentContainerStyle={styles.pollBuilder} keyboardShouldPersistTaps="handled"><View style={[styles.reportQuote, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.reportQuoteText, { color: composerText.trim() ? colors.foreground : colors.muted }]} numberOfLines={3}>{composerText.trim() || "Type a message first, then pick a time."}</Text></View>{schedulePresets.map((option) => <Pressable key={option.label} disabled={!composerText.trim()} onPress={() => void scheduleComposer(option.when)} style={({ pressed }) => [styles.scheduleRow, { borderColor: colors.border, backgroundColor: colors.surface, opacity: composerText.trim() ? 1 : 0.5 }, pressed && styles.pressed]}><MaterialIcons name="schedule" size={17} color={colors.primary} /><Text style={[styles.scheduleLabel, { color: colors.foreground }]}>{option.label}</Text><Text style={[styles.scheduleTime, { color: colors.muted }]}>{option.when.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</Text></Pressable>)}</ScrollView></View> : null}
          {reportTarget ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Report this message</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>A moderator sees a copy of it, even if it is deleted later</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setReportTarget(null)} /></View><ScrollView contentContainerStyle={styles.pollBuilder} keyboardShouldPersistTaps="handled"><View style={[styles.reportQuote, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.reportQuoteText, { color: colors.muted }]} numberOfLines={3}>{reportTarget.text}</Text></View><View style={styles.reportChips}>{REPORT_CATEGORIES.map((category) => <Pressable key={category} onPress={() => setReportCategory(category)} style={[styles.reportChip, { borderColor: reportCategory === category ? colors.primary : colors.border, backgroundColor: reportCategory === category ? colors.primary : colors.surface }]}><Text style={[styles.reportChipText, { color: reportCategory === category ? "#FFFFFF" : colors.foreground }]}>{category}</Text></Pressable>)}</View><TextInput value={reportNote} onChangeText={setReportNote} placeholder="Anything the moderator should know (optional)" placeholderTextColor={colors.muted} style={[styles.pollInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} multiline maxLength={1000} /><Pressable onPress={() => void sendReport()} disabled={reportMessage.isPending} style={({ pressed }) => [styles.pollSend, { backgroundColor: colors.error }, pressed && styles.sendPressed]}><MaterialIcons name="send" size={18} color="#FFFFFF" /><Text style={styles.reportSendText}>{reportMessage.isPending ? "Sending…" : "Send report"}</Text></Pressable></ScrollView></View> : null}
          {showStickers ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Stickers</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Long-press a photo in a chat and choose Save as sticker</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowStickers(false)} /></View><FlatList data={stickersQuery.data ?? []} keyExtractor={(item) => item.id} numColumns={4} columnWrapperStyle={styles.stickerRow} contentContainerStyle={styles.stickerGrid} ListEmptyComponent={<Text style={[styles.emptyCopy, { color: colors.muted }]}>{stickersQuery.isLoading ? "Loading…" : "No stickers yet. Save one from a photo you have sent or received."}</Text>} renderItem={({ item }) => <Pressable onPress={() => void sendSticker(item.id)} style={({ pressed }) => [styles.stickerTile, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.rowPressed]}><Image source={{ uri: `/api/sticker/${item.id}` }} style={styles.stickerThumb} resizeMode="contain" /></Pressable>} /></View> : null}
      {showShareContact ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Share a contact</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Send a Varnox account as a card</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowShareContact(false)} /></View><View style={[styles.searchWrap, styles.contactSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="search" size={20} color={colors.muted}/><TextInput value={contactQuery} onChangeText={setContactQuery} placeholder="Search by name or username" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]}/></View><FlatList data={remotePeople} keyExtractor={(item) => item.id} contentContainerStyle={styles.contactList} ListEmptyComponent={<Text style={[styles.emptyCopy, { color: colors.muted }]}>{contactQuery.trim().length < 2 ? "Type at least two characters to search." : peopleSearch.isFetching ? "Searching…" : `No Varnox account matches “${contactQuery.trim()}”.`}</Text>} renderItem={({ item }) => <Pressable onPress={() => void sendContactCard(item)} style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}><View style={[styles.contactAvatar, { backgroundColor: item.color }]}><Text style={styles.contactInitials}>{item.initials}</Text></View><View style={styles.contactCopy}><Text style={[styles.chatName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text><Text style={[styles.chatPreview, { color: colors.muted }]} numberOfLines={1}>{item.username ? `@${item.username}` : item.email ?? "Varnox account"}</Text></View><MaterialIcons name="send" size={18} color={colors.primary} /></Pressable>} /></View> : null}
          {pollDraft ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>New poll</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>One question, at least two answers</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setPollDraft(null)} /></View><ScrollView contentContainerStyle={styles.pollBuilder} keyboardShouldPersistTaps="handled"><TextInput value={pollDraft.question} onChangeText={(question) => setPollDraft((current) => (current ? { ...current, question } : current))} placeholder="Question" placeholderTextColor={colors.muted} style={[styles.pollInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} maxLength={300} />{pollDraft.options.map((option, index) => <TextInput key={`poll-option-${index}`} value={option} onChangeText={(value) => setPollDraft((current) => (current ? { ...current, options: current.options.map((existing, position) => (position === index ? value : existing)) } : current))} placeholder={`Answer ${index + 1}`} placeholderTextColor={colors.muted} style={[styles.pollInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} maxLength={120} />)}{pollDraft.options.length < 12 ? <Pressable onPress={() => setPollDraft((current) => (current ? { ...current, options: [...current.options, ""] } : current))} style={({ pressed }) => [styles.pollAddOption, pressed && styles.rowPressed]}><MaterialIcons name="add" size={18} color={colors.primary} /><Text style={[styles.attachLabel, { color: colors.primary }]}>Add answer</Text></Pressable> : null}<Pressable onPress={() => void sendPoll()} style={({ pressed }) => [styles.pollSend, { backgroundColor: colors.primary }, pressed && styles.sendPressed]}><MaterialIcons name="send" size={18} color="#FFFFFF" /><Text style={styles.pollSendText}>Create poll</Text></Pressable></ScrollView></View> : null}
          {oncePreview ? <View style={styles.overlay}><Image source={{ uri: oncePreview }} style={styles.overlayImage} resizeMode="contain" /><Text style={styles.overlayNote}>This photo can only be opened once. The stored copy has already been removed.</Text><Pressable onPress={() => setOncePreview(null)} style={styles.overlayClose}><Text style={styles.overlayCloseText}>Close</Text></Pressable></View> : null}
        </KeyboardAvoidingView>
      </ScreenContainer>
    );
  }

  const discoveredPeople = [...remotePeople, ...deviceContacts].filter((person, index, list) => list.findIndex((candidate) => candidate.name === person.name) === index).filter((person) => `${person.name} ${person.email ?? ""} ${person.phone ?? ""}`.toLowerCase().includes(contactQuery.toLowerCase()));

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="light" />
      <View style={styles.header}><Text style={[styles.heading, { color: colors.foreground }]}>Messages</Text><View style={styles.headerActions}><IconButton name="camera-alt" color={colors.foreground} onPress={() => notify("Camera ready")} /><IconButton name="more-horiz" color={colors.foreground} onPress={() => setShowMenu((current) => !current)} /></View></View>
      <OfflineBanner />
      {showMenu ? <View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => { setChatFilter("all"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="forum" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>All chats</Text></Pressable><Pressable onPress={() => { setChatFilter("unread"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="mark-chat-unread" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Unread</Text></Pressable><Pressable onPress={() => { setChatFilter("groups"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="groups" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Groups</Text></Pressable><Pressable onPress={() => { setChatFilter("archived"); setShowMenu(false); }} style={styles.menuItem}><MaterialIcons name="archive" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Archived</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/search"); }} style={styles.menuItem}><MaterialIcons name="manage-search" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Search messages</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/starred"); }} style={styles.menuItem}><MaterialIcons name="star-border" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Starred messages</Text></Pressable><Pressable onPress={() => { setShowMenu(false); router.push("/chat/new-group"); }} style={styles.menuItem}><MaterialIcons name="group-add" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>New group</Text></Pressable><Pressable onPress={() => { setShowMenu(false); Platform.OS === "web" ? requestWebNotifications() : notify(isAuthenticated ? "Push notifications are registered" : "Sign in to enable push notifications"); }} style={styles.menuItem}><MaterialIcons name="notifications-active" size={18} color={colors.foreground}/><Text style={[styles.menuText, { color: colors.foreground }]}>Notification setup</Text></Pressable></View> : null}
      <View style={[styles.searchWrap, { backgroundColor: colors.surface, borderColor: searchFocused ? colors.primary : colors.border }, searchFocused && styles.searchWrapFocused]}><MaterialIcons name="search" size={20} color={searchFocused ? colors.primary : colors.muted} /><TextInput value={query} onChangeText={setQuery} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} placeholder="Search conversations" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} returnKeyType="search" />{query ? <Pressable onPress={() => setQuery("")} hitSlop={8} style={styles.searchClear}><MaterialIcons name="close" size={18} color={colors.muted} /></Pressable> : null}</View>
      <View style={styles.listHeader}><Text style={[styles.sectionLabel, { color: colors.muted }]}>RECENT</Text><Text style={[styles.countLabel, { color: colors.muted }]}>{filteredConversations.length} {filteredConversations.length === 1 ? "chat" : "chats"}</Text></View>
      <FlatList data={filteredConversations} keyExtractor={(item) => item.id} contentContainerStyle={styles.chatList} showsVerticalScrollIndicator={false} ListEmptyComponent={<View style={styles.emptyState}><MaterialIcons name={query.trim() || chatFilter !== "all" ? "search-off" : "forum"} size={34} color={colors.muted}/><Text style={[styles.emptyTitle, { color: colors.foreground }]}>{query.trim() ? "No chats match that search" : chatFilter === "unread" ? "Nothing unread" : chatFilter === "groups" ? "No groups yet" : "No chats yet"}</Text><Text style={[styles.emptyCopy, { color: colors.muted }]}>{query.trim() ? "Try a different name or message." : chatFilter === "unread" ? "You are all caught up." : "Start one and it will show up here."}</Text>{!query.trim() && chatFilter === "all" ? <Pressable onPress={() => setShowContacts(true)} style={({ pressed }) => [styles.emptyCta, { backgroundColor: colors.primary }, pressed && styles.rowPressed]}><MaterialIcons name="chat-bubble-outline" size={18} color="#FFFFFF" /><Text style={[styles.emptyCtaText, { color: "#FFFFFF" }]}>Start a chat</Text></Pressable> : null}</View>} renderItem={({ item }) => <Pressable onPress={() => setSelectedId(item.id)} onLongPress={() => setRowMenuId(rowMenuId === item.id ? null : item.id)} style={({ pressed }) => [styles.chatRow, pressed && styles.rowPressed]}><View style={styles.avatarWrap}><Avatar item={item}/>{inboxPresence.get(item.id)?.online ? <View style={[styles.onlineDot, { borderColor: colors.background }]} /> : null}</View><View style={[styles.chatCopy, { borderBottomColor: colors.border }]}><View style={styles.rowTop}><Text style={[styles.chatName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text><Text style={[styles.chatTime, { color: item.unread ? colors.primary : colors.muted }]}>{item.time}</Text></View><View style={styles.rowBottom}><View style={styles.previewLine}>{item.pinned ? <MaterialIcons name="push-pin" size={13} color={colors.muted} style={styles.pin}/> : null}<Text style={[styles.chatPreview, { color: inboxPresence.get(item.id)?.typing || item.unread || item.draft ? colors.foreground : colors.muted }]} numberOfLines={1}>{!item.draft && inboxPresence.get(item.id)?.typing ? <Text style={{ color: colors.primary }}>typing…</Text> : <>{item.draft ? <Text style={{ color: colors.primary }}>Draft: </Text> : null}{item.draft ?? item.preview}</>}</Text></View>{item.muted ? <MaterialIcons name="volume-off" size={15} color={colors.muted} /> : null}{item.unread ? <View style={[styles.unread, { backgroundColor: colors.unreadBadge }]}><Text style={styles.unreadText}>{item.unread}</Text></View> : null}</View>{rowMenuId === item.id ? <View style={[styles.rowMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => void toggleChatFlag(item.id, { pinned: !item.pinned })} style={styles.rowMenuItem}><MaterialIcons name="push-pin" size={15} color={colors.foreground}/><Text style={[styles.rowMenuText, { color: colors.foreground }]}>{item.pinned ? "Unpin" : "Pin"}</Text></Pressable><Pressable onPress={() => void toggleChatFlag(item.id, { muted: !item.muted })} style={styles.rowMenuItem}><MaterialIcons name={item.muted ? "notifications-active" : "notifications-off"} size={15} color={colors.foreground}/><Text style={[styles.rowMenuText, { color: colors.foreground }]}>{item.muted ? "Unmute" : "Mute"}</Text></Pressable><Pressable onPress={() => void toggleChatFlag(item.id, { archived: !item.archived })} style={styles.rowMenuItem}><MaterialIcons name="archive" size={15} color={colors.foreground}/><Text style={[styles.rowMenuText, { color: colors.foreground }]}>{item.archived ? "Unarchive" : "Archive"}</Text></Pressable></View> : null}</View></Pressable>} />
      <Pressable onPress={discoverContacts} style={({ pressed }) => [styles.fab, { backgroundColor: colors.primary }, pressed && styles.sendPressed]}><MaterialIcons name="person-add-alt-1" size={22} color="#FFFFFF" /></Pressable>
      {showContacts ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>New conversation</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Find people from your contacts</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setShowContacts(false)} /></View><View style={styles.newActions}><Pressable onPress={() => { setShowContacts(false); router.push("/chat/new-group"); }} style={[styles.newActionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}><MaterialIcons name="group-add" size={16} color={colors.primary} /><Text style={[styles.newActionText, { color: colors.foreground }]}>New group</Text></Pressable><Pressable onPress={() => { setShowContacts(false); router.push("/chat/broadcasts"); }} style={[styles.newActionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}><MaterialIcons name="campaign" size={16} color={colors.primary} /><Text style={[styles.newActionText, { color: colors.foreground }]}>Broadcast</Text></Pressable><Pressable onPress={() => { setShowContacts(false); router.push("/communities"); }} style={[styles.newActionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}><MaterialIcons name="diversity-3" size={16} color={colors.primary} /><Text style={[styles.newActionText, { color: colors.foreground }]}>Community</Text></Pressable><Pressable onPress={openSelfChat} style={[styles.newActionPill, { borderColor: colors.border, backgroundColor: colors.surface }]}><MaterialIcons name="bookmark-border" size={16} color={colors.primary} /><Text style={[styles.newActionText, { color: colors.foreground }]}>Message yourself</Text></Pressable></View><View style={[styles.searchWrap, styles.contactSearch, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="search" size={20} color={colors.muted}/><TextInput value={contactQuery} onChangeText={setContactQuery} placeholder="Search by name, phone or username" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]}/></View><FlatList data={discoveredPeople} keyExtractor={(item) => item.id.toString()} contentContainerStyle={styles.contactList} ListEmptyComponent={<Text style={[styles.emptyCopy, { color: colors.muted }]}>{contactQuery.trim().length < 2 ? "Search by name, phone or username — at least two characters." : peopleSearch.isFetching ? "Searching…" : `No one found for “${contactQuery.trim()}”.`}</Text>} renderItem={({ item }) => <Pressable onPress={() => { setShowContacts(false); setContactQuery(""); if (!item.userId) { notify(`Invite link ready for ${item.name}`); return; } startDirect.mutate({ userId: item.userId }, { onSuccess: (result) => { void conversationListQuery.refetch(); setSelectedId(result.conversationId); notify(`Chat with ${item.name} started`); }, onError: (error) => notify(error.message) }); }} style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}><View style={[styles.contactAvatar, { backgroundColor: item.color }]}><Text style={styles.avatarText}>{item.initials}</Text></View><View style={styles.contactCopy}><Text style={[styles.chatName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.chatPreview, { color: colors.muted }]}>{item.phone ?? item.email ?? "From your contacts"}</Text></View><MaterialIcons name="chevron-right" size={21} color={colors.muted}/></Pressable>} /></View> : null}
      {forwarding ? <View style={[styles.contactSheet, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={styles.contactHeader}><View><Text style={[styles.contactTitle, { color: colors.foreground }]}>Forward to</Text><Text style={[styles.contactSubtitle, { color: colors.muted }]}>Pick the chat this message should go to</Text></View><IconButton name="close" color={colors.foreground} onPress={() => setForwarding(null)} /></View><FlatList data={conversations} keyExtractor={(item) => item.id} contentContainerStyle={styles.contactList} ListEmptyComponent={<Text style={[styles.emptyCopy, { color: colors.muted }]}>You have no other chats yet.</Text>} renderItem={({ item }) => <Pressable onPress={() => void forwardTo(item.id)} style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}><Avatar item={item} size={42} /><View style={styles.contactCopy}><Text style={[styles.chatName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.chatPreview, { color: colors.muted }]} numberOfLines={1}>{item.preview}</Text></View><MaterialIcons name="chevron-right" size={21} color={colors.muted} /></Pressable>} /></View> : null}
      {toast ? <View style={[styles.toast, { backgroundColor: colors.foreground }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 }, eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 }, heading: { fontSize: 22, lineHeight: 28, fontWeight: "800", letterSpacing: -0.4 }, headerActions: { flexDirection: "row", gap: 4 },   iconButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19 }, dimmed: { opacity: 0.4 }, pressed: { opacity: 0.55 },
  strandedBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  strandedText: { flex: 1, fontSize: 12, lineHeight: 17 }, searchWrap: { height: 48, borderRadius: 14, marginHorizontal: 16, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", borderWidth: 1 }, searchWrapFocused: { shadowColor: "#00A884", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 3 }, searchClear: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" }, searchInput: { flex: 1, marginLeft: 10, fontSize: 15.5, paddingVertical: 0, letterSpacing: 0.1, backgroundColor: "transparent" }, listHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 22, paddingTop: 25, paddingBottom: 8 }, sectionLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2 }, countLabel: { fontSize: 12 }, chatList: { paddingBottom: 100 }, chatRow: { flexDirection: "row", paddingLeft: 16, minHeight: 74 }, rowPressed: { opacity: 0.68 }, avatarWrap: { width: 60, alignItems: "flex-start", paddingTop: 11 }, avatar: { alignItems: "center", justifyContent: "center" }, avatarText: { color: "#FFFFFF", fontWeight: "800", letterSpacing: 0.2 }, onlineDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: "#25D366", borderWidth: 3, position: "absolute", bottom: 0, right: 5 }, chatCopy: { flex: 1, paddingRight: 16, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth }, rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, chatName: { flex: 1, fontSize: 16.5, fontWeight: "600", letterSpacing: -0.1 }, chatTime: { fontSize: 11.5, fontWeight: "500" }, rowBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: 8 }, previewLine: { flex: 1, flexDirection: "row", alignItems: "center" }, pin: { marginRight: 4, transform: [{ rotate: "35deg" }] }, chatPreview: { flex: 1, fontSize: 13.5, lineHeight: 18 }, unread: { minWidth: 21, height: 21, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }, unreadText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" }, fab: { position: "absolute", right: 20, bottom: 20, width: 55, height: 55, borderRadius: 28, alignItems: "center", justifyContent: "center", shadowColor: "#000000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 5 }, toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, alignItems: "center" }, toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" }, menu: { position: "absolute", zIndex: 5, right: 15, top: 70, width: 210, borderRadius: 14, borderWidth: 1, paddingVertical: 6, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }, menuItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12 }, menuText: { fontSize: 13, fontWeight: "600" }, emptyCta: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 14, marginTop: 14 }, emptyCtaText: { fontSize: 14, fontWeight: "800" }, emptyState: { alignItems: "center", paddingTop: 80, paddingHorizontal: 30 }, emptyTitle: { fontSize: 18, fontWeight: "800", marginTop: 12 }, emptyCopy: { fontSize: 13, marginTop: 5, textAlign: "center" }, chatHeader: { height: 60, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth }, backButton: { width: 32, height: 42, justifyContent: "center", alignItems: "center" }, chatTitleBlock: { flex: 1, paddingLeft: 8 }, chatTitle: { fontSize: 16.5, fontWeight: "600" }, chatSubtitle: { fontSize: 11, marginTop: 3, fontWeight: "600" }, messageList: { paddingHorizontal: 12, paddingBottom: 14, flexGrow: 1, justifyContent: "flex-end" }, encryptionNote: { alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "rgba(245, 158, 11, 0.10)", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginBottom: 20 }, encryptionText: { fontSize: 10, fontWeight: "600" }, messageRow: { width: "100%", marginBottom: 5 }, messageRowMine: { alignItems: "flex-end" }, messageRowTheirs: { alignItems: "flex-start" }, bubble: { maxWidth: "82%", paddingHorizontal: 12, paddingTop: 9, paddingBottom: 6, borderRadius: 12 }, bubbleMine: { borderTopRightRadius: 3 }, bubbleTheirs: { borderTopLeftRadius: 3 }, messageText: { fontSize: 14.5, lineHeight: 20 }, messageMeta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 3 }, messageActions: { flexDirection: "row", gap: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 14, borderWidth: 1, marginTop: 4 }, actionText: { fontSize: 11, fontWeight: "800" }, replyBanner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, marginBottom: 6 }, replyText: { flex: 1, fontSize: 12 }, viewOnce: { width: 25, height: 25, borderRadius: 13, alignItems: "center", justifyContent: "center", marginBottom: 10 }, viewOnceText: { fontSize: 13, fontWeight: "900" }, messageTime: { fontSize: 10 }, messageImage: { width: 190, height: 150, borderRadius: 12, marginBottom: 5 }, stickerImage: { width: 128, height: 128, marginBottom: 5 }, newActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 10 }, newActionPill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 7 }, newActionText: { fontSize: 12.5, fontWeight: "700" }, stickerGrid: { padding: 12, gap: 10 }, stickerRow: { gap: 10 }, stickerTile: { width: 68, height: 68, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" }, stickerThumb: { width: 54, height: 54 }, mediaHeld: { width: 190, height: 74, borderRadius: 12, marginBottom: 5, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", gap: 5 }, mediaHeldText: { fontSize: 11.5, fontWeight: "600" },
  messageVideo: { width: 230, height: 152, borderRadius: 12, marginBottom: 5, backgroundColor: "#000" },
  fileTile: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7, minWidth: 200, maxWidth: 262 },
  fileIcon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  fileCopy: { flex: 1 },
  fileName: { fontSize: 14, fontWeight: "600" },
  fileMeta: { fontSize: 11.5, marginTop: 2 },
  overlayVideo: { width: "88%", height: "70%", borderRadius: 14, backgroundColor: "#000" },
  mention: { fontWeight: "800" }, link: { textDecorationLine: "underline" },
  pinBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  pinCopy: { flex: 1 },
  pinSender: { fontSize: 11.5, fontWeight: "800" },
  pinBody: { fontSize: 12, marginTop: 2 },
  pinCount: { fontSize: 11, fontWeight: "700" },
  reportQuote: { borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  reportQuoteText: { fontSize: 13, lineHeight: 19 },
  reportChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  reportChip: { borderWidth: 1, borderRadius: 15, paddingHorizontal: 13, paddingVertical: 7 },
  reportChipText: { fontSize: 12.5, fontWeight: "700", textTransform: "capitalize" },
  reportSendText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  scheduleRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 8 },
  scheduleLabel: { flex: 1, fontSize: 14, fontWeight: "700" },
  scheduleTime: { fontSize: 11 },
  locationNote: { fontSize: 11.5, lineHeight: 17, marginTop: 4 },
  // Covers the thread when a chat is locked. It sits over the messages rather than unmounting them,
  // which is the right weight for what a chat lock is for: stopping somebody who has picked up the
  // phone. It is not a defence against a person with the device and developer tools, and the screen
  // that turns it on says as much.
  chatLock: { ...StyleSheet.absoluteFillObject, zIndex: 5, elevation: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 36, gap: 10 },
  chatLockTitle: { fontSize: 17, fontWeight: "800" },
  chatLockCopy: { fontSize: 12.5, lineHeight: 18, textAlign: "center" },
  chatLockInput: { width: 150, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, marginTop: 6, textAlign: "center", letterSpacing: 4, fontSize: 16 },
  chatLockError: { fontSize: 12, fontWeight: "700" },
  chatLockButton: { borderRadius: 14, paddingHorizontal: 26, paddingVertical: 12, marginTop: 4 },
  chatLockButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  mentionBar: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 14, marginBottom: 8, padding: 8, borderRadius: 12, borderWidth: 1 },
  mentionChip: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5 },
  mentionChipText: { fontSize: 12.5, fontWeight: "700" },
  attachSheet: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 10 },
  attachOption: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, borderWidth: 1 },
  attachLabel: { fontSize: 13, fontWeight: "600" },
  // ---- polls ------------------------------------------------------------------------------
  pollCard: { minWidth: 224 },
  pollQuestion: { fontSize: 14.5, fontWeight: "700", marginBottom: 8 },
  pollOption: { borderWidth: 1, borderRadius: 10, marginBottom: 6, overflow: "hidden" },
  pollBar: { position: "absolute", left: 0, top: 0, bottom: 0, opacity: 0.18 },
  pollOptionRow: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 9, paddingVertical: 8 },
  pollOptionText: { flex: 1, fontSize: 13.5 },
  pollCount: { fontSize: 12, fontWeight: "700" },
  pollFootnote: { fontSize: 11.5, marginTop: 2 },
  pollBuilder: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  pollInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14.5 },
  pollAddOption: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
  pollSend: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, paddingVertical: 13, marginTop: 6 },
  pollSendText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  // ---- contact cards ----------------------------------------------------------------------
  contactInitials: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  contactCard: { flexDirection: "row", alignItems: "center", gap: 9, borderLeftWidth: 3, borderLeftColor: "rgba(0, 168, 132, 0.55)", paddingLeft: 8, paddingVertical: 4, minWidth: 200 },
  contactCardAvatar: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  contactCardInitials: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  contactCardCopy: { flex: 1 },
  contactCardName: { fontSize: 14, fontWeight: "700" },
  contactCardMeta: { fontSize: 12, marginTop: 2 },
  // ---- voice note transport ---------------------------------------------------------------
  voicePlay: { paddingRight: 2 },
  voiceTrack: { flex: 1, paddingVertical: 6 },
  voiceBar: { width: 3, borderRadius: 2 },
  voiceRate: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 2 },
  voiceRateText: { fontSize: 10.5, fontWeight: "800" }, composerArea: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 9, borderTopWidth: StyleSheet.hairlineWidth }, composer: { flex: 1, minHeight: 46, maxHeight: 110, borderRadius: 23, borderWidth: 1, flexDirection: "row", alignItems: "flex-end", paddingLeft: 3, paddingRight: 4 }, composerInput: { flex: 1, fontSize: 15, maxHeight: 94, paddingHorizontal: 7, paddingVertical: 12, backgroundColor: "transparent" }, sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" }, sendPressed: { transform: [{ scale: 0.96 }], opacity: 0.88 }, voiceBubble: { flexDirection: "row", alignItems: "center", gap: 7, minWidth: 170 }, voiceWave: { flexDirection: "row", gap: 3, alignItems: "center" }, voiceLine: { width: 3, height: 18, borderRadius: 2 }, voiceLineShort: { width: 3, height: 10, borderRadius: 2 }, voiceLabel: { flexShrink: 1, fontSize: 12, fontWeight: "700" }, contactSheet: { position: "absolute", zIndex: 10, top: 0, left: 0, right: 0, bottom: 0, paddingTop: 18, borderTopWidth: 1 }, contactHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingBottom: 18 }, contactTitle: { fontSize: 21, fontWeight: "800" }, contactSubtitle: { fontSize: 12, marginTop: 4 }, contactSearch: { marginBottom: 12 }, contactList: { paddingBottom: 30 }, contactRow: { minHeight: 72, flexDirection: "row", alignItems: "center", paddingHorizontal: 20 }, contactAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", marginRight: 12 },   contactCopy: { flex: 1 },
  // ---- message menu + richer bubbles --------------------------------------------------
  quoteBlock: { borderLeftWidth: 3, paddingLeft: 8, marginBottom: 6, borderRadius: 3 },
  quoteName: { fontSize: 11.5, fontWeight: "700" },
  quoteBody: { fontSize: 12.5, marginTop: 2, opacity: 0.9 },
  forwardRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 4 },
  forwardText: { fontSize: 11, fontStyle: "italic" },
  deletedText: { fontSize: 13.5, fontStyle: "italic", opacity: 0.85 },
  onceTile: { width: 190, height: 150, borderRadius: 12, backgroundColor: "#111B21", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 5 },
  onceTileText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700" },
  onceGone: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  onceGoneText: { fontSize: 13, fontStyle: "italic" },
  editedTag: { fontSize: 10, fontStyle: "italic", opacity: 0.75, marginRight: 2 },
  reactionRow: { flexDirection: "row", gap: 4, marginTop: 3, flexWrap: "wrap" },
  reactionChip: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2 },
  reactionEmoji: { fontSize: 14 },
  reactionPicker: { flexDirection: "row", gap: 12, borderRadius: 22, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8, marginTop: 6, alignSelf: "flex-start" },
  actionsScroll: { marginTop: 6, maxWidth: "100%" },
  rowMenu: { position: "absolute", right: 10, top: 42, zIndex: 8, borderRadius: 12, borderWidth: 1, paddingVertical: 4, minWidth: 150, elevation: 8, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  rowMenuItem: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, paddingVertical: 9 },
  rowMenuText: { fontSize: 13, fontWeight: "600" },
  replyBannerCopy: { flex: 1, paddingRight: 8 },
  replySender: { fontSize: 12, fontWeight: "800" },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center" },
  overlayImage: { width: "88%", height: "70%", borderRadius: 14 },
  overlayClose: { marginTop: 22, paddingHorizontal: 22, paddingVertical: 11, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.14)" },
  overlayCloseText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  overlayNote: { color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 10, textAlign: "center", paddingHorizontal: 30 },
  timerSheet: { position: "absolute", zIndex: 12, left: 12, right: 12, top: 62, borderRadius: 14, borderWidth: 1, paddingVertical: 6, elevation: 8, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  timerHeading: { fontSize: 11, fontWeight: "800", letterSpacing: 0.8, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  timerOption: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  timerLabel: { fontSize: 14, fontWeight: "600" },
  timerNote: { fontSize: 11, lineHeight: 15, paddingHorizontal: 14, paddingTop: 4, paddingBottom: 10 },
});
