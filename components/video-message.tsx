import { useVideoPlayer, VideoView } from "expo-video";
import type { StyleProp, ViewStyle } from "react-native";

/**
 * A playable video inside a chat bubble.
 *
 * expo-video rather than a bare DOM `<video>`, because it is already a dependency and gives the
 * same component on web and native - this app runs as a web export inside a WebView, but it is
 * still a React Native tree and a raw element would not survive that.
 *
 * The player is created per message. expo-video only fetches metadata until playback starts, so a
 * conversation full of videos does not pull the files down; what it does cost is one player object
 * per video on screen, which is why the bubble is a component rather than more inline markup.
 */
export function VideoMessage({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  const player = useVideoPlayer(uri, (created) => {
    created.loop = false;
  });

  return (
    <VideoView
      player={player}
      style={style}
      // `contain` so a portrait clip is not cropped inside a landscape bubble.
      contentFit="contain"
      nativeControls
      allowsFullscreen
    />
  );
}
