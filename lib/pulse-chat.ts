export type ConversationSummary = {
  name: string;
  preview: string;
};

export type VarnoxMessage = {
  id: string;
  text: string;
  time: string;
  mine?: boolean;
  read?: boolean;
};

export type PulseMessage = VarnoxMessage;

export function filterConversations<T extends ConversationSummary>(items: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => `${item.name} ${item.preview}`.toLowerCase().includes(normalizedQuery));
}

export function appendMessage(messages: VarnoxMessage[], message: VarnoxMessage): VarnoxMessage[] {
  return [...messages, message];
}
