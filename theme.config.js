/** @type {const} */
const themeColors = {
  // Messenger palette. Every screen reads these through useColors(), so the look is defined once
  // here instead of being repeated as literals across components.
  primary: { light: '#008069', dark: '#00A884' },
  background: { light: '#F0F2F5', dark: '#0B141A' },
  surface: { light: '#FFFFFF', dark: '#1F2C34' },
  foreground: { light: '#111B21', dark: '#E9EDEF' },
  muted: { light: '#667781', dark: '#8696A0' },
  border: { light: '#E9EDEF', dark: '#2A3942' },
  success: { light: '#25D366', dark: '#25D366' },
  warning: { light: '#F59E0B', dark: '#FBBF24' },
  error: { light: '#EA0038', dark: '#F15C6D' },
  // Bubbles are deliberately not `primary`: the accent colour is for actions and small areas,
  // while a message surface is large and needs a calmer tone in both schemes.
  bubbleOutgoing: { light: '#D9FDD3', dark: '#005C4B' },
  bubbleIncoming: { light: '#FFFFFF', dark: '#202C33' },
  bubbleOutgoingText: { light: '#111B21', dark: '#E9EDEF' },
  unreadBadge: { light: '#25D366', dark: '#00A884' },
};

module.exports = { themeColors };
